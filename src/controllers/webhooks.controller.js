'use strict';

const smsInboundService = require('../services/smsInbound.service');

/**
 * POST /api/v1/webhooks/sms/receive?provider=twilio|africastalking
 *
 * Signature/secret already verified upstream by
 * middleware/smsWebhookAuth.middleware.js before this runs.
 *
 * Always acknowledges with 200 as fast as possible — both Twilio and
 * Africa's Talking retry a webhook delivery on anything other than a
 * prompt 2xx, and business-logic outcomes (unknown sender, no open
 * placement, a "no thanks" reply) are not delivery failures from the
 * gateway's point of view, so none of those should surface as
 * non-2xx responses.
 *
 * Twilio expects an empty `<Response/>` TwiML document when the app
 * isn't using TwiML to auto-reply (we reply out-of-band via
 * services/sms.service.js instead) — returning nothing/invalid XML can
 * surface as an error in the Twilio console even though the message
 * was still processed. Africa's Talking ignores the response body, so
 * a small JSON ack is sent there for anyone reading logs/traces.
 */
async function smsReceiveHandler(req, res, next) {
  try {
    const provider = req.query.provider;
    const result = await smsInboundService.processInboundSms(provider, req.body);

    if (provider === 'twilio') {
      return res.status(200).type('text/xml').send('<Response></Response>');
    }
    return res.status(200).json({ status: 'received', ...result });
  } catch (err) {
    return next(err);
  }
}

module.exports = { smsReceiveHandler };
