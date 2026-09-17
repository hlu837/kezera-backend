'use strict';

const crypto = require('crypto');
const { User, Seeker, Placement, InboundSmsEvent } = require('../models');
const { sendSMS } = require('./sms.service');
const { getJobAndPosterContact } = require('./notifications.service');
const AppError = require('../errors/AppError');

/** Replies counted as an acceptance of the matched job. */
const ACCEPTANCE_REPLIES = new Set(['1', 'YES', 'Y']);

/**
 * Extracts `{ fromPhone, text, providerMessageId }` out of a provider's
 * webhook payload shape. Twilio and Africa's Talking use different
 * field names for the same concepts, so this is the one place that
 * needs to know both.
 *
 * @param {'twilio'|'africastalking'} provider
 * @param {object} body - req.body (already form-decoded)
 * @returns {{ fromPhone: string, text: string, providerMessageId: string|null }}
 */
function normalizeInboundPayload(provider, body) {
  if (provider === 'twilio') {
    const fromPhone = body.From;
    const text = body.Body;
    if (!fromPhone || text === undefined) {
      throw new AppError('Twilio webhook payload is missing "From" or "Body"', 422);
    }
    return {
      fromPhone: String(fromPhone).trim(),
      text: String(text).trim(),
      providerMessageId: body.MessageSid || body.SmsMessageSid || null,
    };
  }

  if (provider === 'africastalking') {
    const fromPhone = body.from;
    const text = body.text;
    if (!fromPhone || text === undefined) {
      throw new AppError('Africa\'s Talking webhook payload is missing "from" or "text"', 422);
    }
    return {
      fromPhone: String(fromPhone).trim(),
      text: String(text).trim(),
      providerMessageId: body.id || null,
    };
  }

  throw new AppError(`Unsupported SMS provider: ${provider}`, 400);
}

/**
 * Reduces a phone number to its last 9 digits for comparison, so
 * "+251911234567", "0911234567", and "251911234567" — all plausible
 * representations of the same Ethiopian number depending on which
 * system produced them — are recognized as the same subscriber. 9
 * digits comfortably covers a national subscriber number without the
 * country/trunk prefix for the markets this app targets; adjust if
 * expanding to markets with longer local numbers.
 *
 * @param {string} phone
 * @returns {string}
 */
function last9Digits(phone) {
  return String(phone || '').replace(/\D/g, '').slice(-9);
}

/**
 * Records that this webhook delivery was processed, as an idempotency
 * guard against gateway retries (and, rarely, genuine carrier-level SMS
 * redelivery). Returns `{ isDuplicate: true }` without inserting
 * anything if this exact delivery was already recorded — driven here
 * by catching the unique-index violation on (provider,
 * providerMessageId) rather than a separate existence check, mirroring
 * the old `ON CONFLICT ... DO NOTHING` in a single round trip.
 *
 * When the provider didn't supply a message id (some Africa's Talking
 * callback configs omit `id`), falls back to a deterministic hash of
 * (provider, from, text, 2-minute time bucket) — good enough to catch
 * back-to-back retries of the same delivery without a real id, without
 * permanently blocking a legitimate later message that happens to have
 * identical text.
 *
 * @param {'twilio'|'africastalking'} provider
 * @param {string} fromPhone
 * @param {string} text
 * @param {string|null} providerMessageId
 * @returns {Promise<{ isDuplicate: boolean, eventId: string|null }>}
 */
async function recordInboundEventOnce(provider, fromPhone, text, providerMessageId) {
  const dedupeId = providerMessageId
    || crypto
      .createHash('sha256')
      .update(`${provider}:${fromPhone}:${text}:${Math.floor(Date.now() / 120000)}`)
      .digest('hex');

  try {
    const event = await InboundSmsEvent.create({
      provider,
      providerMessageId: dedupeId,
      fromPhone,
      body: text,
    });
    return { isDuplicate: false, eventId: event.id };
  } catch (err) {
    if (err.code === 11000) {
      return { isDuplicate: true, eventId: null };
    }
    throw err;
  }
}

