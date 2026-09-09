'use strict';

const multer = require('multer');
const env = require('../config/env');
const AppError = require('../errors/AppError');
const { FILE_RULES, validateFile } = require('../utils/file.util');

/**
 * Buffers uploads in memory (files are small — capped at MAX_UPLOAD_SIZE_MB —
 * and we stream them straight to S3, so there's no need to touch disk).
 */
const storage = multer.memoryStorage();

/**
 * Rejects unknown field names and obviously-wrong extensions/mimetypes
 * up front. The deeper binary-signature check runs afterward in the
 * service layer, once we have the full buffer.
 */
function fileFilter(req, file, cb) {
  const rules = FILE_RULES[file.fieldname];
  if (!rules) {
    return cb(new AppError(`Unexpected upload field "${file.fieldname}". Allowed: cv, photo, logo, businessLicense`, 400));
  }
  if (!rules.mimeTypes.includes(file.mimetype)) {
    return cb(
      new AppError(
        `Invalid ${rules.label} content type "${file.mimetype}". Allowed: ${rules.mimeTypes.join(', ')}`,
        422,
      ),
    );
  }
  return cb(null, true);
}

/**
 * Accepts at most one 'cv' and one 'photo' file per request. At least
 * one of the two must be present — enforced in the controller, since
 * multer has no built-in "at least one of these fields" rule.
 */
const uploadFields = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: env.upload.maxFileSizeBytes,
    files: 2,
  },
}).fields([
  { name: 'cv', maxCount: 1 },
  { name: 'photo', maxCount: 1 },
]);

/**
 * Wraps multer so its errors (file too large, unexpected field, etc.)
 * flow through the same AppError -> errorHandler pipeline as everything
 * else, instead of multer's raw error shape.
 */
function handleUpload(req, res, next) {
  uploadFields(req, res, (err) => {
    if (!err) return next();

    if (err instanceof AppError) return next(err);

    if (err.code === 'LIMIT_FILE_SIZE') {
      return next(
        new AppError(`File too large. Maximum size is ${env.upload.maxFileSizeBytes / (1024 * 1024)}MB.`, 413),
      );
    }
    if (err.code === 'LIMIT_UNEXPECTED_FILE') {
      return next(new AppError('Unexpected file field. Allowed fields: cv, photo', 400));
    }
    return next(new AppError(err.message || 'File upload failed', 400));
  });
}

/**
 * EMP-04: single-file upload for an employer's company logo. Kept as its
 * own multer instance (rather than folding into `uploadFields` above)
 * because it's a completely different route/role (`employer`, not
 * `seeker`) with a single expected field — reusing `.fields([...])` there
 * would let a seeker-shaped request also smuggle a `logo` field through
 * routes that never asked for one.
 */
const uploadLogoField = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: env.upload.maxFileSizeBytes,
    files: 1,
  },
}).single('logo');

/**
 * Same error-normalizing wrapper as `handleUpload`, for the single-field
 * logo upload.
 */
function handleLogoUpload(req, res, next) {
  uploadLogoField(req, res, (err) => {
    if (!err) return next();

    if (err instanceof AppError) return next(err);

    if (err.code === 'LIMIT_FILE_SIZE') {
      return next(
        new AppError(`File too large. Maximum size is ${env.upload.maxFileSizeBytes / (1024 * 1024)}MB.`, 413),
      );
    }
    if (err.code === 'LIMIT_UNEXPECTED_FILE') {
      return next(new AppError('Unexpected file field. Allowed field: logo', 400));
    }
    return next(new AppError(err.message || 'File upload failed', 400));
  });
}

/**
 * Runs the magic-byte validation on the uploaded logo and requires that
 * a file was actually attached (multer's `.single()` makes the field
 * optional on its own — there's no built-in "required" option).
 */
function validateUploadedLogo(req, res, next) {
  try {
    if (!req.file) {
      throw new AppError('A logo file is required.', 422);
    }
    validateFile('logo', req.file);
    return next();
  } catch (err) {
    return next(err);
  }
}

/**
 * Runs the deeper (magic-byte) validation on every file multer accepted.
 * Must run after handleUpload.
 */
function validateUploadedFiles(req, res, next) {
  try {
    const files = req.files || {};
    Object.entries(files).forEach(([field, fileArray]) => {
      fileArray.forEach((file) => validateFile(field, file));
    });

    if (!files.cv && !files.photo) {
      throw new AppError('At least one file (cv or photo) must be provided.', 422);
    }

    return next();
  } catch (err) {
    return next(err);
  }
}

/**
 * Same magic-byte validation as `validateUploadedFiles`, but for
 * endpoints where attaching a file is optional (e.g. agency walk-in
 * registration — a desk worker may register a candidate now and attach
 * their CV/photo later via the normal seeker upload endpoint). Runs the
 * signature check on whichever files ARE present; does not require at
 * least one.
 */
function validateOptionalUploadedFiles(req, res, next) {
  try {
    const files = req.files || {};
    Object.entries(files).forEach(([field, fileArray]) => {
      fileArray.forEach((file) => validateFile(field, file));
    });
    return next();
  } catch (err) {
    return next(err);
  }
}

const uploadBusinessLicenseField = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: env.upload.maxFileSizeBytes,
    files: 1,
  },
}).single('businessLicense');

function handleBusinessLicenseUpload(req, res, next) {
  uploadBusinessLicenseField(req, res, (err) => {
    if (!err) return next();
    if (err instanceof AppError) return next(err);
    if (err.code === 'LIMIT_FILE_SIZE') {
      return next(new AppError(`File too large. Maximum size is ${env.upload.maxFileSizeBytes / (1024 * 1024)}MB.`, 413));
    }
    if (err.code === 'LIMIT_UNEXPECTED_FILE') {
      return next(new AppError('Unexpected file field. Allowed field: businessLicense', 400));
    }
    return next(new AppError(err.message || 'File upload failed', 400));
  });
}

function validateUploadedBusinessLicense(req, res, next) {
  try {
    if (!req.file) {
      throw new AppError('A business license file is required.', 422);
    }
    validateFile('businessLicense', req.file);
    return next();
  } catch (err) {
    return next(err);
  }
}

module.exports = {
  handleUpload,
  validateUploadedFiles,
  validateOptionalUploadedFiles,
  handleLogoUpload,
  validateUploadedLogo,
  handleBusinessLicenseUpload,
  validateUploadedBusinessLicense,
};
