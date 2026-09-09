'use strict';

const { Router } = require('express');
const { authenticate } = require('../middleware/auth.middleware');
const { validateBody, validateParams } = require('../middleware/validate.middleware');
const {
  interviewIdParamSchema,
  rescheduleInterviewSchema,
  updateInterviewStatusSchema,
} = require('../validators/placements.validator');
const {
  rescheduleInterviewHandler,
  updateInterviewStatusHandler,
} = require('../controllers/placements.controller');

const router = Router();

// Poster-only in practice (enforced inside interviews.service.js via
// viewerRole, not here — same rationale as placements.routes.js).
router.use(authenticate, validateParams(interviewIdParamSchema));

router.patch('/:id', validateBody(rescheduleInterviewSchema), rescheduleInterviewHandler);
router.patch('/:id/status', validateBody(updateInterviewStatusSchema), updateInterviewStatusHandler);

module.exports = router;
