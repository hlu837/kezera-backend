'use strict';

const { Router } = require('express');
const { authenticate } = require('../middleware/auth.middleware');
const { authorizeRoles } = require('../middleware/rbac.middleware');
const { requireApproved } = require('../middleware/requireApproved.middleware');
const { validateBody } = require('../middleware/validate.middleware');
const { handleLogoUpload, validateUploadedLogo } = require('../middleware/upload.middleware');
const { updateProfileSchema } = require('../validators/employer.validator');
const { getMeHandler, updateMeHandler, uploadLogoHandler } = require('../controllers/employer.controller');

const router = Router();

// Every route in this module requires a valid JWT AND the `employer` role,
// and the account must be past payment + admin verification — matches the
// gate already applied to agency.routes.js and jobs.routes.js. Without
// this, a brand-new (payment_pending) or rejected employer could still
// update their company profile / logo before ever being approved.
// (Agencies get their own module later — kept separate deliberately so
// employer-only fields like backoffice_phone/promo_details can't be
// reached by an agency token.)
router.use(authenticate, authorizeRoles('employer'), requireApproved);

// EMP-04: profile view — the employer account screen loads this on open,
// same shape (`{ profile }`) the update/upload handlers below return, so
// the frontend can treat all three as one interchangeable profile source.
router.get('/me', getMeHandler);

router.post('/profile', validateBody(updateProfileSchema), updateMeHandler);

// EMP-04: multipart logo upload. Same magic-byte signature checking as
// the seeker cv/photo endpoint — see upload.middleware.js/file.util.js.
// Field name must be "logo".
router.post('/logo', handleLogoUpload, validateUploadedLogo, uploadLogoHandler);

module.exports = router;
