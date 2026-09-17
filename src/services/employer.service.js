'use strict';

const { Employer } = require('../models');
const AppError = require('../errors/AppError');
const { sanitizeFilename } = require('../utils/file.util');
const storageService = require('./storage.service');

// Wire format (request body / Joi-validated) -> schema field name.
// logo_url is deliberately absent — it's no longer settable as a plain
// JSON field (see employer.validator.js). It's derived server-side by
// uploadLogo() below, from an actual uploaded image file.
const UPDATABLE_FIELD_MAP = {
  company_name: 'companyName',
  backoffice_phone: 'backofficePhone',
  promo_details: 'promoDetails',
};

/**
 * GET /api/v1/employers/me
 * Mirrors seeker.service.js#getMyProfile.
 *
 * @param {string} userId - from req.user.id (JWT sub)
 */
async function getMyProfile(userId) {
  const profile = await Employer.findOne({ userId });
  if (!profile) {
    throw new AppError('Employer profile not found', 404);
  }
  return profile.toJSON();
}

/**
 * POST /api/v1/employers/profile
 * Partial update — only fields present in `updates` are touched.
 * `Employer.userId` is unique per user (one profile doc per employer
 * account), matching the seeker profile pattern.
 *
 * @param {string} userId - from req.user.id (JWT sub)
 * @param {{ company_name?: string, logo_url?: string, backoffice_phone?: string, promo_details?: string }} updates - already Joi-validated
 */
async function updateMyProfile(userId, updates) {
  const fields = Object.keys(updates);
  if (fields.length === 0) {
    throw new AppError('No updatable fields provided', 422);
  }

  const setDoc = {};
  for (const field of fields) {
    setDoc[UPDATABLE_FIELD_MAP[field] || field] = updates[field];
  }

  const profile = await Employer.findOneAndUpdate(
    { userId },
    { $set: setDoc },
    { new: true, runValidators: true },
  );

  if (!profile) {
    throw new AppError('Employer profile not found', 404);
  }
  return profile.toJSON();
}

/**
 * POST /api/v1/employers/logo
 * EMP-04: stores the uploaded logo file in S3 and points the employer's
 * `logoUrl` at it. `file` has already passed multer's field/mimetype
 * check and the magic-byte signature check (upload.middleware.js) by the
 * time it reaches here.
 *
 * @param {string} userId - from req.user.id (JWT sub)
 * @param {Express.Multer.File} file
 */
async function uploadLogo(userId, file) {
  const { safeName } = sanitizeFilename(file.originalname);
  const key = `employers/${userId}/logo/${safeName}`;
  const url = await storageService.uploadBuffer(file.buffer, key, file.mimetype);

  const profile = await Employer.findOneAndUpdate(
    { userId },
    { $set: { logoUrl: url } },
    { new: true, runValidators: true },
  );

  if (!profile) {
    throw new AppError('Employer profile not found', 404);
  }
  return profile.toJSON();
}

module.exports = { getMyProfile, updateMyProfile, uploadLogo };
