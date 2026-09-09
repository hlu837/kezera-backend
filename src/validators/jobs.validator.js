'use strict';

const Joi = require('joi');
const { JOB_CATEGORY_KEYS } = require('../utils/jobCategories.taxonomy');
const { EXPERIENCE_LEVEL_KEYS } = require('../utils/experienceLevels.taxonomy');

// Must stay in sync with the `job_type` / `job_status` enums in
// 003_create_jobs_table.sql.
const JOB_TYPES = ['Full-Time', 'Contract', 'Daily'];
const UPDATABLE_STATUSES = ['open', 'closed'];

// Subset of Application.APPLICATION_STATUSES an employer/agency is
// allowed to move a direct applicant to from the "View candidates"
// screen. 'applied' is deliberately excluded — that's the state an
// application starts in via POST /jobs/:id/apply, not something an
// employer sets.
const APPLICATION_UPDATABLE_STATUSES = ['viewed', 'shortlisted', 'rejected'];

/**
 * POST /api/v1/jobs/create
 * `status` is intentionally NOT accepted here — new postings always
 * default to 'open' at the database level (see jobs.service.js), so a
 * caller can't sneak a job in as pre-closed or as 'draft'.
 */
const createJobSchema = Joi.object({
  title: Joi.string().trim().min(3).max(255).required(),
  description: Joi.string().trim().min(10).max(10000).required(),
  location: Joi.string().trim().min(2).max(255).required(),
  salary_range: Joi.string().trim().max(100).allow('').optional(),
  job_type: Joi.string()
    .valid(...JOB_TYPES)
    .required(),
  // JS-04: optional — an uncategorized job simply won't surface under
  // any category filter on the seeker job board.
  category: Joi.string()
    .valid(...JOB_CATEGORY_KEYS)
    .optional(),
  skills_required: Joi.array()
    .items(Joi.string().trim().min(1).max(100))
    .min(1)
    .max(50)
    .required()
    .messages({
      'array.min': 'skills_required must contain at least one skill',
    }),
  // Seniority band the posting calls for — same closed enum as
  // seeker.validator.js's experience_level, lets the seeker job board
  // filter by it. Optional: a poster may not always want to specify one.
  experience_level: Joi.string()
    .valid(...EXPERIENCE_LEVEL_KEYS)
    .optional()
    .messages({
      'any.only': `experience_level must be one of: ${EXPERIENCE_LEVEL_KEYS.join(', ')}`,
    }),
  // Per-job opt-in for applicationSummary.service.js: whether the poster
  // wants an AI-assisted summary of applicants for this job. Defaults
  // to false at the schema level (Job.model.js) if omitted here.
  application_summary_enabled: Joi.boolean().optional(),
})
  .options({ abortEarly: false, stripUnknown: true });

/**
 * PATCH /api/v1/jobs/:id
 * Partial update — at least one field must be present. `status` is
 * restricted to 'open'/'closed' (no direct transition back to 'draft'
 * or any other value from this endpoint).
 */
const updateJobSchema = Joi.object({
  title: Joi.string().trim().min(3).max(255).optional(),
  description: Joi.string().trim().min(10).max(10000).optional(),
  location: Joi.string().trim().min(2).max(255).optional(),
  salary_range: Joi.string().trim().max(100).allow('').optional(),
  job_type: Joi.string()
    .valid(...JOB_TYPES)
    .optional(),
  category: Joi.string()
    .valid(...JOB_CATEGORY_KEYS)
    .optional(),
  skills_required: Joi.array()
    .items(Joi.string().trim().min(1).max(100))
    .min(1)
    .max(50)
    .optional(),
  experience_level: Joi.string()
    .valid(...EXPERIENCE_LEVEL_KEYS)
    .allow(null, '')
    .optional()
    .messages({
      'any.only': `experience_level must be one of: ${EXPERIENCE_LEVEL_KEYS.join(', ')}`,
    }),
  status: Joi.string()
    .valid(...UPDATABLE_STATUSES)
    .optional(),
  application_summary_enabled: Joi.boolean().optional(),
})
  .min(1)
  .messages({
    'object.min':
      'Provide at least one of: title, description, location, salary_range, job_type, category, skills_required, experience_level, status, application_summary_enabled',
  })
  .options({ abortEarly: false, stripUnknown: true });

