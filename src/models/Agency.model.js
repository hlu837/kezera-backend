'use strict';

const { Schema, model } = require('mongoose');

const agencySchema = new Schema(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      unique: true, // one agency profile per user
    },
    agencyName: {
      type: String,
      required: true,
      trim: true,
    },
    ledgerBalance: {
      type: Number,
      default: 0, // running balance used by payout/withdrawal logic elsewhere
      min: 0,
    },
    operationalCity: {
      type: String,
      trim: true,
      default: null,
    },
    // Account-related contact number, editable from the agency's own
    // account screen (see agency.service.js#updateMyProfile) — mirrors
    // Employer.backofficePhone.
    backofficePhone: {
      type: String,
      trim: true,
      default: null,
    },
    tinNumber: {
      type: String,
      trim: true,
      default: null,
    },
    businessLicenseUrl: {
      type: String,
      trim: true,
      default: null,
    },
    // Public-profile fields, editable from the agency's own account
    // screen — separate from the KYC/verification fields above
    // (tinNumber/businessLicenseUrl), which are set at registration and
    // reviewed by an admin. `bio` mirrors Employer.promoDetails; `logoUrl`
    // mirrors Employer.logoUrl and is only ever set server-side via the
    // logo upload endpoint (see agency.service.js#uploadLogo), never
    // accepted as a plain string field.
    bio: {
      type: String,
      trim: true,
      default: null,
    },
    logoUrl: {
      type: String,
      trim: true,
      default: null,
    },
    // Key of the `SubscriptionPlan` this agency is currently on (see
    // SubscriptionPlan.model.js). Not enum-restricted here — admin can
    // create/rename/delete plans at runtime, so validity is checked
    // against the live plan list where this is written, not baked into
    // the schema. Unrecognized/legacy values fall back to the default
    // plan wherever this is read (see subscriptionPlan.service.js).
    subscriptionTier: {
      type: String,
      trim: true,
      lowercase: true,
      default: 'basic',
    },
  },
  {
    timestamps: true,
  },
);

agencySchema.set('toJSON', {
  virtuals: true,
  transform: (_doc, ret) => {
    ret.id = ret._id.toString();
    delete ret._id;
    delete ret.__v;
    // Stringify explicitly so downstream code can key/compare against
    // it as a plain string (e.g. notifications.service.js building a
    // Map keyed by user id) rather than a live ObjectId instance.
    if (ret.userId) {
      ret.userId = ret.userId.toString();
    }
    return ret;
  },
});

module.exports = model('Agency', agencySchema);
