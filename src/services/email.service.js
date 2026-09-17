'use strict';

const fetch = require('node-fetch');
const env = require('../config/env');
const AppError = require('../errors/AppError');

const SENDGRID_ENDPOINT = 'https://api.sendgrid.com/v3/mail/send';

/**
 * Sends a single HTML email via SendGrid's v3 REST API
 * (https://docs.sendgrid.com/api-reference/mail-send/mail-send).
 * Talks to the REST API directly with the existing node-fetch
 * dependency rather than pulling in @sendgrid/mail, keeping this
 * consistent with the rest of the app's "no SDK unless already
 * required" footprint (see storage.service.js's direct use of the S3
 * SDK vs. this file's direct HTTP call).
 *
 * A Nodemailer-based transport is a drop-in alternative if the project
 * ever needs SMTP instead of the SendGrid API (e.g. a different ESP) —
 * swap this function's body for a `nodemailer.createTransport(...)`
 * call without touching any caller, since they only depend on the
 * `sendEmail({ to, subject, htmlBody })` signature below.
 *
 * @param {{ to: string, subject: string, htmlBody: string }} params
 * @returns {Promise<{ provider: 'sendgrid', messageId: string|null }>}
 */
async function sendEmail({ to, subject, htmlBody }) {
  if (!to || !subject || !htmlBody) {
    throw new AppError('sendEmail requires "to", "subject", and "htmlBody"', 422);
  }

  const { sendgridApiKey, fromEmail, fromName } = env.email;
  if (!sendgridApiKey) {
    throw new AppError('SendGrid is not configured: missing SENDGRID_API_KEY', 500);
  }

  const response = await fetch(SENDGRID_ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${sendgridApiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: to }] }],
      from: { email: fromEmail, name: fromName },
      subject,
      content: [{ type: 'text/html', value: htmlBody }],
    }),
  });

  // SendGrid returns 202 with an empty body on success and puts the
  // message id in a response header rather than JSON.
  if (!response.ok) {
    const errorBody = await response.text().catch(() => '');
    throw new AppError(`SendGrid email send failed (${response.status}): ${errorBody}`, 502);
  }

  return { provider: 'sendgrid', messageId: response.headers.get('x-message-id') || null };
}

module.exports = { sendEmail };
