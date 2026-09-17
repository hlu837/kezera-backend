'use strict';

const serviceRequestsService = require('../services/serviceRequests.service');

/**
 * POST /api/v1/service-requests
 * Body validated upstream by validateBody(createServiceRequestSchema).
 * Open to any authenticated, approved role — a seeker, employer, or
 * agency can all be the one booking a plumber, same as any of them can
 * browse the guest-facing `/seekers/nearby` and `/agencies/nearby`
 * directories this flow starts from.
 */
async function createServiceRequestHandler(req, res, next) {
  try {
    const serviceRequest = await serviceRequestsService.createServiceRequest(
      req.user.id,
      req.user.role,
      req.body,
    );
    return res.status(201).json({ status: 'success', data: { serviceRequest } });
  } catch (err) {
    return next(err);
  }
}

/**
 * GET /api/v1/service-requests/mine
 * Query validated upstream by validateQuery(listServiceRequestsQuerySchema).
 */
async function listMyRequestsHandler(req, res, next) {
  try {
    const result = await serviceRequestsService.listMyRequests(req.user.id, req.query);
    return res.status(200).json({ status: 'success', data: result });
  } catch (err) {
    return next(err);
  }
}

/**
 * GET /api/v1/service-requests/incoming
 * Query validated upstream by validateQuery(listServiceRequestsQuerySchema).
 * Seeker/agency roles only — enforced inside the service layer, since
 * it also has to decide *which* field to key the inbox query on.
 */
async function listIncomingRequestsHandler(req, res, next) {
  try {
    const result = await serviceRequestsService.listIncomingRequests(
      req.user.id,
      req.user.role,
      req.query,
    );
    return res.status(200).json({ status: 'success', data: result });
  } catch (err) {
    return next(err);
  }
}

/**
 * POST /api/v1/service-requests/:id/assign
 * Params validated upstream by validateParams(serviceRequestIdParamSchema),
 * body by validateBody(assignExpertSchema). Agency-only — enforced by
 * the router-level `authorizeRoles`; ownership (this request was
 * routed to *your* agency) is enforced inside the service.
 */
async function assignExpertHandler(req, res, next) {
  try {
    const serviceRequest = await serviceRequestsService.assignToSeeker(
      req.params.id,
      req.user.id,
      req.body.seekerId,
    );
    return res.status(200).json({ status: 'success', data: { serviceRequest } });
  } catch (err) {
    return next(err);
  }
}

/**
 * POST /api/v1/service-requests/:id/respond
 * Params validated upstream by validateParams(serviceRequestIdParamSchema),
 * body by validateBody(respondToServiceRequestSchema). Seeker-only —
 * enforced by the router-level `authorizeRoles`; that this request is
 * actually currently assigned to *this* seeker is enforced inside the
 * service.
 */
async function respondToRequestHandler(req, res, next) {
  try {
    const serviceRequest = await serviceRequestsService.respondToRequest(
      req.params.id,
      req.user.id,
      req.body.action,
    );
    return res.status(200).json({ status: 'success', data: { serviceRequest } });
  } catch (err) {
    return next(err);
  }
}

/**
 * PATCH /api/v1/service-requests/:id/status
 * Params validated upstream by validateParams(serviceRequestIdParamSchema),
 * body by validateBody(updateServiceRequestStatusSchema). Open to any
 * authenticated role — which specific requests a caller may act on is
 * enforced inside the service (requester, assigned Expert, or target
 * Agency only).
 */
async function updateStatusHandler(req, res, next) {
  try {
    const serviceRequest = await serviceRequestsService.updateRequestStatus(
      req.params.id,
      req.user.id,
      req.body.status,
    );
    return res.status(200).json({ status: 'success', data: { serviceRequest } });
  } catch (err) {
    return next(err);
  }
}

module.exports = {
  createServiceRequestHandler,
  listMyRequestsHandler,
  listIncomingRequestsHandler,
  assignExpertHandler,
  respondToRequestHandler,
  updateStatusHandler,
};
