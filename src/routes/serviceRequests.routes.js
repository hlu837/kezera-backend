'use strict';

const { Router } = require('express');
const { authenticate } = require('../middleware/auth.middleware');
const { requireApproved } = require('../middleware/requireApproved.middleware');
const { validateBody, validateQuery, validateParams } = require('../middleware/validate.middleware');
const { authorizeRoles } = require('../middleware/rbac.middleware');
const {
  serviceRequestIdParamSchema,
  createServiceRequestSchema,
  assignExpertSchema,
  respondToServiceRequestSchema,
  updateServiceRequestStatusSchema,
  listServiceRequestsQuerySchema,
} = require('../validators/serviceRequests.validator');
const {
  createServiceRequestHandler,
  listMyRequestsHandler,
  listIncomingRequestsHandler,
  assignExpertHandler,
  respondToRequestHandler,
  updateStatusHandler,
} = require('../controllers/serviceRequests.controller');

const router = Router();

// Open to any authenticated role (seeker, employer, agency) — same
// reasoning as placements.routes.js: any account can be the one doing
// the booking here, so there's no blanket `authorizeRoles` at the top.
// `requireApproved` still applies so a suspended/unpaid employer or
// agency account can't book either.
router.use(authenticate, requireApproved);

// "Request Service" — booking a one-off job from an Expert or Agency
// found via the guest-facing /seekers/nearby or /agencies/nearby maps.
router.post(
  '/',
  validateBody(createServiceRequestSchema),
  createServiceRequestHandler,
);

// Declared before the `/:id/...` routes below so the literal paths
// `/mine` and `/incoming` can't ever be swallowed by the `:id` param
// (same convention as placements.routes.js's `/invite`).
router.get(
  '/mine',
  validateQuery(listServiceRequestsQuerySchema),
  listMyRequestsHandler,
);

// Expert/Agency inbox — role-checked inside the service itself (see
// serviceRequests.service.js#listIncomingRequests), since which field
// the query keys on depends on the role.
router.get(
  '/incoming',
  authorizeRoles('seeker', 'agency'),
  validateQuery(listServiceRequestsQuerySchema),
  listIncomingRequestsHandler,
);

router.post(
  '/:id/assign',
  authorizeRoles('agency'),
  validateParams(serviceRequestIdParamSchema),
  validateBody(assignExpertSchema),
  assignExpertHandler,
);

router.post(
  '/:id/respond',
  authorizeRoles('seeker'),
  validateParams(serviceRequestIdParamSchema),
  validateBody(respondToServiceRequestSchema),
  respondToRequestHandler,
);

router.patch(
  '/:id/status',
  validateParams(serviceRequestIdParamSchema),
  validateBody(updateServiceRequestStatusSchema),
  updateStatusHandler,
);

module.exports = router;
