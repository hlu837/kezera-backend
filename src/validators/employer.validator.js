'use strict';

const Joi = require('joi');

/**
 * POST /api/v1/employers/profile
 * Partial update — at least one field must be present. Mirrors the
 * seeker profile validator's shape/conventions.
 */
const updateProfileSchema = Joi.object({
  company_name: Joi.string().trim().min(2).max(255).optional(),
  // EMP-04: logo_url is no longer client-settable as an arbitrary string
  // here — accepting any URI let a caller point their "logo" at anything
  // (including internal/non-http URLs), and there was never an actual
  // upload path behind it. The logo is now set by uploading a real image
  // file to POST /api/v1/employers/logo, which derives the URL itself
  // after storing the file. `.forbidden()` (rather than just omitting the
  // key) makes stripUnknown not silently swallow old clients still
  // sending logo_url — they get a clear error pointing at the new route.
  logo_url: Joi.any().forbidden().messages({
    'any.unknown': 'logo_url can no longer be set directly. Upload the logo via POST /api/v1/employers/logo',
  }),
  backoffice_phone: Joi.string()
    .trim()
    .pattern(/^\+?[0-9\s-]{7,20}$/)
    .optional()
    .messages({
      'string.pattern.base': 'backoffice_phone must be a valid phone number',
    }),
  promo_details: Joi.string().trim().max(5000).allow('').optional(),
})
  .min(1)
  .messages({
    'object.min': 'Provide at least one of: company_name, backoffice_phone, promo_details',
  })
  .options({ abortEarly: false, stripUnknown: true });

module.exports = { updateProfileSchema };
