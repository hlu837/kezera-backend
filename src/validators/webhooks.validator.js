'use strict';

const Joi = require('joi');

/**
 * `provider` selects which gateway this delivery came from (each
 * gateway's console is configured with its own callback URL carrying
 * this param). `secret` is only meaningful for provider=africastalking
 * (see middleware/smsWebhookAuth.middleware.js) but is accepted here
 * unconditionally so Joi doesn't reject it for Twilio deliveries that
 * happen to include it.
 */
const smsReceiveQuerySchema = Joi.object({
  provider: Joi.string().valid('twilio', 'africastalking').required(),
  secret: Joi.string().optional(),
}).options({ abortEarly: false, stripUnknown: false });

module.exports = { smsReceiveQuerySchema };
