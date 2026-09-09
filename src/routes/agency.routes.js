'use strict';

const { Router } = require('express');
const { authenticate } = require('../middleware/auth.middleware');
const { authorizeRoles } = require('../middleware/rbac.middleware');
const { requireApproved } = require('../middleware/requireApproved.middleware');
const { validateBody, validateQuery, validateParams } = require('../middleware/validate.middleware');
const {
  handleUpload,
  validateOptionalUploadedFiles,
  handleLogoUpload,
  validateUploadedLogo,
} = require('../middleware/upload.middleware');
const {
  updateProfileSchema,
  walkInSchema,
  listCandidatesSchema,
  dispatchSchema,
  ledgerEntrySchema,
  dashboardStatsQuerySchema,
  placementIdParamSchema,
  updatePlacementStatusSchema,
} = require('../validators/agency.validator');
const {
  getMeHandler,
  updateMeHandler,
  uploadLogoHandler,
  walkInHandler,
  listCandidatesHandler,
  dispatchHandler,
  ledgerEntryHandler,
  dashboardStatsHandler,
  updatePlacementStatusHandler,
} = require('../controllers/agency.controller');

const router = Router();

// Every route in this module requires a valid JWT, the `agency` role,
// AND an approved verificationStatus — walk-in registration and roster
// access are agency-backoffice-only operations, never reachable by a
// seeker/employer/admin token, and a pending/rejected agency must not
// be able to register candidates, dispatch shortlists, touch the
// finance ledger, or advance placements while awaiting/failing review.
router.use(authenticate, authorizeRoles('agency'), requireApproved);

// Agency account screen: profile view/edit. Mirrors
// employer.routes.js's GET /me + POST /profile pair.
router.get('/me', getMeHandler);
router.post('/profile', validateBody(updateProfileSchema), updateMeHandler);

// Public-profile logo. Same magic-byte signature checking as the
// employer logo endpoint — see upload.middleware.js/file.util.js.
// Field name must be "logo".
router.post('/logo', handleLogoUpload, validateUploadedLogo, uploadLogoHandler);

// `cv`/`photo` are optional here (unlike POST /api/v1/seekers/upload,
// which requires at least one) — a desk worker may register the walk-in
// candidate first and attach bio-data documents in a later step.
router.post(
  '/walk-in',
  handleUpload,
  validateOptionalUploadedFiles,
  validateBody(walkInSchema),
  walkInHandler,
);

router.get('/candidates', validateQuery(listCandidatesSchema), listCandidatesHandler);

// Task 7: dispatch a shortlist to a job's poster, record a ledger
// entry, and read today's operational KPIs.
router.post('/dispatch', validateBody(dispatchSchema), dispatchHandler);
router.post('/finance/ledger', validateBody(ledgerEntrySchema), ledgerEntryHandler);
router.get('/dashboard/stats', validateQuery(dashboardStatsQuerySchema), dashboardStatsHandler);

// Manual placement lifecycle advance: 'sent' -> 'interviewed' -> 'hired',
// or 'rejected' from either 'sent' or 'interviewed'. See
// agency.service.js#updatePlacementStatus for the transition rules.
router.patch(
  '/placements/:id/status',
  validateParams(placementIdParamSchema),
  validateBody(updatePlacementStatusSchema),
  updatePlacementStatusHandler,
);

module.exports = router;
