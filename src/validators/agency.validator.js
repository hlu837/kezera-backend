'use strict';

const Joi = require('joi');
const { JOB_CATEGORY_KEYS } = require('../utils/jobCategories.taxonomy');
const { EXPERIENCE_LEVEL_KEYS } = require('../utils/experienceLevels.taxonomy');

/**
 * POST /api/v1/agencies/profile
 * Agency account screen's "Edit profile" — partial update, at least one
 * field must be present. Mirrors employer.validator.js's
 * updateProfileSchema shape/conventions exactly (same phone pattern,
 * same snake_case wire format).
 */
const updateProfileSchema = Joi.object({
  agency_name: Joi.string().trim().min(2).max(255).optional(),
  operational_city: Joi.string().trim().min(1).max(255).allow('').optional(),
  backoffice_phone: Joi.string()
    .trim()
    .pattern(/^\+?[0-9\s-]{7,20}$/)
    .optional()
    .messages({
      'string.pattern.base': 'backoffice_phone must be a valid phone number',
    }),
  // Public-profile bio shown on the agency's job postings. Mirrors
  // employer.validator.js's promo_details (same max length/`.allow('')`
  // shape). Along with the logo (uploaded separately via POST
  // /agencies/logo), this is what satisfies the "complete public
  // profile" gate in requireAgencyPublicProfile.middleware.js.
  bio: Joi.string().trim().max(5000).allow('').optional(),
  // logo_url is never client-settable as a plain string — same reasoning
  // as employer.validator.js's logo_url.forbidden(). The logo is set by
  // uploading a real image file to POST /api/v1/agencies/logo.
  logo_url: Joi.any().forbidden().messages({
    'any.unknown': 'logo_url can no longer be set directly. Upload the logo via POST /api/v1/agencies/logo',
  }),
})
  .min(1)
  .messages({
    'object.min': 'Provide at least one of: agency_name, operational_city, backoffice_phone, bio',
  })
  .options({ abortEarly: false, stripUnknown: true });

/**
 * POST /api/v1/agencies/walk-in
 * Registers a candidate who physically visited the agency's office.
 * The agency desk worker fills this in on the candidate's behalf, so
 * `password` is optional — if omitted, agency.service.js generates a
 * random one (the candidate isn't expected to log in from the desk).
 *
 * Mirrors auth.validator.js's registerSchema field names/conventions
 * (snake_case wire format) so the two "create a seeker" paths stay
 * consistent for API consumers.
 */
const walkInSchema = Joi.object({
  full_name: Joi.string().trim().min(2).max(255).required(),
  phone: Joi.string()
    .trim()
    .pattern(/^\+?[0-9\s-]{7,20}$/)
    .required()
    .messages({
      'string.pattern.base': 'phone must be a valid phone number',
    }),
  email: Joi.string().trim().lowercase().email().optional(),
  // Optional: an agency desk worker registering a walk-in candidate
  // usually has no reason to set one. When omitted, the service layer
  // generates a random password — the candidate doesn't need it to be
  // usable today, only for the account to satisfy the same password
  // requirements as a self-registered one.
  password: Joi.string().min(8).max(128).optional(),
  bio: Joi.string().trim().max(5000).allow('').optional(),
  city: Joi.string().trim().min(1).max(255).optional(),
  // This endpoint is submitted as multipart/form-data (it can carry
  // cv/photo files alongside the profile fields — see agency.routes.js),
  // so every non-file field — including this one — arrives as a plain
  // string, not JSON. Accepts a comma-separated list (e.g.
  // "plumbing,welding"), same convention as
  // seeker.validator.js's searchSeekersSchema `skills` param, and
  // normalizes it into an array for the service layer.
  skills: Joi.string()
    .trim()
    .max(1000)
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
  // Seniority band — same closed enum as seeker.validator.js's
  // updateProfileSchema#experience_level, so a walk-in profile is
  // filterable by GET /seekers/search exactly like a self-registered
  // one. Optional: a desk worker may not always know/ask this.
  experience_level: Joi.string()
    .valid(...EXPERIENCE_LEVEL_KEYS)
    .optional()
    .messages({
      'any.only': `experience_level must be one of: ${EXPERIENCE_LEVEL_KEYS.join(', ')}`,
    }),
  // Job type(s) the candidate is looking for — maps to Seeker's
  // `preferredCategories`. Same wire shape as `skills` above (comma-
  // separated string, since this endpoint is multipart/form-data), but
  // each value is checked against the closed JOB_CATEGORY_KEYS enum
  // rather than accepted as free text.
  preferred_categories: Joi.string()
    .trim()
    .max(500)
    .optional()
    .custom((value, helpers) => {
      const categories = value
        .split(',')
        .map((c) => c.trim())
        .filter(Boolean);
      if (categories.length === 0) {
        return helpers.error('any.invalid');
      }
      const invalid = categories.filter((c) => !JOB_CATEGORY_KEYS.includes(c));
      if (invalid.length > 0) {
        return helpers.error('any.invalidCategory', { invalid: invalid.join(', ') });
      }
      return categories;
    })
    .messages({
      'any.invalid': 'preferred_categories must contain at least one non-empty value',
      'any.invalidCategory': 'preferred_categories contains invalid value(s): {{#invalid}}',
    }),
})
  .options({ abortEarly: false, stripUnknown: true });

