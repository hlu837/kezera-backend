'use strict';

const { Router } = require('express');
const { authenticate } = require('../middleware/auth.middleware');
const { validateBody, validateQuery, validateParams } = require('../middleware/validate.middleware');
const {
  agencyIdParamSchema,
  agencyCommentIdParamSchema,
  createAgencyCommentSchema,
  listAgencyCommentsQuerySchema,
  listAgencyJobsQuerySchema,
} = require('../validators/agencyComment.validator');
const {
  getPublicProfileHandler,
  listAgencyCommentsHandler,
  createAgencyCommentHandler,
  deleteAgencyCommentHandler,
} = require('../controllers/agencyComment.controller');
const { getAgencyJobsHandler } = require('../controllers/jobs.controller');

const router = Router();

// Everything in this file is mounted (in app.js) at the same
// '/api/v1/agencies' prefix as agency.routes.js, but MUST be
// registered first: agency.routes.js's `router.use(authenticate,
// authorizeRoles('agency'), requireApproved)` runs for every request
// that reaches that router, including ones meant for these public
// routes, which would otherwise 401 a logged-out visitor just for
// looking at an agency's profile/comments. Since none of the paths
// below overlap with agency.routes.js's own ('/me', '/profile', ...),
// registering this router first lets it answer these requests before
// they ever reach that blanket gate.

// Public: an agency's bio/logo/name, same info shown on its job
// postings — read by anyone deciding whether to apply through it.
router.get('/:agencyId/profile', validateParams(agencyIdParamSchema), getPublicProfileHandler);

// Public: "see all jobs by this agency" — reached by tapping an
// agency's name off a job card/detail screen (job.poster.agencyId) or
// off this same agency's profile screen. Every OPEN job it has
// posted, newest first; same shape as GET /jobs so the client can
// reuse its existing job-list parsing/rendering.
router.get(
  '/:agencyId/jobs',
  validateParams(agencyIdParamSchema),
  validateQuery(listAgencyJobsQuerySchema),
  getAgencyJobsHandler,
);

// Public: anyone (including a logged-out visitor) can read what's been
// said about an agency, same "browse is public" rationale as
// jobs.routes.js's GET /.
router.get(
  '/:agencyId/comments',
  validateParams(agencyIdParamSchema),
  validateQuery(listAgencyCommentsQuerySchema),
  listAgencyCommentsHandler,
);

// Posting a comment requires being logged in (any role), not the
// `agency` role specifically — a seeker or employer commenting on an
// agency they've dealt with is the whole point of this feature. The
// agency-can't-review-itself rule is enforced in the service layer,
// where the agency's own id is known.
router.post(
  '/:agencyId/comments',
  authenticate,
  validateParams(agencyIdParamSchema),
  validateBody(createAgencyCommentSchema),
  createAgencyCommentHandler,
);

// A comment's own author, or an admin, may remove it.
router.delete(
  '/:agencyId/comments/:commentId',
  authenticate,
  validateParams(agencyCommentIdParamSchema),
  deleteAgencyCommentHandler,
);

module.exports = router;
