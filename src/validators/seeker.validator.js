'use strict';

const Joi = require('joi');
const { JOB_CATEGORY_KEYS } = require('../utils/jobCategories.taxonomy');
const { EXPERIENCE_LEVEL_KEYS } = require('../utils/experienceLevels.taxonomy');

/**
 * PATCH /api/v1/seekers/me
 * Both fields optional, but at least one must be present — this is a
 * partial-update endpoint, not a full profile replace.
 */
const updateProfileSchema = Joi.object({
  full_name: Joi.string().trim().min(2).max(255).optional(),
  bio: Joi.string().trim().max(5000).allow('').optional(),
  // CV-02: lets a seeker review/edit the skills+city that cvParser.service.js
  // auto-filled from their uploaded CV (POST /seekers/upload already merges
  // these on upload, but only into empty/absent values — this is how the
  // seeker corrects a bad parse or fills in what auto-fill missed).
  skills: Joi.array().items(Joi.string().trim().min(1).max(100)).max(50).optional(),
  city: Joi.string().trim().max(255).allow('').optional(),
  // Seniority band shown on the employer/agency candidate search filter
  // — see EXPERIENCE_LEVEL_KEYS. `null`/'' clears it back to unset.
  experience_level: Joi.string()
    .valid(...EXPERIENCE_LEVEL_KEYS)
    .allow(null, '')
    .optional(),
})
  .min(1)
  .messages({
    'object.min': 'Provide at least one of: full_name, bio, skills, city, experience_level',
  })
  .options({ abortEarly: false, stripUnknown: true });

/**
 * PATCH /api/v1/seekers/me/availability
 * Strictly a boolean toggle — no partial/implicit values.
 */
const updateAvailabilitySchema = Joi.object({
  availability_status: Joi.boolean().required(),
})
  .options({ abortEarly: false, stripUnknown: true });

/**
 * GET /api/v1/seekers/search (employer/agency only)
 * All filters are optional — an employer can hit this with no query
 * params at all and get every available seeker (paginated).
 *
 * `skills` accepts a comma-separated list (e.g. `?skills=plumbing,welding`)
 * and is normalized into an array for the service layer.
 */
const searchSeekersSchema = Joi.object({
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
  city: Joi.string().trim().min(1).max(255).optional(),
  keyword: Joi.string().trim().min(1).max(255).optional(),
  // Matches a seeker's `preferredCategories` (SEEK-01 onboarding) —
  // same closed enum as that field.
  category: Joi.string()
    .valid(...JOB_CATEGORY_KEYS)
    .optional(),
  experienceLevel: Joi.string()
    .valid(...EXPERIENCE_LEVEL_KEYS)
    .optional(),
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(100).default(20),
})
  .options({ abortEarly: false, stripUnknown: true });

/**
 * PATCH /api/v1/seekers/me/preferences
 * SEEK-01 onboarding screen: at least one category is required (the
 * screen's "Save & Continue" button stays disabled client-side until
 * one is picked, but the API enforces it too rather than trusting the
 * client). `location_opt_in` defaults to false — the "Skip for Now"
 * button on the location banner simply omits it / sends false.
 */
const updatePreferencesSchema = Joi.object({
  categories: Joi.array()
    .items(Joi.string().valid(...JOB_CATEGORY_KEYS))
    .min(1)
    .required()
    .messages({
      'array.min': 'Select at least one job category.',
      'any.required': 'Select at least one job category.',
    }),
  location_opt_in: Joi.boolean().default(false),
})
  .options({ abortEarly: false, stripUnknown: true });

/**
 * CV-03: one work-experience entry in the CV builder. Mirrors
 * `CvExperience.toJson()` on the Flutter side — dates are free-text
 * ("Jan 2022", "2019", "Present" is instead conveyed via `current`).
 */
const cvExperienceItemSchema = Joi.object({
  title: Joi.string().trim().min(1).max(200).required(),
  company: Joi.string().trim().min(1).max(200).required(),
  location: Joi.string().trim().max(200).allow('').optional(),
  start_date: Joi.string().trim().max(50).allow('').optional(),
  end_date: Joi.string().trim().max(50).allow('').optional(),
  current: Joi.boolean().default(false),
  description: Joi.string().trim().max(2000).allow('').optional(),
});

