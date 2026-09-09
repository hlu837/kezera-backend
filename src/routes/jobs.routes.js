'use strict';

const { Router } = require('express');
const { authenticate } = require('../middleware/auth.middleware');
const { authorizeRoles } = require('../middleware/rbac.middleware');
const { requireApproved } = require('../middleware/requireApproved.middleware');
const { requireAgencyPublicProfile } = require('../middleware/requireAgencyPublicProfile.middleware');
const { validateBody, validateQuery, validateParams } = require('../middleware/validate.middleware');
const {
  createJobSchema, updateJobSchema, jobIdParamSchema, inviteCandidateSchema, browseJobsSchema,
  jobApplicationParamSchema, updateApplicationStatusSchema,
} = require('../validators/jobs.validator');
const {
  createJobHandler,
  myJobsHandler,
  updateJobHandler,
  getSuggestedSeekersHandler,
  inviteCandidateHandler,
  browseJobsHandler,
} = require('../controllers/jobs.controller');
const {
  applyToJobHandler,
  getJobApplicationsHandler,
  updateApplicationStatusHandler,
  getApplicationSummaryHandler,
} = require('../controllers/applications.controller');

const router = Router();

// JS-03: the job board — public. Anyone (including a logged-out visitor
// on the landing page) can browse/search open jobs; browseJobsHandler
// only reads req.query, never req.user, so there's nothing here that
// needs a session. Registered *before* the blanket
// `authorizeRoles('employer', 'agency')` guard below — same pattern as
// seeker.routes.js's own `/search` route — so this GET / never reaches
// (and is never blocked by) that employer/agency-only gate.
router.get(
  '/',
  validateQuery(browseJobsSchema),
  browseJobsHandler,
);

// JS-05: a seeker applying to a specific job. Also registered before
// the blanket employer/agency guard below, for the same reason — a
// seeker hitting this route must never be caught by a rule meant for
// job *posting*, not job *seeking*.
router.post(
  '/:id/apply',
  authenticate,
  authorizeRoles('seeker'),
  validateParams(jobIdParamSchema),
  applyToJobHandler,
);

// Every route registered below this line requires a valid JWT, the
// `employer` or `agency` role, AND an approved verificationStatus —
// job posting/management is not a seeker/admin concern, and pending
// or rejected businesses must not be able to post or manage jobs
// while awaiting/failing admin review.
router.use(authenticate, authorizeRoles('employer', 'agency'), requireApproved);

// requireAgencyPublicProfile is a no-op for employer callers; only an
// agency posting its first job (no existing job, no bio/logo) is
// blocked here. See requireAgencyPublicProfile.middleware.js.
router.post(
  '/create',
  requireAgencyPublicProfile,
  validateBody(createJobSchema),
  createJobHandler,
);
router.get('/my-jobs', myJobsHandler);
router.get('/:id/suggested-seekers', validateParams(jobIdParamSchema), getSuggestedSeekersHandler);
router.post(
  '/:id/invite-candidate',
  validateParams(jobIdParamSchema),
  validateBody(inviteCandidateSchema),
  inviteCandidateHandler,
);
router.get('/:id/applications', validateParams(jobIdParamSchema), getJobApplicationsHandler);
// Employer/agency-facing AI-assisted summary of everyone who applied —
// gated by the job's own applicationSummaryEnabled opt-in (see
// applicationSummary.service.js#assertSummaryAllowed), not by role
// alone, so this 404s/400s per-job rather than per-account.
router.get(
  '/:id/applications/summary',
  validateParams(jobIdParamSchema),
  getApplicationSummaryHandler,
);
// JS-05: "Shortlist" (and un-shortlist/reject) a direct applicant from
// the "View candidates" screen.
router.patch(
  '/:id/applications/:applicationId/status',
  validateParams(jobApplicationParamSchema),
  validateBody(updateApplicationStatusSchema),
  updateApplicationStatusHandler,
);
router.patch('/:id', validateParams(jobIdParamSchema), validateBody(updateJobSchema), updateJobHandler);

module.exports = router;