/**
 * GET /api/v1/agencies/candidates
 * Pagination + search over the candidates this agency has registered
 * or been assigned. Mirrors seeker.validator.js's searchSeekersSchema
 * shape/conventions; unlike that endpoint, results are NOT restricted
 * to `availabilityStatus: true` by default — an agency needs to see its
 * whole roster, not just who's currently available — but can filter to
 * it explicitly via `availability_status`.
 */
const listCandidatesSchema = Joi.object({
  // Filters the roster to candidates at this seniority band
  // (Seeker.experienceLevel) — replaces the old free-text `skills`
  // filter on the agency's "search your own roster" filter card.
  experience_level: Joi.string()
    .valid(...EXPERIENCE_LEVEL_KEYS)
    .optional()
    .messages({
      'any.only': `experience_level must be one of: ${EXPERIENCE_LEVEL_KEYS.join(', ')}`,
    }),
  city: Joi.string().trim().min(1).max(255).optional(),
  keyword: Joi.string().trim().min(1).max(255).optional(),
  availability_status: Joi.boolean().optional(),
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(100).default(20),
})
  .options({ abortEarly: false, stripUnknown: true });

// Reused by both dispatchSchema (job_id) and the seeker id array below —
// Mongo ObjectIds are 24-char hex strings, same shape check as
// jobs.validator.js's jobIdParamSchema.
const objectIdField = () =>
  Joi.string().hex().length(24).messages({
    'string.hex': 'must be a valid MongoDB ObjectId',
    'string.length': 'must be a valid MongoDB ObjectId',
  });

/**
 * POST /api/v1/agencies/dispatch
 * Sends a shortlist of already-matched candidates to the job's poster:
 * flips each placement 'matched' -> 'sent' and triggers the
 * SMS/email notification fan-out (see agency.service.js#dispatchCandidates).
 */
const dispatchSchema = Joi.object({
  job_id: objectIdField().required(),
  seeker_ids: Joi.array()
    .items(objectIdField())
    .min(1)
    .max(100)
    .unique()
    .required()
    .messages({
      'array.min': 'seeker_ids must contain at least one seeker id',
      'array.unique': 'seeker_ids must not contain duplicates',
    }),
})
  .options({ abortEarly: false, stripUnknown: true });

/**
 * POST /api/v1/agencies/finance/ledger
 * Records one financial event (a walk-in registration fee collected, or
 * a placement commission) and atomically adjusts the agency's
 * `ledgerBalance` (see agency.service.js#recordLedgerEntry).
 * `date` is optional — defaults to now, but a desk worker booking an
 * entry against an earlier point in the day (or backfilling) can set
 * it explicitly.
 */
const ledgerEntrySchema = Joi.object({
  amount: Joi.number().positive().precision(2).required(),
  transaction_type: Joi.string().valid('registration_fee', 'commission').required(),
  description: Joi.string().trim().max(500).allow('').optional(),
  date: Joi.date().iso().max('now').optional(),
})
  .options({ abortEarly: false, stripUnknown: true });

/**
 * GET /api/v1/agencies/dashboard/stats
 * Defaults to "today" (UTC) when `date` is omitted. Accepting an
 * explicit, validated date here — rather than only ever computing
 * "today" server-side — is what the task means by "parameterized date
 * filters": the aggregation's $match range always comes from a
 * validated Date, never string-concatenated into the query.
 */
const dashboardStatsQuerySchema = Joi.object({
  date: Joi.date().iso().max('now').optional(),
})
  .options({ abortEarly: false, stripUnknown: true });

/**
 * :id route param for PATCH /api/v1/agencies/placements/:id/status —
 * same shape check as jobs.validator.js's jobIdParamSchema.
 */
const placementIdParamSchema = Joi.object({
  id: Joi.string().hex().length(24).required().messages({
    'string.hex': 'id must be a valid MongoDB ObjectId',
    'string.length': 'id must be a valid MongoDB ObjectId',
  }),
}).options({ abortEarly: false, stripUnknown: true });

/**
 * PATCH /api/v1/agencies/placements/:id/status
 * Only the three manually-settable statuses are accepted here —
 * 'matched' and 'sent' are always set automatically (by the matching
 * worker and by dispatchCandidates/the inbound-SMS webhook), never by
 * this endpoint. See Placement.model.js#PLACEMENT_STATUS_TRANSITIONS
 * for which of these three is actually reachable from the placement's
 * current status; agency.service.js#updatePlacementStatus enforces it.
 */
const updatePlacementStatusSchema = Joi.object({
  status: Joi.string().valid('interviewed', 'hired', 'rejected').required(),
})
  .options({ abortEarly: false, stripUnknown: true });

module.exports = {
  updateProfileSchema,
  walkInSchema,
  listCandidatesSchema,
  dispatchSchema,
  ledgerEntrySchema,
  dashboardStatsQuerySchema,
  placementIdParamSchema,
  updatePlacementStatusSchema,
};
