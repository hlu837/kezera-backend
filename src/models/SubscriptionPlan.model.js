'use strict';

const { Schema, model } = require('mongoose');

/**
 * A fully admin-authored subscription plan for employers/agencies.
 *
 * Unlike the old version of this model (one fixed document per
 * hardcoded tier — 'basic'/'premium'/'enterprise'), admin can create,
 * edit, reorder, and delete as many plans as they want here, each with
 * its own name, price, and benefits list, in addition to the
 * enforcement limits (job posting cap, advertising, candidate-search
 * visibility, AI applicant-summary cap) that actually gate behavior
 * elsewhere in the app.
 *
 * `key` is the stable identifier stored on `Employer.subscriptionTier`
 * / `Agency.subscriptionTier` (that field name is unchanged to avoid
 * touching every call site — it now just holds a plan `key` rather
 * than one of three hardcoded strings). Renaming a plan's *display*
 * name never breaks existing subscribers because `key` never changes
 * on edit, only on create.
 *
 * `subscriptionPlan.service.js` reads this collection fresh on every
 * check (see e.g. jobs.service.js#assertWithinJobPostingLimit) — no
 * caching — so an admin edit takes effect immediately for every
 * account already on that plan, without needing individual accounts
 * to be touched.
 */
const subscriptionPlanSchema = new Schema(
  {
    // Stable identifier, chosen once at creation (slug-like). This is
    // what gets stored on an Employer/Agency's `subscriptionTier`
    // field — never shown to the end user, `name` is.
    key: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      lowercase: true,
      match: /^[a-z0-9-]+$/,
    },
    // Display name shown to admin and (eventually) to employers/
    // agencies choosing a plan, e.g. "Premium".
    name: {
      type: String,
      required: true,
      trim: true,
    },
    // Short admin-facing description of who the plan is for.
    description: {
      type: String,
      trim: true,
      default: '',
    },
    // Which account types can subscribe to this plan.
    audience: {
      type: String,
      enum: ['employer', 'agency', 'both'],
      default: 'both',
    },
    price: {
      type: Number,
      required: true,
      min: 0,
      default: 0,
    },
    currency: {
      type: String,
      trim: true,
      default: 'ETB',
    },
    billingCycle: {
      type: String,
      enum: ['monthly', 'yearly'],
      default: 'monthly',
    },
    // The benefits list shown on the plan card — free-form text lines
    // fully authored by admin (e.g. "Up to 15 open jobs", "Priority
    // support"). Purely presentational; the actual enforcement is the
    // fields below.
    features: {
      type: [String],
      default: [],
    },
    // Max simultaneously-`open` jobs an account on this plan may have
    // (see jobs.service.js#assertWithinJobPostingLimit). `null` = unlimited.
    maxOpenJobs: {
      type: Number,
      default: null,
      min: 0,
    },
    // Whether an account on this plan is entitled to run promoted ads
    // (see ads.service.js#assertCanAdvertise).
    canAdvertise: {
      type: Boolean,
      default: false,
    },
    // Candidate-search caps (see seeker.service.js#searchSeekers).
    // `maxVisibleResults: null` = no depth cap.
    maxPageSize: {
      type: Number,
      default: 10,
      min: 1,
    },
    maxVisibleResults: {
      type: Number,
      default: 20,
      min: 0,
    },
    // Cap on how many applicants get an AI-generated summary per job
    // (see applicationSummary.service.js). `null` = unlimited.
    applicationSummaryLimit: {
      type: Number,
      default: 15,
      min: 0,
    },
    // Whether this plan can currently be selected/assigned. Existing
    // subscribers on a deactivated plan keep their entitlements —
    // deactivating only hides it from new selection.
    isActive: {
      type: Boolean,
      default: true,
    },
    // Exactly one plan should be the default new employer/agency
    // accounts land on, and the fallback used when an account's stored
    // plan key doesn't match any plan (e.g. after that plan was
    // deleted). Enforced in subscriptionPlan.service.js, not here.
    isDefault: {
      type: Boolean,
      default: false,
    },
    // Display order in the admin console and (eventually) any public
    // pricing page — ascending.
    sortOrder: {
      type: Number,
      default: 0,
    },
  },
  {
    timestamps: true,
  },
);

subscriptionPlanSchema.set('toJSON', {
  virtuals: true,
  transform: (_doc, ret) => {
    ret.id = ret._id.toString();
    delete ret._id;
    delete ret.__v;
    return ret;
  },
});

module.exports = model('SubscriptionPlan', subscriptionPlanSchema);
