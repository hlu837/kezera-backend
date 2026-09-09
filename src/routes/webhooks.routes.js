'use strict';

const express = require('express');
const { validateQuery } = require('../middleware/validate.middleware');
const { verifySmsWebhookSignature } = require('../middleware/smsWebhookAuth.middleware');
const { smsReceiveQuerySchema } = require('../validators/webhooks.validator');
const { smsReceiveHandler } = require('../controllers/webhooks.controller');

const router = express.Router();

// Twilio and Africa's Talking both POST inbound SMS callbacks as
// application/x-www-form-urlencoded, not JSON — app.js only registers
// express.json() globally, so this router owns its own form parser.
// Scoped to this router (not added globally) to avoid changing body
// parsing behavior for the rest of the API.
const formParser = express.urlencoded({ extended: false });

// No `authenticate`/JWT here deliberately — the caller is an SMS
// gateway, not a logged-in user. Authenticity is instead established
// by verifySmsWebhookSignature (Twilio's HMAC signature, or Africa's
// Talking's shared secret), which must run after body parsing so
// req.body is populated for Twilio's signature computation.
router.post(
  '/sms/receive',
  formParser,
  validateQuery(smsReceiveQuerySchema),
  verifySmsWebhookSignature,
  smsReceiveHandler,
);

module.exports = router;
