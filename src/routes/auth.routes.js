'use strict';

const { Router } = require('express');
const { registerHandler, loginHandler } = require('../controllers/auth.controller');
const { validateBody } = require('../middleware/validate.middleware');
const { registerSchema, loginSchema } = require('../validators/auth.validator');

const router = Router();

router.post('/register', validateBody(registerSchema), registerHandler);
router.post('/login', validateBody(loginSchema), loginHandler);

module.exports = router;
