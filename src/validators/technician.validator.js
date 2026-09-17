'use strict';

const Joi = require('joi');
const { EXPERT_TRADE_CATEGORY_KEYS } = require('../utils/expertTradeCategories.taxonomy');
const { RATE_UNITS } = require('../models/Technician.model');

/**
 * PATCH /api/v1/technicians/me
 * Registration + edits both go through this one schema — the "lightweight
 * profile" the feature plan calls for, deliberately much shorter than
 * updateProfileSchema (seeker.validator.js): no CV, no experience/education,
 * just enough to be found and contacted for a trade job.
 *
 * `trade_category` is required here (unlike Seeker's, which is optional
 * and un-lists you when cleared) — a Technician profile with no trade
 * has no directory category to appear under, so there's nothing sensible
 * for it to default to.
 */
const updateProfileSchema = Joi.object({
  full_name: Joi.string().trim().min(2).max(255).required(),
  trade_category: Joi.string()
    .valid(...EXPERT_TRADE_CATEGORY_KEYS)
    .required(),
  skills: Joi.array().items(Joi.string().trim().min(1).max(100)).max(50).optional(),
  bio: Joi.string().trim().max(2000).allow('').optional(),
  city: Joi.string().trim().max(255).allow('').optional(),
  rate_amount: Joi.number().min(0).allow(null).optional(),
  // Required alongside rate_amount (and only then) — a bare number with
  // no unit isn't a usable rate for a nearby searcher to compare against.
  rate_unit: Joi.string()
    .valid(...RATE_UNITS)
    .when('rate_amount', {
      // `.required()` here means "must be present AND a number" — so
      // this only fires when rate_amount is an actual number, not when
      // it's absent (optional keys pass Joi's plain `.number()` check
      // on `undefined`) or explicitly cleared to null.
      is: Joi.number().required(),
      then: Joi.required(),
      otherwise: Joi.optional().allow(null),
    }),
})
  .options({ abortEarly: false, stripUnknown: true });

/**
 * PATCH /api/v1/technicians/me/availability
 * Same "step away without deleting the profile" toggle as
 * updateAvailabilitySchema (seeker.validator.js).
 */
const updateAvailabilitySchema = Joi.object({
  availability_status: Joi.boolean().required(),
})
  .options({ abortEarly: false, stripUnknown: true });

/**
 * PATCH /api/v1/technicians/me/location
 * Both coordinates required together, same reasoning as
 * updateLocationSchema (seeker.validator.js) — a lat without a lng isn't
 * a usable point.
 */
const updateLocationSchema = Joi.object({
  latitude: Joi.number().min(-90).max(90).required(),
  longitude: Joi.number().min(-180).max(180).required(),
})
  .options({ abortEarly: false, stripUnknown: true });

/**
 * GET /api/v1/technicians/nearby
 * "Find a technician near you" map/list — no auth, guest-facing. Mirrors
 * nearbySeekersSchema's shape, minus the broad `category` filter (there's
 * no Seeker.preferredCategories equivalent here: `trade` alone is the
 * only category axis a Technician profile has).
 */
const nearbyTechniciansSchema = Joi.object({
  latitude: Joi.number().min(-90).max(90).required(),
  longitude: Joi.number().min(-180).max(180).required(),
  radius_km: Joi.number().positive().max(200).default(15),
  skills: Joi.string()
    .trim()
    .max(500)
    .optional()
    .custom((value, helpers) => {
      const skills = value
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      if (skills.length === 0) {
        return helpers.error('any.invalid');
      }
      return skills;
    })
    .messages({ 'any.invalid': 'skills must contain at least one non-empty value' }),
  trade: Joi.string()
    .valid(...EXPERT_TRADE_CATEGORY_KEYS)
    .optional(),
  limit: Joi.number().integer().positive().max(100).default(50),
})
  .options({ abortEarly: false, stripUnknown: true });

module.exports = {
  updateProfileSchema,
  updateAvailabilitySchema,
  updateLocationSchema,
  nearbyTechniciansSchema,
};
