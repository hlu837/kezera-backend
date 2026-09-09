'use strict';

const adsService = require('../services/ads.service');

/**
 * POST /api/v1/ads
 * Body validated upstream by validateBody(createAdSchema).
 */
async function createAdHandler(req, res, next) {
  try {
    const ad = await adsService.createAd(req.user.id, req.user.role, req.body);
    return res.status(201).json({ status: 'success', data: { ad } });
  } catch (err) {
    return next(err);
  }
}

/**
 * GET /api/v1/ads/mine
 */
async function listMyAdsHandler(req, res, next) {
  try {
    const ads = await adsService.listMyAds(req.user.id);
    return res.status(200).json({ status: 'success', data: { ads } });
  } catch (err) {
    return next(err);
  }
}

/**
 * GET /api/v1/ads/active
 * Public — no auth. Powers the frontend AdCarousel.
 */
async function listActiveAdsHandler(req, res, next) {
  try {
    const ads = await adsService.listActiveAds();
    return res.status(200).json({ status: 'success', data: { ads } });
  } catch (err) {
    return next(err);
  }
}

module.exports = { createAdHandler, listMyAdsHandler, listActiveAdsHandler };
