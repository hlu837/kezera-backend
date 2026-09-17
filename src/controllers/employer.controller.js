'use strict';

const employerService = require('../services/employer.service');

/**
 * GET /api/v1/employers/me
 * Mirrors seeker.controller.js#getMeHandler.
 */
async function getMeHandler(req, res, next) {
  try {
    const profile = await employerService.getMyProfile(req.user.id);
    return res.status(200).json({ status: 'success', data: { profile } });
  } catch (err) {
    return next(err);
  }
}

/**
 * POST /api/v1/employers/profile
 * Body validated upstream by validateBody(updateProfileSchema).
 */
async function updateMeHandler(req, res, next) {
  try {
    const profile = await employerService.updateMyProfile(req.user.id, req.body);
    return res.status(200).json({ status: 'success', data: { profile } });
  } catch (err) {
    return next(err);
  }
}

/**
 * POST /api/v1/employers/logo
 * File validated upstream by handleLogoUpload + validateUploadedLogo.
 */
async function uploadLogoHandler(req, res, next) {
  try {
    const profile = await employerService.uploadLogo(req.user.id, req.file);
    return res.status(200).json({ status: 'success', data: { profile } });
  } catch (err) {
    return next(err);
  }
}

module.exports = { getMeHandler, updateMeHandler, uploadLogoHandler };
