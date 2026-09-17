'use strict';

const { Schema, model } = require('mongoose');

const employerSchema = new Schema(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      unique: true, // one employer profile per user
    },
    companyName: {
      type: String,
      required: true,
      trim: true,
    },
    logoUrl: {
      type: String,
      trim: true,
      default: null,
    },
    backofficePhone: {
      type: String,
      trim: true,
      default: null,
    },
    promoDetails: {
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
    // Key of the `SubscriptionPlan` this employer is currently on (see
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

employerSchema.set('toJSON', {
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

module.exports = model('Employer', employerSchema);
