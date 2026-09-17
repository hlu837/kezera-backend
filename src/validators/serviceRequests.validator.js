'use strict';

const Joi = require('joi');
const { EXPERT_TRADE_CATEGORY_KEYS } = require('../utils/expertTradeCategories.taxonomy');

/** Shared MongoDB ObjectId shape check — same convention as placements.validator.js#objectId. */
const objectId = () => Joi.string().hex().length(24).messages({
  'string.hex': 'must be a valid MongoDB ObjectId',
  'string.length': 'must be a valid MongoDB ObjectId',
});

/** :id route param for every /service-requests/:id/... route. */
const serviceRequestIdParamSchema = Joi.object({
  id: objectId().required(),
}).options({ abortEarly: false, stripUnknown: true });

/**
 * POST /api/v1/service-requests — "Request Service" from the Experts,
 * Technicians, or Agencies map/directory. Exactly one of
 * `targetSeekerId`/`targetTechnicianId`/`targetAgencyId` is required,
 * matching `targetType`; the service layer never trusts `targetType`
 * alone without also checking the matching id was actually provided
 * (Joi's `.when()` below already guards this at the door, but a second
 * body check in serviceRequests.service.js#createServiceRequest is what
 * actually looks the target up).
 */
const createServiceRequestSchema = Joi.object({
  targetType: Joi.string().valid('seeker', 'technician', 'agency').required(),
  targetSeekerId: Joi.when('targetType', {
    is: 'seeker',
    then: objectId().required(),
    otherwise: Joi.forbidden(),
  }),
  targetTechnicianId: Joi.when('targetType', {
    is: 'technician',
    then: objectId().required(),
    otherwise: Joi.forbidden(),
  }),
  targetAgencyId: Joi.when('targetType', {
    is: 'agency',
    then: objectId().required(),
    otherwise: Joi.forbidden(),
  }),
  category: Joi.string().valid(...EXPERT_TRADE_CATEGORY_KEYS).required(),
  title: Joi.string().trim().min(3).max(150).required(),
  description: Joi.string().trim().min(10).max(2000).required(),
  location: Joi.string().trim().min(3).max(255).required(),
  preferredDate: Joi.date().iso().greater('now').optional().allow(null),
  budget: Joi.string().trim().max(100).allow('', null).optional(),
}).options({ abortEarly: false, stripUnknown: true });

/**
 * POST /api/v1/service-requests/:id/assign — an agency picking one of
 * its own roster seekers (`GET /agencies/candidates`) to handle a
 * request routed to it. Only valid while the request is still
 * unassigned (service-layer transition check, not here).
 */
const assignExpertSchema = Joi.object({
  seekerId: objectId().required(),
}).options({ abortEarly: false, stripUnknown: true });

/**
 * POST /api/v1/service-requests/:id/respond — the currently-assigned
 * Expert accepting or declining. Declining an agency-routed request
 * reopens it for reassignment rather than closing it outright (see
 * serviceRequests.service.js#respondToRequest); declining a direct
 * request is terminal.
 */
const respondToServiceRequestSchema = Joi.object({
  action: Joi.string().valid('accept', 'decline').required(),
}).options({ abortEarly: false, stripUnknown: true });

/** PATCH /api/v1/service-requests/:id/status */
const updateServiceRequestStatusSchema = Joi.object({
  status: Joi.string().valid('completed', 'cancelled').required(),
}).options({ abortEarly: false, stripUnknown: true });

/**
 * GET /api/v1/service-requests/mine and .../incoming — shared query
 * shape, same pagination convention as jobs.validator.js's job listing
 * schema. `status` is optional so both screens can default to "show
 * everything" and let the Flutter tabs filter client-side, or pass it
 * through for a server-side filtered tab.
 */
const listServiceRequestsQuerySchema = Joi.object({
  status: Joi.string().valid(
    'pending',
    'assigned',
    'accepted',
    'declined',
    'completed',
    'cancelled',
  ).optional(),
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(100).default(20),
}).options({ abortEarly: false, stripUnknown: true });

module.exports = {
  serviceRequestIdParamSchema,
  createServiceRequestSchema,
  assignExpertSchema,
  respondToServiceRequestSchema,
  updateServiceRequestStatusSchema,
  listServiceRequestsQuerySchema,
};
