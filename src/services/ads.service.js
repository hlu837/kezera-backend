'use strict';

const { Ad, Employer, Agency } = require('../models');
const AppError = require('../errors/AppError');
const { getCanAdvertise } = require('./subscriptionPlan.service');
const { DEFAULT_TIER } = require('../utils/subscriptionTiers');

// How long an ad stays `active` once admin approves it. Flat, like
// BOOST_DURATION_MONTHS in payment.routes.js — no per-plan variation
// (that's what canAdvertise already gates; duration itself isn't a
// lever admin was asked to control yet).
const AD_DURATION_DAYS = 30;

/**
 * Looks up an employer/agency's `subscriptionTier` and throws unless
 * their tier currently entitles them to advertise (admin-controlled —
 * see SubscriptionPlan.model.js#canAdvertise). Checked both when an ad
 * is first created and again right before payment is initialized, so
 * an admin revoking a tier's advertising entitlement takes effect
 * immediately rather than only for brand-new ads.
 *
 * @param {string} ownerId - the User id
 * @param {'employer'|'agency'} ownerRole
 */
async function assertCanAdvertise(ownerId, ownerRole) {
  const Model = ownerRole === 'employer' ? Employer : Agency;
  const profile = await Model.findOne({ userId: ownerId }).select('subscriptionTier').lean();
  if (!profile) throw new AppError(`${ownerRole} profile not found`, 404);

  const tier = profile.subscriptionTier || DEFAULT_TIER;
  const canAdvertise = await getCanAdvertise(tier);
  if (!canAdvertise) {
    throw new AppError(
      `Your ${tier} plan does not include advertising. Upgrade to a plan that supports it, or contact support.`,
      403,
    );
  }
  return tier;
}

/**
 * POST /api/v1/ads
 * Creates an ad in `draft` status — not visible anywhere until it's
 * paid for (see initializeAdPayment in payment.routes.js) and then
 * approved by admin (see approveAd below).
 */
async function createAd(ownerId, ownerRole, payload) {
  await assertCanAdvertise(ownerId, ownerRole);

  const ad = await Ad.create({
    ownerId,
    ownerRole,
    title: payload.title,
    subtitle: payload.subtitle,
    icon: payload.icon || 'campaign',
    linkUrl: payload.link_url || null,
    status: 'draft',
  });
  return ad.toJSON();
}

/**
 * GET /api/v1/ads/mine — every ad the current employer/agency owns,
 * newest first, regardless of status (draft/pending/active/rejected/expired).
 */
async function listMyAds(ownerId) {
  const ads = await Ad.find({ ownerId }).sort({ createdAt: -1 });
  return ads.map((a) => a.toJSON());
}

/**
 * A single ad this owner is allowed to act on (pay for) — used by
 * payment.routes.js#initialize-ad so an employer can't pay for
 * someone else's ad by guessing an id.
 */
async function getOwnedAd(ownerId, adId) {
  const ad = await Ad.findOne({ _id: adId, ownerId });
  if (!ad) throw new AppError('Ad not found', 404);
  return ad;
}

/**
 * Called from payment.routes.js#/verify-callback once Chapa confirms
 * an 'ad' product payment succeeded — moves the ad from draft (or a
 * prior expired/rejected run being repaid) into pending_review, where
 * it waits for admin moderation before actually going live. Payment
 * alone does not make an ad visible; see approveAd.
 */
async function markAdPaid(adId, paymentId) {
  const ad = await Ad.findByIdAndUpdate(
    adId,
    { status: 'pending_review', paymentId, rejectionReason: null },
    { new: true },
  );
  if (!ad) throw new AppError('Ad not found', 404);
  return ad.toJSON();
}

/**
 * GET /api/v1/admin/ads?status=pending_review
 * Powers the admin moderation queue.
 */
async function listAdsForAdmin(status) {
  const query = status ? { status } : {};
  const ads = await Ad.find(query).sort({ createdAt: -1 });
  return ads.map((a) => a.toJSON());
}

/**
 * POST /api/v1/admin/ads/:adId/approve
 * Moves a paid (`pending_review`) ad to `active` and starts its
 * AD_DURATION_DAYS run from right now — not from when it was paid for,
 * so review turnaround time doesn't eat into what the employer paid for.
 */
async function approveAd(adId) {
  const ad = await Ad.findById(adId);
  if (!ad) throw new AppError('Ad not found', 404);
  if (ad.status !== 'pending_review') {
    throw new AppError(`Only a pending_review ad can be approved (this ad is ${ad.status})`, 422);
  }

  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + AD_DURATION_DAYS);

  ad.status = 'active';
  ad.expiresAt = expiresAt;
  ad.rejectionReason = null;
  await ad.save();
  return ad.toJSON();
}

/**
 * POST /api/v1/admin/ads/:adId/reject  { reason }
 * The employer/agency keeps the ad (and can see why it was rejected)
 * but it never goes live for this paid run — matches how
 * admin.service.js#rejectUser handles a rejected subscription: the
 * money isn't silently kept without explanation.
 */
async function rejectAd(adId, reason) {
  const ad = await Ad.findById(adId);
  if (!ad) throw new AppError('Ad not found', 404);
  if (ad.status !== 'pending_review') {
    throw new AppError(`Only a pending_review ad can be rejected (this ad is ${ad.status})`, 422);
  }

  ad.status = 'rejected';
  ad.rejectionReason = reason;
  await ad.save();
  return ad.toJSON();
}

/**
 * GET /api/v1/ads/active — public feed the frontend's AdCarousel reads
 * (see ad_carousel.dart's TODO about swapping MockAds for a real feed).
 * No auth required: seekers browsing the public job board see these
 * too. Only `active` ads whose `expiresAt` hasn't passed yet qualify —
 * filtered at the query level rather than relying on the `isLive`
 * virtual, since a background sweep to flip expired ads to `status:
 * 'expired'` doesn't exist yet.
 */
async function listActiveAds() {
  const ads = await Ad.find({ status: 'active', expiresAt: { $gt: new Date() } })
    .sort({ createdAt: -1 })
    .limit(20);
  return ads.map((a) => a.toJSON());
}

module.exports = {
  AD_DURATION_DAYS,
  assertCanAdvertise,
  createAd,
  listMyAds,
  getOwnedAd,
  markAdPaid,
  listAdsForAdmin,
  approveAd,
  rejectAd,
  listActiveAds,
};
