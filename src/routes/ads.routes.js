'use strict';

const { Router } = require('express');
const { authenticate } = require('../middleware/auth.middleware');
const { authorizeRoles } = require('../middleware/rbac.middleware');
const { requireApproved } = require('../middleware/requireApproved.middleware');
const { validateBody } = require('../middleware/validate.middleware');
const { createAdSchema } = require('../validators/ads.validator');
const {
  createAdHandler,
  listMyAdsHandler,
  listActiveAdsHandler,
} = require('../controllers/ads.controller');

const router = Router();

// Public — the job board's AdCarousel (including the unauthenticated
// public board) reads from here. Must be registered before the
// `authenticate` gate below, and takes no :id-style param that could
// collide with it.
router.get('/active', listActiveAdsHandler);

// Everything below requires a verified employer/agency — same gate as
// employer.routes.js/jobs.routes.js. Whether this account's *tier*
// actually entitles it to advertise is checked deeper in
// ads.service.js#assertCanAdvertise (admin-controlled per tier), not
// here at the route level.
router.use(authenticate, authorizeRoles('employer', 'agency'), requireApproved);

// POST /api/v1/ads  { title, subtitle, icon?, link_url? }
// Creates a draft ad — see POST /api/v1/payments/initialize-ad to
// actually pay for and submit it for admin review.
router.post('/', validateBody(createAdSchema), createAdHandler);

// GET /api/v1/ads/mine
router.get('/mine', listMyAdsHandler);

module.exports = router;
