'use strict';

const Joi = require('joi');

/**
 * :agencyId route param. Despite the name, this is the agency's *User*
 * id (see AgencyComment.model.js's comment on `agencyId`), so it's the
 * same 24-char hex ObjectId shape as any other Mongo id param.
 */
const agencyIdParamSchema = Joi.object({
  agencyId: Joi.string().hex().length(24).required().messages({
    'string.hex': 'agencyId must be a valid MongoDB ObjectId',
    'string.length': 'agencyId must be a valid MongoDB ObjectId',
  }),
}).options({ abortEarly: false, stripUnknown: true });

const agencyCommentIdParamSchema = Joi.object({
  agencyId: Joi.string().hex().length(24).required().messages({
    'string.hex': 'agencyId must be a valid MongoDB ObjectId',
    'string.length': 'agencyId must be a valid MongoDB ObjectId',
  }),
  commentId: Joi.string().hex().length(24).required().messages({
    'string.hex': 'commentId must be a valid MongoDB ObjectId',
    'string.length': 'commentId must be a valid MongoDB ObjectId',
  }),
}).options({ abortEarly: false, stripUnknown: true });

/**
 * POST /api/v1/agencies/:agencyId/comments
 */
const createAgencyCommentSchema = Joi.object({
  body: Joi.string().trim().min(1).max(1000).required(),
  rating: Joi.number().integer().min(1).max(5).optional(),
}).options({ abortEarly: false, stripUnknown: true });

/**
 * GET /api/v1/agencies/:agencyId/comments
 */
const listAgencyCommentsQuerySchema = Joi.object({
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(50).default(20),
}).options({ abortEarly: false, stripUnknown: true });

/**
 * GET /api/v1/agencies/:agencyId/jobs
 * Same page/limit shape as listAgencyCommentsQuerySchema above, kept
 * as its own schema (rather than reused) so the two lists' page sizes
 * can be tuned independently later without coupling them.
 */
const listAgencyJobsQuerySchema = Joi.object({
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(50).default(20),
}).options({ abortEarly: false, stripUnknown: true });

module.exports = {
  agencyIdParamSchema,
  agencyCommentIdParamSchema,
  createAgencyCommentSchema,
  listAgencyCommentsQuerySchema,
  listAgencyJobsQuerySchema,
};