/**
 * Attaches the resolved seeker/placement to an already-recorded
 * inbound event, for debugging/support lookups. Best-effort — failure
 * here should never fail the webhook response.
 *
 * @param {string} eventId
 * @param {string|null} seekerId
 * @param {string|null} placementId
 */
async function attachEventContext(eventId, seekerId, placementId) {
  try {
    await InboundSmsEvent.updateOne(
      { _id: eventId },
      { $set: { seekerId: seekerId || null, placementId: placementId || null } },
    );
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[smsInbound.service] failed to attach event context', err);
  }
}

/**
 * Finds the seeker (and their user id) whose phone number matches the
 * inbound SMS's sender, tolerant of formatting differences (see
 * `last9Digits`). Backed by `User.phoneLast9`, a derived field kept in
 * sync on write (see models/User.model.js) — this is a plain indexed
 * equality lookup rather than a per-query regex/normalize scan.
 *
 * @param {string} phone
 * @returns {Promise<{ seekerId: string, userId: string, fullName: string }|null>}
 */
async function findSeekerByPhone(phone) {
  const target = last9Digits(phone);
  if (!target) return null;

  const user = await User.findOne({ phoneLast9: target }).select('_id');
  if (!user) return null;

  const seeker = await Seeker.findOne({ userId: user._id }).select('fullName');
  if (!seeker) return null;

  return { seekerId: seeker.id, userId: user._id.toString(), fullName: seeker.fullName };
}

/**
 * Finds the seeker's most relevant placement to interpret this reply
 * against: prefers one still awaiting a response (`status: 'matched'`)
 * over older resolved ones, falling back to the most recent placement
 * of any status if none are currently awaiting a reply (so a duplicate
 * or late "YES" for an already-processed placement can still be
 * recognized and logged, rather than treated as a total non-match).
 *
 * Implemented as two queries rather than one aggregation — simpler to
 * read, and each query is a single indexed lookup either way.
 *
 * @param {string} seekerId
 * @returns {Promise<object|null>}
 */
async function findLatestPlacementForSeeker(seekerId) {
  const openPlacement = await Placement.findOne({ seekerId, status: 'matched' }).sort({ createdAt: -1 });
  if (openPlacement) return openPlacement.toJSON();

  const anyPlacement = await Placement.findOne({ seekerId }).sort({ createdAt: -1 });
  return anyPlacement ? anyPlacement.toJSON() : null;
}

/**
 * Transitions a placement from 'matched' to 'sent'. Guarded by
 * `status: 'matched'` in the filter — same pattern as
 * placements.service.js#saveMatchedPlacements — so a duplicate
 * acceptance reply (or one arriving after the placement already moved
 * on to 'hired'/'rejected' some other way) is a no-op, not a regression.
 *
 * @param {string} placementId
 * @returns {Promise<object|null>} the updated doc, or null if the guard didn't match
 */
async function acceptPlacement(placementId) {
  const updated = await Placement.findOneAndUpdate(
    { _id: placementId, status: 'matched' },
    { $set: { status: 'sent' } },
    { new: true },
  );
  return updated ? updated.toJSON() : null;
}

/**
 * @param {string} text
 * @returns {boolean}
 */
function isAcceptanceReply(text) {
  return ACCEPTANCE_REPLIES.has(String(text || '').trim().toUpperCase());
}

/**
 * Builds the confirmation SMS sent back to a candidate who accepted.
 *
 * @param {{ employerName: string, jobTitle: string }} params
 * @returns {string}
 */
function buildConfirmationSms({ employerName, jobTitle }) {
  return `You're confirmed for the ${jobTitle} role at ${employerName}. `
    + 'They now have your profile and will reach out directly with next steps. Good luck!';
}

/**
 * End-to-end handler for a single inbound SMS webhook delivery, called
 * by controllers/webhooks.controller.js after signature verification
 * has already passed.
 *
 * Flow:
 *   1. Normalize the provider-specific payload.
 *   2. Idempotency check — duplicates short-circuit here.
 *   3. Resolve sender phone -> seeker -> their latest placement.
 *   4. If the reply is an acceptance ("1"/"YES") and that placement is
 *      still 'matched', flip it to 'sent' and text back a confirmation
 *      with next steps + employer name.
 *   5. Anything else (unrecognized seeker, no placement, a non-
 *      acceptance reply) is logged and acknowledged without error —
 *      none of those are the gateway's fault, so the webhook still
 *      succeeds.
 *
 * @param {'twilio'|'africastalking'} provider
 * @param {object} rawBody - req.body
 * @returns {Promise<{
 *   duplicate: boolean,
 *   seekerFound: boolean,
 *   placementFound: boolean,
 *   accepted: boolean,
 *   confirmationSent: boolean,
 * }>}
 */
