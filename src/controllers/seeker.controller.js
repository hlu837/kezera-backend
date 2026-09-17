'use strict';

const seekerService = require('../services/seeker.service');
const cvBuilderService = require('../services/cvBuilder.service');

/**
 * GET /api/v1/seekers/me/placements
 */
async function getMyPlacementsHandler(req, res, next) {
  try {
    const placements = await seekerService.getMyPlacements(req.user.id);
    return res.status(200).json({ status: 'success', data: { placements } });
  } catch (err) {
    return next(err);
  }
}

/**
 * GET /api/v1/seekers/me
 */
async function getMeHandler(req, res, next) {
  try {
    const profile = await seekerService.getMyProfile(req.user.id);
    return res.status(200).json({ status: 'success', data: { profile } });
  } catch (err) {
    return next(err);
  }
}

/**
 * PATCH /api/v1/seekers/me
 * Body validated upstream by validateBody(updateProfileSchema).
 */
async function updateMeHandler(req, res, next) {
  try {
    const profile = await seekerService.updateMyProfile(req.user.id, req.body);
    return res.status(200).json({ status: 'success', data: { profile } });
  } catch (err) {
    return next(err);
  }
}

/**
 * PATCH /api/v1/seekers/me/availability
 * Body validated upstream by validateBody(updateAvailabilitySchema).
 */
async function updateAvailabilityHandler(req, res, next) {
  try {
    const profile = await seekerService.updateAvailability(req.user.id, req.body.availability_status);
    return res.status(200).json({ status: 'success', data: { profile } });
  } catch (err) {
    return next(err);
  }
}

/**
 * PATCH /api/v1/seekers/me/preferences
 * Body validated upstream by validateBody(updatePreferencesSchema).
 */
async function updatePreferencesHandler(req, res, next) {
  try {
    const profile = await seekerService.updatePreferences(req.user.id, req.body);
    return res.status(200).json({ status: 'success', data: { profile } });
  } catch (err) {
    return next(err);
  }
}

/**
 * POST /api/v1/seekers/upload
 * Files validated upstream by handleUpload + validateUploadedFiles.
 */
async function uploadHandler(req, res, next) {
  try {
    const profile = await seekerService.handleUpload(req.user.id, req.files || {});
    return res.status(200).json({ status: 'success', data: { profile } });
  } catch (err) {
    return next(err);
  }
}

/**
 * GET /api/v1/seekers/search
 * Query validated upstream by validateQuery(searchSeekersSchema).
 * Employer/agency only — enforced by rbac in seeker.routes.js.
 */
async function searchHandler(req, res, next) {
  try {
    const result = await seekerService.searchSeekers(req.query, {
      id: req.user.id,
      role: req.user.role,
    });
    return res.status(200).json({ status: 'success', data: result });
  } catch (err) {
    return next(err);
  }
}

/**
 * PATCH /api/v1/seekers/me/cv-builder
 * CV-03: saves the wizard's draft data (no PDF regeneration).
 * Body validated upstream by validateBody(cvBuilderDataSchema).
 */
async function saveCvBuilderDataHandler(req, res, next) {
  try {
    const profile = await cvBuilderService.saveCvBuilderData(req.user.id, req.body);
    return res.status(200).json({ status: 'success', data: { profile } });
  } catch (err) {
    return next(err);
  }
}

/**
 * POST /api/v1/seekers/me/cv-builder/generate
 * CV-03: renders the CV builder payload into a PDF and sets it as cvUrl.
 * Body validated upstream by validateBody(generateCvSchema).
 */
async function generateCvHandler(req, res, next) {
  try {
    const profile = await cvBuilderService.generateCv(req.user.id, req.body);
    return res.status(200).json({ status: 'success', data: { profile } });
  } catch (err) {
    return next(err);
  }
}

/**
 * GET /api/v1/seekers/public-search
 * Query validated upstream by validateQuery(publicSearchSeekersSchema).
 * No auth — guest landing page "browse talent" toggle.
 */
async function publicSearchHandler(req, res, next) {
  try {
    const result = await seekerService.publicSearchSeekers(req.query);
    return res.status(200).json({ status: 'success', data: result });
  } catch (err) {
    return next(err);
  }
}

module.exports = {
  getMeHandler,
  updateMeHandler,
  updateAvailabilityHandler,
  updatePreferencesHandler,
  uploadHandler,
  searchHandler,
  publicSearchHandler,
  getMyPlacementsHandler,
  saveCvBuilderDataHandler,
  generateCvHandler,
};
