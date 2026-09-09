'use strict';

const Joi = require('joi');
const { JOB_TYPES } = require('./jobs.validator');
const { EXPERIENCE_LEVEL_KEYS } = require('../utils/experienceLevels.taxonomy');

/**
 * POST /api/v1/seekers/saved-searches
 * All criteria fields are optional (a saved search can be "alert me on
 * every new job"), but at least one of name/keyword/location/job_type/
 * experience_level must be present — an entirely empty saved search
 * isn't useful and is almost certainly a client bug.
 */
const createSavedSearchSchema = Joi.object({
  name: Joi.string().trim().min(1).max(120).optional(),
  keyword: Joi.string().trim().min(1).max(255).optional(),
  location: Joi.string().trim().min(1).max(255).optional(),
  job_type: Joi.string().valid(...JOB_TYPES).optional(),
  experience_level: Joi.string().valid(...EXPERIENCE_LEVEL_KEYS).optional(),
  alerts_enabled: Joi.boolean().default(true),
})
  .or('name', 'keyword', 'location', 'job_type', 'experience_level')
  .messages({
    'object.missing': 'Provide at least one of: name, keyword, location, job_type, experience_level',
  })
  .options({ abortEarly: false, stripUnknown: true });

/**
 * PATCH /api/v1/seekers/saved-searches/:id
 * Partial update — same fields as create, all optional, at least one
 * required. Lets a seeker rename a saved search or flip
 * `alerts_enabled` without resubmitting the whole criteria set.
 */
const updateSavedSearchSchema = Joi.object({
  name: Joi.string().trim().min(1).max(120).allow('').optional(),
  keyword: Joi.string().trim().min(1).max(255).allow('').optional(),
  location: Joi.string().trim().min(1).max(255).allow('').optional(),
  job_type: Joi.string().valid(...JOB_TYPES).allow(null).optional(),
  experience_level: Joi.string().valid(...EXPERIENCE_LEVEL_KEYS).allow(null).optional(),
  alerts_enabled: Joi.boolean().optional(),
})
  .min(1)
  .messages({
    'object.min':
      'Provide at least one of: name, keyword, location, job_type, experience_level, alerts_enabled',
  })
  .options({ abortEarly: false, stripUnknown: true });

/**
 * :id route param, same ObjectId-shape guard as jobIdParamSchema.
 */
const savedSearchIdParamSchema = Joi.object({
  id: Joi.string().hex().length(24).required().messages({
    'string.hex': 'id must be a valid MongoDB ObjectId',
    'string.length': 'id must be a valid MongoDB ObjectId',
  }),
}).options({ abortEarly: false, stripUnknown: true });

module.exports = {
  createSavedSearchSchema,
  updateSavedSearchSchema,
  savedSearchIdParamSchema,
};