async function processInboundSms(provider, rawBody) {
  const { fromPhone, text, providerMessageId } = normalizeInboundPayload(provider, rawBody);

  const { isDuplicate, eventId } = await recordInboundEventOnce(
    provider,
    fromPhone,
    text,
    providerMessageId,
  );
  if (isDuplicate) {
    // eslint-disable-next-line no-console
    console.log(`[smsInbound.service] duplicate delivery ignored: provider=${provider} from=${fromPhone}`);
    return {
      duplicate: true, seekerFound: false, placementFound: false, accepted: false, confirmationSent: false,
    };
  }

  const seeker = await findSeekerByPhone(fromPhone);
  if (!seeker) {
    // eslint-disable-next-line no-console
    console.warn(`[smsInbound.service] no seeker found for inbound SMS from=${fromPhone}`);
    return {
      duplicate: false, seekerFound: false, placementFound: false, accepted: false, confirmationSent: false,
    };
  }

  const placement = await findLatestPlacementForSeeker(seeker.seekerId);
  await attachEventContext(eventId, seeker.seekerId, placement?.id || null);
  if (!placement) {
    // eslint-disable-next-line no-console
    console.warn(`[smsInbound.service] seeker ${seeker.seekerId} has no placements; reply="${text}"`);
    return {
      duplicate: false, seekerFound: true, placementFound: false, accepted: false, confirmationSent: false,
    };
  }

  if (!isAcceptanceReply(text)) {
    // eslint-disable-next-line no-console
    console.log(
      `[smsInbound.service] non-acceptance reply from seeker ${seeker.seekerId} `
      + `on placement ${placement.id}: "${text}"`,
    );
    return {
      duplicate: false, seekerFound: true, placementFound: true, accepted: false, confirmationSent: false,
    };
  }

  const updatedPlacement = await acceptPlacement(placement.id);
  if (!updatedPlacement) {
    // Placement existed but wasn't in 'matched' status anymore (already
    // accepted, or moved further along some other way) — accepting is
    // a no-op, and we deliberately don't re-send the confirmation SMS
    // for what's likely a duplicate "YES".
    // eslint-disable-next-line no-console
    console.log(
      `[smsInbound.service] placement ${placement.id} was not 'matched' `
      + '(already processed); skipping status change and confirmation SMS',
    );
    return {
      duplicate: false, seekerFound: true, placementFound: true, accepted: false, confirmationSent: false,
    };
  }

  let confirmationSent = false;
  try {
    const { jobTitle, posterName } = await getJobAndPosterContact(updatedPlacement.jobId);
    await sendSMS({
      to: fromPhone,
      message: buildConfirmationSms({ employerName: posterName, jobTitle }),
    });
    confirmationSent = true;
  } catch (err) {
    // The placement transition already succeeded and must not be
    // rolled back over a failed confirmation text — that's a
    // best-effort courtesy message, not the source of truth.
    // eslint-disable-next-line no-console
    console.error(
      `[smsInbound.service] placement ${placement.id} accepted but confirmation SMS failed:`,
      err.message,
    );
  }

  // eslint-disable-next-line no-console
  console.log(
    `[smsInbound.service] placement ${placement.id} accepted by seeker ${seeker.seekerId} `
    + `(job ${updatedPlacement.jobId}); confirmation_sent=${confirmationSent}`,
  );

  return {
    duplicate: false, seekerFound: true, placementFound: true, accepted: true, confirmationSent,
  };
}

module.exports = {
  processInboundSms,
  normalizeInboundPayload,
  isAcceptanceReply,
  buildConfirmationSms,
  findSeekerByPhone,
  findLatestPlacementForSeeker,
};
