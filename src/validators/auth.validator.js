'use strict';

const Joi = require('joi');

// E.164-ish phone: leading optional +, 7-15 digits. Adjust to your target markets.
const phoneSchema = Joi.string()
  .trim()
  .pattern(/^\+?[0-9]{7,15}$/)
  .required()
  .messages({
    'string.pattern.base': 'phone must be a valid phone number (7-15 digits, optional leading +)',
  });

const passwordSchema = Joi.string()
  .min(8)
  .max(128)
  .required()
  .messages({
    'string.min': 'password must be at least 8 characters long',
  });

/**
 * Registration payload varies by role:
 *  - seeker:   requires full_name
 *  - employer: requires company_name
 *  - agency:   requires agency_name
 *
 * We validate the shared fields plus role via a base schema, then
 * apply a per-role conditional schema for the profile-specific fields.
 */
const registerSchema = Joi.object({
  role: Joi.string().valid('seeker', 'employer', 'agency').required(),
  phone: phoneSchema,
  email: Joi.string().trim().email().required().messages({
    'string.empty': 'email address is required',
    'string.email': 'email must be a valid email address',
  }),
  password: passwordSchema,

  // Seeker fields
  full_name: Joi.string().trim().min(2).max(255)
    .when('role', { is: 'seeker', then: Joi.required(), otherwise: Joi.forbidden() }),
  cv_url: Joi.string().uri().optional()
    .when('role', { is: 'seeker', then: Joi.optional(), otherwise: Joi.forbidden() }),
  photo_url: Joi.string().uri().optional()
    .when('role', { is: 'seeker', then: Joi.optional(), otherwise: Joi.forbidden() }),

  // Employer fields
  company_name: Joi.string().trim().min(2).max(255)
    .when('role', { is: 'employer', then: Joi.required(), otherwise: Joi.forbidden() }),
  // EMP-04: logo can no longer be set as an arbitrary URL string at
  // registration either — same reasoning as employer.validator.js. An
  // employer uploads their logo after registering, via
  // POST /api/v1/employers/logo.
  logo_url: Joi.any().forbidden().messages({
    'any.unknown': 'logo_url can no longer be set directly. Upload the logo via POST /api/v1/employers/logo after registering',
  }),
  backoffice_phone: Joi.string().trim().pattern(/^\+?[0-9]{7,15}$/).optional()
    .when('role', { is: 'employer', then: Joi.optional(), otherwise: Joi.forbidden() }),
  promo_details: Joi.string().trim().max(2000).optional()
    .when('role', { is: 'employer', then: Joi.optional(), otherwise: Joi.forbidden() }),

  // Agency fields
  agency_name: Joi.string().trim().min(2).max(255)
    .when('role', { is: 'agency', then: Joi.required(), otherwise: Joi.forbidden() }),
  operational_city: Joi.string().trim().max(100).optional()
    .when('role', { is: 'agency', then: Joi.optional(), otherwise: Joi.forbidden() }),

  // Common verification fields for Employer & Agency
  tin_number: Joi.string().trim().min(5).max(50)
    .when('role', { is: Joi.valid('employer', 'agency'), then: Joi.required(), otherwise: Joi.forbidden() }),
  subscription_tier: Joi.string().valid('basic', 'premium', 'enterprise')
    .when('role', { is: Joi.valid('employer', 'agency'), then: Joi.required(), otherwise: Joi.forbidden() }),
})
  .options({ abortEarly: false, stripUnknown: true });

/**
 * Login accepts either phone or email as the identifier — at least one
 * of the two must be present.
 */
const loginSchema = Joi.object({
  phone: Joi.string().trim().optional(),
  email: Joi.string().trim().email().optional(),
  password: Joi.string().required(),
})
  .or('phone', 'email')
  .messages({
    'object.missing': 'either phone or email is required',
  })
  .options({ abortEarly: false, stripUnknown: true });

module.exports = { registerSchema, loginSchema };