/**
 * :id route param — jobs.id is now a MongoDB ObjectId (24-char hex
 * string), not a Postgres UUID. Validating the shape here means an
 * obviously-malformed id 404s via Joi before it ever reaches Mongoose
 * (which would otherwise throw a CastError on a bad findById/findOne).
 */
const jobIdParamSchema = Joi.object({
  id: Joi.string().hex().length(24).required().messages({
    'string.hex': 'id must be a valid MongoDB ObjectId',
    'string.length': 'id must be a valid MongoDB ObjectId',
  }),
}).options({ abortEarly: false, stripUnknown: true });

/**
 * POST /api/v1/jobs/:id/invite-candidate
 * The "Message" button on the employer/agency "Find candidates" search
 * (a plain `GET /seekers/search` browse, not tied to any job) — the
 * employer picks which of their own postings to start the conversation
 * about, and this creates the Placement row that
 * `/placements/:placementId/messages` needs to exist before either side
 * can send anything.
 */
const inviteCandidateSchema = Joi.object({
  seeker_id: Joi.string().hex().length(24).required().messages({
    'string.hex': 'seeker_id must be a valid MongoDB ObjectId',
    'string.length': 'seeker_id must be a valid MongoDB ObjectId',
  }),
}).options({ abortEarly: false, stripUnknown: true });

/**
 * GET /api/v1/jobs (JS-03: seeker job board browse/search/filter)
 * Every filter is optional — a seeker can hit this with no query
 * params at all and get every open job (paginated, newest first).
 * Mirrors the shape of seeker.validator.js#searchSeekersSchema, using
 * the same closed `experience_level` enum as that endpoint's filter.
 */
const browseJobsSchema = Joi.object({
  keyword: Joi.string().trim().min(1).max(255).optional(),
  location: Joi.string().trim().min(1).max(255).optional(),
  job_type: Joi.string().valid(...JOB_TYPES).optional(),
  category: Joi.string().valid(...JOB_CATEGORY_KEYS).optional(),
  // Separates "Company jobs" (posted by an employer) from "Agency jobs"
  // (posted by a staffing/recruiting agency) on the seeker job board.
  // Omitted/absent means "either" — same "any" convention as every
  // other optional filter on this schema.
  creator_type: Joi.string().valid('employer', 'agency').optional(),
  // Filters to jobs posted at this seniority band (Job.experienceLevel)
  // — replaces the old free-text `skills` filter on the "Find a job"
  // filter card.
  experience_level: Joi.string()
    .valid(...EXPERIENCE_LEVEL_KEYS)
    .optional()
    .messages({
      'any.only': `experience_level must be one of: ${EXPERIENCE_LEVEL_KEYS.join(', ')}`,
    }),
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(100).default(20),
})
  .options({ abortEarly: false, stripUnknown: true });

/**
 * :id/:applicationId route params — PATCH
 * /jobs/:id/applications/:applicationId/status. Both are Mongo
 * ObjectIds; validating the shape here means a malformed id 404s via
 * Joi before reaching Mongoose, same reasoning as jobIdParamSchema.
 */
const jobApplicationParamSchema = Joi.object({
  id: Joi.string().hex().length(24).required().messages({
    'string.hex': 'id must be a valid MongoDB ObjectId',
    'string.length': 'id must be a valid MongoDB ObjectId',
  }),
  applicationId: Joi.string().hex().length(24).required().messages({
    'string.hex': 'applicationId must be a valid MongoDB ObjectId',
    'string.length': 'applicationId must be a valid MongoDB ObjectId',
  }),
}).options({ abortEarly: false, stripUnknown: true });

/**
 * PATCH /api/v1/jobs/:id/applications/:applicationId/status
 * Body for the "Shortlist" (and reject/un-shortlist) action on the
 * employer/agency "View candidates" screen.
 */
const updateApplicationStatusSchema = Joi.object({
  status: Joi.string()
    .valid(...APPLICATION_UPDATABLE_STATUSES)
    .required(),
}).options({ abortEarly: false, stripUnknown: true });

module.exports = {
  createJobSchema,
  updateJobSchema,
  jobIdParamSchema,
  inviteCandidateSchema,
  browseJobsSchema,
  jobApplicationParamSchema,
  updateApplicationStatusSchema,
  JOB_TYPES,
  UPDATABLE_STATUSES,
  APPLICATION_UPDATABLE_STATUSES,
};
