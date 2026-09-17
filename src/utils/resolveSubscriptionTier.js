'use strict';

const { Employer, Agency } = require('../models');
const { DEFAULT_TIER } = require('./subscriptionTiers');

/**
 * Looks up the calling employer/agency's `subscriptionTier`. Shared by
 * every feature gated by tier — seeker.service.js#searchSeekers (candidate
 * search) and applicationSummary.service.js (applicant-summary caps) both
 * use this rather than keeping their own copy.
 *
 * Falls back to `DEFAULT_TIER` ('basic') for a seeker/admin caller
 * (shouldn't happen — the routes calling this are role-guarded) or a
 * profile that can't be found, same "fail closed to the most
 * restrictive tier" posture as everywhere else a missing value is
 * treated as the least-privileged option.
 *
 * @param {{ id: string, role: 'employer'|'agency'|'admin'|'seeker' }} [requester]
 * @returns {Promise<'basic'|'premium'|'enterprise'>}
 */
async function resolveSubscriptionTier(requester) {
  if (!requester) {
    return DEFAULT_TIER;
  }

  const Model = requester.role === 'agency' ? Agency : Employer;
  const profile = await Model.findOne({ userId: requester.id }).select('subscriptionTier');
  return profile?.subscriptionTier || DEFAULT_TIER;
}

module.exports = { resolveSubscriptionTier };
