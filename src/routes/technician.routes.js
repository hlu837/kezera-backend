'use strict';

const { Router } = require('express');
const { authenticate } = require('../middleware/auth.middleware');
const { authorizeRoles } = require('../middleware/rbac.middleware');
const { validateBody, validateQuery } = require('../middleware/validate.middleware');
const {
  updateProfileSchema,
  updateAvailabilitySchema,
  updateLocationSchema,
  nearbyTechniciansSchema,
} = require('../validators/technician.validator');
const {
  getMeHandler,
  updateMeHandler,
  updateAvailabilityHandler,
  updateLocationHandler,
  nearbyHandler,
  tradeCategoriesHandler,
} = require('../controllers/technician.controller');

const router = Router();

// "Find a technician near you" map/list — no auth, same guest-preview
// reasoning as GET /seekers/nearby. Registered before the blanket
// `authorizeRoles('seeker')` guard below, same as seeker.routes.js.
router.get('/nearby', validateQuery(nearbyTechniciansSchema), nearbyHandler);

// "Trade Technicians" directory landing page (trade categories +
// counts) — also no auth, same reasoning as `/nearby` above.
router.get('/trade-categories', tradeCategoriesHandler);

// Every route registered below this line is seeker-only — a Technician
// profile is an additional profile a seeker-role account may optionally
// hold (see Technician.model.js's top-of-file note), not a new role.
router.use(authenticate, authorizeRoles('seeker'));

router.get('/me', getMeHandler);
// Upsert: creates the profile on first call (registration), updates it
// on every call after (editing) — see
// technician.service.js#upsertMyProfile.
router.patch('/me', validateBody(updateProfileSchema), updateMeHandler);
router.patch(
  '/me/availability',
  validateBody(updateAvailabilitySchema),
  updateAvailabilityHandler,
);
router.patch('/me/location', validateBody(updateLocationSchema), updateLocationHandler);

module.exports = router;