/** CV-03: one education entry. Mirrors `CvEducation.toJson()`. */
const cvEducationItemSchema = Joi.object({
  school: Joi.string().trim().min(1).max(200).required(),
  degree: Joi.string().trim().min(1).max(200).required(),
  field_of_study: Joi.string().trim().max(200).allow('').optional(),
  start_date: Joi.string().trim().max(50).allow('').optional(),
  end_date: Joi.string().trim().max(50).allow('').optional(),
  current: Joi.boolean().default(false),
  // Optional, 0.00–4.00 — left off entirely (not required) since not
  // every seeker's institution grades on a GPA scale. `null`/'' clears
  // a previously-set value back to "not provided".
  gpa: Joi.number().min(0).max(4).precision(2).allow(null, '').optional(),
});

/**
 * CV-03: one language entry. `level` is the human-readable label (not a
 * wire-code) — mirrors `CvLanguageLevel.label` on the Flutter side.
 */
const cvLanguageItemSchema = Joi.object({
  name: Joi.string().trim().min(1).max(100).required(),
  level: Joi.string()
    .valid('Basic', 'Conversational', 'Fluent', 'Native')
    .default('Conversational'),
});

const CV_TEMPLATE_VALUES = ['classic', 'modern', 'minimal'];

/**
 * PATCH /api/v1/seekers/me/cv-builder
 * Saves the wizard's draft data WITHOUT (re)generating the PDF — used
 * for "Save & exit" partway through, so a seeker who backs out keeps
 * their progress. At least one field must be present, same "partial
 * update" contract as updateProfileSchema above.
 */
const cvBuilderDataSchema = Joi.object({
  experience: Joi.array().items(cvExperienceItemSchema).max(20).optional(),
  education: Joi.array().items(cvEducationItemSchema).max(20).optional(),
  languages: Joi.array().items(cvLanguageItemSchema).max(20).optional(),
  template: Joi.string().valid(...CV_TEMPLATE_VALUES).optional(),
})
  .min(1)
  .messages({
    'object.min': 'Provide at least one of: experience, education, languages, template',
  })
  .options({ abortEarly: false, stripUnknown: true });

/**
 * POST /api/v1/seekers/me/cv-builder/generate
 * CV-03: the full payload needed to render a PDF — `template` is
 * required (there's no sensible default to silently render with), the
 * three list fields default to empty so a seeker can generate a CV from
 * whatever they've filled in so far without every section being present.
 */
const generateCvSchema = Joi.object({
  template: Joi.string().valid(...CV_TEMPLATE_VALUES).required(),
  experience: Joi.array().items(cvExperienceItemSchema).max(20).default([]),
  education: Joi.array().items(cvEducationItemSchema).max(20).default([]),
  languages: Joi.array().items(cvLanguageItemSchema).max(20).default([]),
})
  .options({ abortEarly: false, stripUnknown: true });

/**
 * GET /api/v1/seekers/public-search
 * SEEK-xx: guest-facing "browse talent" toggle on the public landing page
 * (public_candidates_board_screen.dart) — lets an anonymous employer/agency
 * preview available seekers before signing up. Same filter shape as the
 * authenticated `/search`, but with no subscription-tier gating (there's
 * no caller to gate) — instead capped by a single fixed, small page size
 * so it works as a taster, not a substitute for signing up.
 */
const publicSearchSeekersSchema = Joi.object({
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
  city: Joi.string().trim().min(1).max(255).optional(),
  keyword: Joi.string().trim().min(1).max(255).optional(),
  category: Joi.string()
    .valid(...JOB_CATEGORY_KEYS)
    .optional(),
  experienceLevel: Joi.string()
    .valid(...EXPERIENCE_LEVEL_KEYS)
    .optional(),
  page: Joi.number().integer().min(1).default(1),
})
  .options({ abortEarly: false, stripUnknown: true });

module.exports = {
  updateProfileSchema,
  updateAvailabilitySchema,
  searchSeekersSchema,
  publicSearchSeekersSchema,
  updatePreferencesSchema,
  cvBuilderDataSchema,
  generateCvSchema,
};
