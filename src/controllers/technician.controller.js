'use strict';

const technicianService = require('../services/technician.service');

/**
 * GET /api/v1/technicians/me
 */
async function getMeHandler(req, res, next) {
  try {
    const profile = await technicianService.getMyProfile(req.user.id);
    return res.status(200).json({ status: 'success', data: { profile } });
  } catch (err) {
    return next(err);
  }
}

/**
 * PATCH /api/v1/technicians/me
 * Registration + edits both land here — see
 * technician.service.js#upsertMyProfile. Body validated upstream by
 * validateBody(updateProfileSchema).
 */
async function updateMeHandler(req, res, next) {
  try {
    const profile = await technicianService.upsertMyProfile(req.user.id, req.body);
    return res.status(200).json({ status: 'success', data: { profile } });
  } catch (err) {
    return next(err);
  }
}

/**
 * PATCH /api/v1/technicians/me/availability
 * Body validated upstream by validateBody(updateAvailabilitySchema).
 */
async function updateAvailabilityHandler(req, res, next) {
  try {
    const profile = await technicianService.updateAvailability(
      req.user.id,
      req.body.availability_status,
    );
    return res.status(200).json({ status: 'success', data: { profile } });
  } catch (err) {
    return next(err);
  }
}

/**
 * PATCH /api/v1/technicians/me/location
 * Body validated upstream by validateBody(updateLocationSchema).
 */
async function updateLocationHandler(req, res, next) {
  try {
    const profile = await technicianService.updateLocation(req.user.id, req.body);
    return res.status(200).json({ status: 'success', data: { profile } });
  } catch (err) {
    return next(err);
  }
}

/**
 * GET /api/v1/technicians/nearby
 * "Find a technician near you" map/list. Query validated upstream by
 * validateQuery(nearbyTechniciansSchema). No auth — same guest-preview
 * contract as GET /seekers/nearby.
 */
async function nearbyHandler(req, res, next) {
  try {
    const result = await technicianService.nearbyTechnicians({
      latitude: req.query.latitude,
      longitude: req.query.longitude,
      radiusKm: req.query.radius_km,
      skills: req.query.skills,
      trade: req.query.trade,
      limit: req.query.limit,
    });
    return res.status(200).json({ status: 'success', data: result });
  } catch (err) {
    return next(err);
  }
}

/**
 * GET /api/v1/technicians/trade-categories
 * "Trade Technicians" directory landing page. No auth — same
 * guest-preview contract as GET /seekers/trade-categories.
 */
async function tradeCategoriesHandler(req, res, next) {
  try {
    const categories = await technicianService.getTradeCategoryCounts();
    return res.status(200).json({ status: 'success', data: { categories } });
  } catch (err) {
    return next(err);
  }
}

module.exports = {
  getMeHandler,
  updateMeHandler,
  updateAvailabilityHandler,
  updateLocationHandler,
  nearbyHandler,
  tradeCategoriesHandler,
};
