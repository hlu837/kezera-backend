'use strict';

const path = require('path');
const crypto = require('crypto');
const AppError = require('../errors/AppError');

/**
 * Allowed MIME types per upload field, plus the "magic bytes" each file
 * type actually starts with. We check both the browser-reported
 * mimetype/extension AND the real file signature, since the reported
 * mimetype is trivially spoofable by the client.
 */
const FILE_RULES = {
  cv: {
    mimeTypes: [
      'application/pdf',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document', // .docx
    ],
    extensions: ['.pdf', '.docx'],
    label: 'CV',
  },
  photo: {
    mimeTypes: ['image/jpeg', 'image/png', 'image/webp'],
    extensions: ['.jpg', '.jpeg', '.png', '.webp'],
    label: 'photo',
  },
  // EMP-04: employer company logo. Same allowed types as a seeker photo —
  // raster only, no SVG (SVG can embed scripts/external refs, and we don't
  // sanitize it), checked against the same magic-byte signatures below.
  logo: {
    mimeTypes: ['image/jpeg', 'image/png', 'image/webp'],
    extensions: ['.jpg', '.jpeg', '.png', '.webp'],
    label: 'logo',
  },
  businessLicense: {
    mimeTypes: [
      'application/pdf',
      'image/jpeg',
      'image/png',
      'image/webp'
    ],
    extensions: ['.pdf', '.jpg', '.jpeg', '.png', '.webp'],
    label: 'business license',
  },
};

/**
 * Known binary signatures (first bytes) for the file types we accept.
 * DOCX files are ZIP containers, so they share the ZIP signature ('PK').
 */
const SIGNATURES = [
  { mime: 'application/pdf', bytes: [0x25, 0x50, 0x44, 0x46] }, // %PDF
  {
    mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    bytes: [0x50, 0x4b, 0x03, 0x04], // PK.. (zip)
  },
  { mime: 'image/jpeg', bytes: [0xff, 0xd8, 0xff] },
  { mime: 'image/png', bytes: [0x89, 0x50, 0x4e, 0x47] },
  { mime: 'image/webp', bytes: [0x52, 0x49, 0x46, 0x46] }, // 'RIFF' (WEBP checked further below)
];

function matchesSignature(buffer, expectedMime) {
  const sig = SIGNATURES.find((s) => s.mime === expectedMime);
  if (!sig) return false;

  const header = buffer.subarray(0, sig.bytes.length);
  const headerMatches = sig.bytes.every((byte, i) => header[i] === byte);
  if (!headerMatches) return false;

  // WEBP is RIFF + 'WEBP' at offset 8, so disambiguate from other RIFF formats.
  if (expectedMime === 'image/webp') {
    return buffer.subarray(8, 12).toString('ascii') === 'WEBP';
  }
  return true;
}

/**
 * Strips directory components and unsafe characters from a client-supplied
 * filename, and prefixes it with a random token so concurrent uploads
 * (or two files with the same name) never collide in storage.
 *
 * @param {string} originalName
 * @returns {{ safeName: string, ext: string }}
 */
function sanitizeFilename(originalName) {
  const base = path.basename(originalName || 'file');
  const ext = path.extname(base).toLowerCase();
  const nameOnly = base
    .slice(0, base.length - ext.length)
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60) || 'file';

  const uniquePrefix = crypto.randomBytes(8).toString('hex');
  return { safeName: `${uniquePrefix}-${nameOnly}${ext}`, ext };
}

/**
 * Validates a single uploaded file against the rules for its field
 * ('cv' or 'photo'): allowed extension, allowed reported mimetype, and
 * a real binary signature check to guard against spoofed content-types.
 * Throws AppError(422) on any mismatch.
 *
 * @param {'cv'|'photo'} field
 * @param {Express.Multer.File} file
 */
function validateFile(field, file) {
  const rules = FILE_RULES[field];
  if (!rules) {
    throw new AppError(`Unsupported upload field: ${field}`, 400);
  }

  const ext = path.extname(file.originalname || '').toLowerCase();

  if (!rules.extensions.includes(ext)) {
    throw new AppError(
      `Invalid ${rules.label} file extension "${ext || '(none)'}". Allowed: ${rules.extensions.join(', ')}`,
      422,
    );
  }

  if (!rules.mimeTypes.includes(file.mimetype)) {
    throw new AppError(
      `Invalid ${rules.label} content type "${file.mimetype}". Allowed: ${rules.mimeTypes.join(', ')}`,
      422,
    );
  }

  const signatureOk = rules.mimeTypes.some((mime) => matchesSignature(file.buffer, mime));
  if (!signatureOk) {
    throw new AppError(
      `The uploaded ${rules.label} file's content does not match its declared type (failed signature check).`,
      422,
    );
  }
}

module.exports = { FILE_RULES, sanitizeFilename, validateFile };
