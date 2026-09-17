'use strict';

const { Schema, model } = require('mongoose');

/**
 * Replaces `inbound_sms_events` from 006_create_inbound_sms_events.sql.
 * One doc per inbound SMS webhook delivery actually processed — the
 * unique index on (provider, providerMessageId) is the idempotency
 * guard against gateway/carrier retries. See smsInbound.service.js.
 */
const inboundSmsEventSchema = new Schema(
  {
    provider: {
      type: String,
      required: true,
    },
    // Twilio's MessageSid / Africa's Talking's `id`, or (when the
    // provider didn't supply one) smsInbound.service.js's deterministic
    // fallback hash. Always present by the time this is written.
    providerMessageId: {
      type: String,
      required: true,
    },
    fromPhone: {
      type: String,
      required: true,
      // Occasionally useful for support/debugging ("what has this
      // number sent us").
      index: true,
    },
    body: {
      type: String,
      default: null,
    },
    seekerId: {
      type: Schema.Types.ObjectId,
      ref: 'Seeker',
      default: null,
    },
    placementId: {
      type: Schema.Types.ObjectId,
      ref: 'Placement',
      default: null,
    },
  },
  {
    // Only createdAt is meaningful here (mirrors the SQL table, which
    // had no updated_at column of its own) — attachEventContext() sets
    // seekerId/placementId after the initial insert without needing a
    // separate "last modified" timestamp.
    timestamps: { createdAt: true, updatedAt: false },
  },
);

inboundSmsEventSchema.index({ provider: 1, providerMessageId: 1 }, { unique: true });

inboundSmsEventSchema.set('toJSON', {
  virtuals: true,
  transform: (_doc, ret) => {
    ret.id = ret._id.toString();
    delete ret._id;
    delete ret.__v;
    return ret;
  },
});

module.exports = model('InboundSmsEvent', inboundSmsEventSchema);
