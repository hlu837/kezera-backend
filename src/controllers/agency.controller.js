'use strict';

const agencyService = require('../services/agency.service');

/**
 * GET /api/v1/agencies/me
 * Mirrors employer.controller.js#getMeHandler.
 */
async function getMeHandler(req, res, next) {
  try {
    const profile = await agencyService.getMyProfile(req.user.id);
    return res.status(200).json({ status: 'success', data: { profile } });
  } catch (err) {
    return next(err);
  }
}

/**
 * POST /api/v1/agencies/profile
 * Body validated upstream by validateBody(updateProfileSchema).
 */
async function updateMeHandler(req, res, next) {
  try {
    const profile = await agencyService.updateMyProfile(req.user.id, req.body);
    return res.status(200).json({ status: 'success', data: { profile } });
  } catch (err) {
    return next(err);
  }
}

/**
 * POST /api/v1/agencies/logo
 * File validated upstream by handleLogoUpload + validateUploadedLogo.
 * Mirrors employer.controller.js#uploadLogoHandler.
 */
async function uploadLogoHandler(req, res, next) {
  try {
    const profile = await agencyService.uploadLogo(req.user.id, req.file);
    return res.status(200).json({ status: 'success', data: { profile } });
  } catch (err) {
    return next(err);
  }
}

/**
 * POST /api/v1/agencies/walk-in
 * Body validated upstream by validateBody(walkInSchema); files (if any)
 * parsed/validated upstream by handleUpload + validateOptionalUploadedFiles.
 * Agency-role-only — enforced by rbac in agency.routes.js.
 */
async function walkInHandler(req, res, next) {
  try {
    const result = await agencyService.registerWalkIn(req.user.id, req.body, req.files || {});
    return res.status(201).json({ status: 'success', data: result });
  } catch (err) {
    return next(err);
  }
}

/**
 * GET /api/v1/agencies/candidates
 * Query validated upstream by validateQuery(listCandidatesSchema).
 * Agency-role-only — enforced by rbac in agency.routes.js.
 */
async function listCandidatesHandler(req, res, next) {
  try {
    const result = await agencyService.listCandidates(req.user.id, req.query);
    return res.status(200).json({ status: 'success', data: result });
  } catch (err) {
    return next(err);
  }
}

/**
 * POST /api/v1/agencies/dispatch
 * Body validated upstream by validateBody(dispatchSchema).
 * Agency-role-only — enforced by rbac in agency.routes.js.
 */
async function dispatchHandler(req, res, next) {
  try {
    const result = await agencyService.dispatchCandidates(
      req.user.id,
      req.body.job_id,
      req.body.seeker_ids,
    );
    return res.status(200).json({ status: 'success', data: result });
  } catch (err) {
    return next(err);
  }
}

/**
 * POST /api/v1/agencies/finance/ledger
 * Body validated upstream by validateBody(ledgerEntrySchema).
 * Agency-role-only — enforced by rbac in agency.routes.js.
 */
async function ledgerEntryHandler(req, res, next) {
  try {
    const result = await agencyService.recordLedgerEntry(req.user.id, req.body);
    return res.status(201).json({ status: 'success', data: result });
  } catch (err) {
    return next(err);
  }
}

/**
 * GET /api/v1/agencies/dashboard/stats
 * Query validated upstream by validateQuery(dashboardStatsQuerySchema).
 * Agency-role-only — enforced by rbac in agency.routes.js.
 */
async function dashboardStatsHandler(req, res, next) {
  try {
    const stats = await agencyService.getDashboardStats(req.user.id, req.query);
    return res.status(200).json({ status: 'success', data: stats });
  } catch (err) {
    return next(err);
  }
}

/**
 * PATCH /api/v1/agencies/placements/:id/status
 * Params validated upstream by validateParams(placementIdParamSchema);
 * body validated upstream by validateBody(updatePlacementStatusSchema).
 * Agency-role-only — enforced by rbac in agency.routes.js.
 */
async function updatePlacementStatusHandler(req, res, next) {
  try {
    const result = await agencyService.updatePlacementStatus(
      req.user.id,
      req.params.id,
      req.body.status,
    );
    return res.status(200).json({ status: 'success', data: result });
  } catch (err) {
    return next(err);
  }
}

module.exports = {
  getMeHandler,
  updateMeHandler,
  uploadLogoHandler,
  walkInHandler,
  listCandidatesHandler,
  dispatchHandler,
  ledgerEntryHandler,
  dashboardStatsHandler,
  updatePlacementStatusHandler,
};
