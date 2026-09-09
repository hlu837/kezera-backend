'use strict';

const fetch = require('node-fetch');
const env = require('../config/env');
const AppError = require('../errors/AppError');

/**
 * Sends via Twilio's REST API (https://api.twilio.com/2010-04-01).
 * Uses the account SID + auth token as HTTP Basic Auth, per Twilio's
 * standard REST auth scheme — no SDK dependency required.
 *
 * @param {{ to: string, message: string }} params
 * @returns {Promise<{ provider: 'twilio', id: string }>}
 */
async function sendViaTwilio({ to, message }) {
  const { accountSid, authToken, fromNumber } = env.sms.twilio;
  if (!accountSid || !authToken || !fromNumber) {
    throw new AppError(
      'Twilio is not configured: missing TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, or TWILIO_FROM_NUMBER',
      500,
    );
  }

  const url = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`;
  const body = new URLSearchParams({ To: to, From: fromNumber, Body: message });
  const basicAuth = Buffer.from(`${accountSid}:${authToken}`).toString('base64');

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basicAuth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new AppError(
      `Twilio SMS send failed (${response.status}): ${payload.message || 'unknown error'}`,
      502,
    );
  }

  return { provider: 'twilio', id: payload.sid };
}

/**
 * Sends via Africa's Talking's REST API
 * (https://developers.africastalking.com/docs/sms/sending). Preferred
 * over Twilio in markets (e.g. Ethiopia and much of East Africa) where
 * AT has better local carrier coverage/pricing.
 *
 * @param {{ to: string, message: string }} params
 * @returns {Promise<{ provider: 'africastalking', id: string|null }>}
 */
async function sendViaAfricasTalking({ to, message }) {
  const { apiKey, username, senderId } = env.sms.africastalking;
  if (!apiKey || !username) {
    throw new AppError(
      "Africa's Talking is not configured: missing AT_API_KEY or AT_USERNAME",
      500,
    );
  }

  const body = new URLSearchParams({ username, to, message });
  if (senderId) body.set('from', senderId);

  const response = await fetch('https://api.africastalking.com/version1/messaging', {
    method: 'POST',
    headers: {
      apiKey,
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body,
  });

  const payload = await response.json().catch(() => ({}));
  const recipient = payload?.SMSMessageData?.Recipients?.[0];

  // AT returns HTTP 201 with a per-recipient status rather than failing
  // the whole request on a single bad number, so both layers are checked.
  if (!response.ok || !recipient || !/^Success$/i.test(recipient.status)) {
    const reason = recipient?.status || payload?.SMSMessageData?.Message || 'unknown error';
    throw new AppError(`Africa's Talking SMS send failed: ${reason}`, 502);
  }

  return { provider: 'africastalking', id: recipient.messageId || null };
}

/**
 * Sends a single SMS through whichever provider is configured via
 * SMS_PROVIDER ('twilio' | 'africastalking'). This is the only function
 * the rest of the app should call — swapping providers is a config
 * change, not a code change.
 *
 * @param {{ to: string, message: string }} params
 *   to - E.164-formatted phone number (e.g. "+251911234567").
 *   message - SMS body text.
 * @returns {Promise<{ provider: string, id: string|null }>}
 */
async function sendSMS({ to, message }) {
  if (!to || !message) {
    throw new AppError('sendSMS requires both "to" and "message"', 422);
  }

  switch (env.sms.provider) {
    case 'twilio':
      return sendViaTwilio({ to, message });
    case 'africastalking':
      return sendViaAfricasTalking({ to, message });
    default:
      throw new AppError(`Unsupported SMS_PROVIDER: "${env.sms.provider}"`, 500);
  }
}

module.exports = { sendSMS };
