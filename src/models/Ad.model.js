'use strict';

const { Schema, model } = require('mongoose');

// Mirrors the material icon names the frontend's AdCarousel already
// knows how to render for its MockAds placeholder content (see
// kezerajobs-frontend-clean/lib/features/jobs/presentation/widgets/ad_carousel.dart).
// Kept as a fixed enum (rather than free-text) so an employer can't
// submit an icon name the app has no glyph for.
const AD_ICONS = [
  'campaign',
  'workspace_premium',
  'verified',
  'card_giftcard',
  'storefront',
  'local_offer',
  'star',
  'business_center',
];

// - draft            created but no successful payment yet
// - pending_review    paid, waiting on admin moderation
// - active            approved by admin, currently eligible to show
// - rejected          admin declined it (see rejectionReason)
// - expired           was active, ran past expiresAt
const AD_STATUSES = ['draft', 'pending_review', 'active', 'rejected', 'expired'];

/**
 * A promoted ad an employer or agency pays to run in the app's ad
 * carousel (see ads.service.js) — e.g. promoting their company, a
 * service, or a product, not tied to any specific job posting.
 *
 * Lifecycle: draft (assertCanAdvertise-gated create) -> payment via
 * POST /payments/initialize-ad -> pending_review (Chapa verified) ->
 * active (admin approves, expiresAt gets set) or rejected (admin
 * declines). `active` ads past their `expiresAt` are treated as
 * expired at read time (see the `isLive` virtual below) — same
 * "derive from a timestamp, don't keep a stale flag in sync" pattern
 * Seeker.model.js uses for `isBoosted`.
 */
const adSchema = new Schema(
  {
    // The User (employer or agency) this ad belongs to and paid for.
    ownerId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    ownerRole: {
      type: String,
      enum: ['employer', 'agency'],
      required: true,
    },
    title: {
      type: String,
      required: true,
      trim: true,
      maxlength: 60,
    },
    subtitle: {
      type: String,
      required: true,
      trim: true,
      maxlength: 140,
    },
    icon: {
      type: String,
      enum: AD_ICONS,
      default: 'campaign',
    },
    // Optional destination when the ad card is tapped — e.g. the
    // employer's public job board profile or an external site.
    linkUrl: {
      type: String,
      trim: true,
      default: null,
    },
    status: {
      type: String,
      enum: AD_STATUSES,
      default: 'draft',
    },
    // Set once admin approves — see ads.service.js#approveAd.
    expiresAt: {
      type: Date,
      default: null,
    },
    rejectionReason: {
      type: String,
      default: null,
    },
    // The verified Payment this ad's active run is funded by. Kept as
    // a reference (rather than duplicating amount/txRef here) so
    // Payment stays the single source of truth for money, same
    // division of concerns as Seeker.boostedUntil vs the 'boost'
    // Payment row that produced it.
    paymentId: {
      type: Schema.Types.ObjectId,
      ref: 'Payment',
      default: null,
    },
  },
  {
    timestamps: true,
  },
);

adSchema.index({ status: 1, expiresAt: 1 });

adSchema.set('toJSON', {
  virtuals: true,
  transform: (_doc, ret) => {
    ret.id = ret._id.toString();
    delete ret._id;
    delete ret.__v;
    ret.ownerId = ret.ownerId.toString();
    if (ret.paymentId) ret.paymentId = ret.paymentId.toString();
    // Computed rather than a stored flag — an `active` ad whose
    // `expiresAt` has passed is live=false without anything needing
    // to have gone back and flipped its status (a background sweep
    // can later batch-transition these to 'expired'; until then this
    // keeps reads correct regardless).
    ret.isLive = ret.status === 'active' && Boolean(ret.expiresAt) && new Date(ret.expiresAt) > new Date();
    return ret;
  },
});

module.exports = model('Ad', adSchema);
module.exports.AD_ICONS = AD_ICONS;
module.exports.AD_STATUSES = AD_STATUSES;
