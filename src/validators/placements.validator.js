'use strict';

const Joi = require('joi');
const { INTERVIEW_MODES } = require('../models/Interview.model');

/** Shared MongoDB ObjectId shape check — same convention as jobs.validator.js#jobIdParamSchema. */
const objectId = () => Joi.string().hex().length(24).messages({
  'string.hex': 'must be a valid MongoDB ObjectId',
  'string.length': 'must be a valid MongoDB ObjectId',
});

/** :placementId route param, used by every /placements/:placementId/... route below. */
const placementIdParamSchema = Joi.object({
  placementId: objectId().required(),
}).options({ abortEarly: false, stripUnknown: true });

/** :id route param for the interview-id-keyed mutation endpoints. */
const interviewIdParamSchema = Joi.object({
  id: objectId().required(),
}).options({ abortEarly: false, stripUnknown: true });

/**
 * POST /api/v1/placements/:placementId/interviews
 * `scheduled_for` must be in the future — scheduling an interview in
 * the past isn't a meaningful action.
 */
const scheduleInterviewSchema = Joi.object({
  scheduled_for: Joi.date().iso().greater('now').required().messages({
    'date.greater': 'scheduled_for must be a future date/time',
  }),
  mode: Joi.string().valid(...INTERVIEW_MODES).required(),
  location: Joi.string().trim().max(500).allow('').optional(),
  notes: Joi.string().trim().max(2000).allow('').optional(),
}).options({ abortEarly: false, stripUnknown: true });

/**
 * PATCH /api/v1/interviews/:id
 * Partial update — at least one field must be present. `scheduled_for`,
 * if provided, must still be in the future.
 */
const rescheduleInterviewSchema = Joi.object({
  scheduled_for: Joi.date().iso().greater('now').optional().messages({
    'date.greater': 'scheduled_for must be a future date/time',
  }),
  mode: Joi.string().valid(...INTERVIEW_MODES).optional(),
  location: Joi.string().trim().max(500).allow('').optional(),
  notes: Joi.string().trim().max(2000).allow('').optional(),
})
  .min(1)
  .messages({ 'object.min': 'Provide at least one of: scheduled_for, mode, location, notes' })
  .options({ abortEarly: false, stripUnknown: true });

/** PATCH /api/v1/interviews/:id/status */
const updateInterviewStatusSchema = Joi.object({
  status: Joi.string().valid('completed', 'cancelled').required(),
}).options({ abortEarly: false, stripUnknown: true });

/** POST /api/v1/placements/:placementId/messages */
const sendMessageSchema = Joi.object({
  body: Joi.string().trim().min(1).max(5000).required(),
}).options({ abortEarly: false, stripUnknown: true });

module.exports = {
  placementIdParamSchema,
  interviewIdParamSchema,
  scheduleInterviewSchema,
  rescheduleInterviewSchema,
  updateInterviewStatusSchema,
  sendMessageSchema,
};
