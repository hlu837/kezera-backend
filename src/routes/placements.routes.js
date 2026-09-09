'use strict';

const { Router } = require('express');
const { authenticate } = require('../middleware/auth.middleware');
const { requireApproved } = require('../middleware/requireApproved.middleware');
const { validateBody, validateParams } = require('../middleware/validate.middleware');
const {
  placementIdParamSchema,
  scheduleInterviewSchema,
  sendMessageSchema,
} = require('../validators/placements.validator');
const {
  scheduleInterviewHandler,
  listInterviewsHandler,
  sendMessageHandler,
  listMessagesHandler,
} = require('../controllers/placements.controller');

const router = Router();

// EMP-02: open to any authenticated role (seeker, employer, agency,
// admin) — per-resource participant checks happen inside
// utils/placementAccess.js#resolvePlacementForParticipant, not via a
// blanket rbac gate here, since "can I see this placement" depends on
// which specific placement is requested, not the caller's role alone.
// `requireApproved` is still applied: it no-ops for seeker/admin
// callers, and for employer/agency callers it now doubles as the
// "chat is a service too" enforcement point for admin-issued account
// suspensions (see requireApproved.middleware.js), not just the
// pre-existing onboarding-approval gate.
// NOTE: `validateParams(placementIdParamSchema)` must be attached to each
// specific `/:placementId/...` route below, NOT to this blanket
// `router.use()`. Express only populates `req.params.placementId` once a
// route *pattern* containing `:placementId` has been matched — a bare
// `router.use(fn)` layer (no path, or a path with no params of its own)
// runs before that match happens, so `req.params` is still empty at that
// point and Joi's `.required()` check on `placementId` always fails,
// throwing a 422 "Invalid route parameters" on every call. (Previously:
// `router.use(authenticate, requireApproved, validateParams(placementIdParamSchema))`.)
router.use(authenticate, requireApproved);

router.post(
  '/:placementId/interviews',
  validateParams(placementIdParamSchema),
  validateBody(scheduleInterviewSchema),
  scheduleInterviewHandler,
);
router.get(
  '/:placementId/interviews',
  validateParams(placementIdParamSchema),
  listInterviewsHandler,
);

router.post(
  '/:placementId/messages',
  validateParams(placementIdParamSchema),
  validateBody(sendMessageSchema),
  sendMessageHandler,
);
router.get(
  '/:placementId/messages',
  validateParams(placementIdParamSchema),
  listMessagesHandler,
);

module.exports = router;
