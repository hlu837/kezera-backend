'use strict';

/**
 * Last-resort fallback plan key. Mirrors the `default: 'basic'` on
 * both Employer.model.js and Agency.model.js — used only when a
 * profile is somehow missing a `subscriptionTier` value entirely
 * (e.g. a legacy record from before the field existed) or when
 * resolving a tier for a non-employer/agency caller.
 *
 * Everything about what a plan actually grants (job posting limit,
 * advertising, candidate-search depth, AI summary cap, price,
 * benefits list) is now fully admin-editable at runtime via
 * `subscriptionPlan.service.js` / the `SubscriptionPlan` collection —
 * this file no longer hardcodes any of that.
 */
const DEFAULT_TIER = 'basic';

module.exports = {
  DEFAULT_TIER,
};
