'use strict';

const { Router } = require('express');
const { authenticate } = require('../middleware/auth.middleware');
const { authorizeRoles } = require('../middleware/rbac.middleware');
const { requireApproved } = require('../middleware/requireApproved.middleware');
const { validateBody, validateQuery, validateParams } = require('../middleware/validate.middleware');
const { handleUpload, validateUploadedFiles } = require('../middleware/upload.middleware');
const {
  updateProfileSchema,
  updateAvailabilitySchema,
  searchSeekersSchema,
  publicSearchSeekersSchema,
  updatePreferencesSchema,
  cvBuilderDataSchema,
  generateCvSchema,
} = require('../validators/seeker.validator');
const {
  createSavedSearchSchema,
  updateSavedSearchSchema,
  savedSearchIdParamSchema,
} = require('../validators/savedSearch.validator');
const {
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
} = require('../controllers/seeker.controller');
const savedSearchController = require('../controllers/savedSearch.controller');
const { myApplicationsHandler } = require('../controllers/applications.controller');

const router = Router();

// Candidate search is an employer/agency-facing endpoint, NOT seeker-only,
// so it's registered *before* the blanket `authorizeRoles('seeker')`
// middleware below — Express matches routes in registration order, so a
// request to /search never reaches (and is never blocked by) that guard.
router.get(
  '/search',
  authenticate,
  authorizeRoles('employer', 'agency'),
  requireApproved,
  validateQuery(searchSeekersSchema),
  searchHandler,
);

// SEEK-xx: no-auth "browse talent" preview for the guest landing page's
// employer/agency toggle. Registered before the blanket
// `authorizeRoles('seeker')` guard below for the same reason as
// `/search` above — Express matches routes in registration order.
router.get('/public-search', validateQuery(publicSearchSeekersSchema), publicSearchHandler);

// Every route registered below this line is seeker-only.
router.use(authenticate, authorizeRoles('seeker'));

router.get('/me', getMeHandler);
router.patch('/me', validateBody(updateProfileSchema), updateMeHandler);
router.patch('/me/availability', validateBody(updateAvailabilitySchema), updateAvailabilityHandler);
// SEEK-01: Category & Preference Setup screen, shown right after signup.
router.patch('/me/preferences', validateBody(updatePreferencesSchema), updatePreferencesHandler);
router.post('/upload', handleUpload, validateUploadedFiles, uploadHandler);
// CV-03: "Build your CV" wizard — save draft data without generating a
// PDF, and generate the PDF from the full payload, respectively.
router.patch('/me/cv-builder', validateBody(cvBuilderDataSchema), saveCvBuilderDataHandler);
router.post('/me/cv-builder/generate', validateBody(generateCvSchema), generateCvHandler);
// EMP-02: lets a seeker discover their own placementIds, needed to hit
// /api/v1/placements/:placementId/{interviews,messages}.
router.get('/me/placements', getMyPlacementsHandler);
// JS-05: a seeker's own "apply to a job" history.
router.get('/me/applications', myApplicationsHandler);

// JS-03: saved searches + alert preferences. Seeker-only, scoped to
// the caller's own Seeker profile inside savedSearch.service.js.
router.post(
  '/saved-searches',
  validateBody(createSavedSearchSchema),
  savedSearchController.createHandler,
);
router.get('/saved-searches', savedSearchController.listHandler);
router.patch(
  '/saved-searches/:id',
  validateParams(savedSearchIdParamSchema),
  validateBody(updateSavedSearchSchema),
  savedSearchController.updateHandler,
);
router.delete(
  '/saved-searches/:id',
  validateParams(savedSearchIdParamSchema),
  savedSearchController.deleteHandler,
);

module.exports = router;
