'use strict';

const crypto = require('crypto');
const env = require('../config/env');
const AppError = require('../errors/AppError');

/**
 * Verifies Twilio's `X-Twilio-Signature` header per Twilio's documented
 * algorithm (https://www.twilio.com/docs/usage/webhooks/webhooks-security):
 *   1. Take the exact URL Twilio was configured to POST to (including
 *      query string).
 *   2. Sort the POST body's keys alphabetically and concatenate each
 *      key+value directly onto the URL (no separators).
 *   3. HMAC-SHA1 that string with the account's Auth Token, base64-encode it.
 *   4. Compare to the header, byte-for-byte.
 *
 * Implemented by hand against the documented algorithm (rather than
 * pulling in the `twilio` SDK) to keep this consistent with
 * sms.service.js / email.service.js, which call the providers' REST
 * APIs directly instead of adding SDK dependencies.
 *
 * @param {import('express').Request} req
 * @returns {boolean}
 */
function isValidTwilioSignature(req) {
  const { authToken } = env.sms.twilio;
  const signatureHeader = req.headers['x-twilio-signature'];
  if (!authToken || !signatureHeader) return false;
  if (!env.publicBaseUrl) {
    // Can't verify without knowing the exact URL Twilio signed against.
    // eslint-disable-next-line no-console
    console.error('[smsWebhookAuth] PUBLIC_BASE_URL is not configured; cannot verify Twilio signature');
    return false;
  }

  const fullUrl = `${env.publicBaseUrl.replace(/\/+$/, '')}${req.originalUrl}`;
  const params = req.body || {};
  const sortedKeys = Object.keys(params).sort();
  const dataString = sortedKeys.reduce((acc, key) => acc + key + params[key], fullUrl);

  const expectedSignature = crypto
    .createHmac('sha1', authToken)
    .update(Buffer.from(dataString, 'utf-8'))
    .digest('base64');

  const expected = Buffer.from(expectedSignature);
  const received = Buffer.from(String(signatureHeader));

  return expected.length === received.length && crypto.timingSafeEqual(expected, received);
}

/**
 * Verifies Africa's Talking's inbound SMS callback via a shared secret.
 * AT does not cryptographically sign inbound webhook requests, so the
 * standard mitigation (per AT's own guidance and common practice) is a
 * hard-to-guess secret embedded in the callback URL registered on the
 * AT dashboard, checked here. Accepts the secret from either the query
 * string (`?secret=...`, matching how it'd be embedded in the
 * registered callback URL) or an `X-AT-Webhook-Secret` header, in case
 * it's supplied either way.
 *
 * @param {import('express').Request} req
 * @returns {boolean}
 */
function isValidAfricasTalkingSecret(req) {
  const { webhookSecret } = env.sms.africastalking;
  if (!webhookSecret) return false;

  const provided = req.query.secret || req.headers['x-at-webhook-secret'];
  if (!provided) return false;

  const expected = Buffer.from(String(webhookSecret));
  const received = Buffer.from(String(provided));

  return expected.length === received.length && crypto.timingSafeEqual(expected, received);
}

/**
 * Express middleware guarding POST /api/v1/webhooks/sms/receive.
 * Branches on `?provider=twilio|africastalking` (the endpoint is
 * shared, but each gateway is registered with its own callback URL
 * carrying this query param) and rejects anything that doesn't pass
 * that provider's verification with 403, before any business logic runs.
 *
 * Must run after body parsing (express.urlencoded) so `req.body` is
 * populated for the Twilio signature check.
 */
function verifySmsWebhookSignature(req, res, next) {
  const provider = req.query.provider;

  let isValid = false;
  if (provider === 'twilio') {
    isValid = isValidTwilioSignature(req);
  } else if (provider === 'africastalking') {
    isValid = isValidAfricasTalkingSecret(req);
  } else {
    return next(new AppError('Missing or unsupported "provider" query parameter', 400));
  }

  if (!isValid) {
    // eslint-disable-next-line no-console
    console.error(
      `[smsWebhookAuth] rejected inbound SMS webhook: provider=${provider} `
      + `ip=${req.ip} failed signature/secret verification`,
    );
    return next(new AppError('Webhook signature verification failed', 403));
  }

  return next();
}

module.exports = { verifySmsWebhookSignature, isValidTwilioSignature, isValidAfricasTalkingSecret };
