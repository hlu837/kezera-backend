'use strict';

const { Router } = require('express');
const { authenticate } = require('../middleware/auth.middleware');
const { authorizeRoles } = require('../middleware/rbac.middleware');
const chapaService = require('../services/chapa.service');
const { User, Employer, Agency, Seeker, Payment } = require('../models');
const adsService = require('../services/ads.service');
const subscriptionPlanService = require('../services/subscriptionPlan.service');
const AppError = require('../errors/AppError');

const router = Router();

// Subscription pricing now comes from the admin-managed SubscriptionPlan
// collection (see subscriptionPlan.service.js#getPlanByKey) rather than
// a hardcoded table — an admin editing a plan's price takes effect on
// the very next checkout, no deploy needed.

// SEEK-xx "Boost my profile": flat-rate, no plan selection — a seeker
// pays this once to jump ahead of non-boosted seekers in employer/agency
// candidate search (see seeker.service.js#searchSeekers) for
// BOOST_DURATION_MONTHS.
const BOOST_PRICE = 10;
const BOOST_DURATION_MONTHS = 6;

// AD-xx "Advertise on the app": flat-rate per ad run, paid by an
// employer/agency whose subscription tier's `canAdvertise` is enabled
// (admin-controlled — see SubscriptionPlan.model.js). Unlike boost,
// this requires an existing draft Ad (created via POST /api/v1/ads)
// to attach the payment to, hence the extra `adId` in the request body.
const AD_PRICE = 15;

// Every txRef this router hands to Chapa is prefixed by product so
// /verify-callback (a single shared return URL) can tell which product
// a completed payment was for without a separate lookup table.
const TX_REF_PREFIX = {
  subscription: 'KZ',
  boost: 'KZ-BOOST',
  ad: 'KZ-AD',
};

// Domains reserved for documentation/testing (RFC 2606 + common
// placeholders). Chapa rejects these outright with an opaque
// `validation.email`-style error, so we catch them here and fail with
// a message that actually explains what's wrong.
const RESERVED_EMAIL_DOMAINS = ['example.com', 'example.net', 'example.org', 'test.com'];

function assertRealEmail(user) {
  if (!user.email) {
    throw new AppError(
      'Your account has no email on file, which is required to process payment. Please contact support to add one.',
      422,
    );
  }
  const domain = user.email.split('@')[1]?.toLowerCase();
  if (domain && RESERVED_EMAIL_DOMAINS.includes(domain)) {
    throw new AppError(
      `Your account email (${user.email}) uses a reserved test domain that Chapa will not accept for real payments. Please update your account to a real email address before boosting or subscribing.`,
      422,
    );
  }
}

/**
 * POST /api/v1/payments/initialize-subscription
 * Initializes a Chapa transaction for the authenticated employer or agency.
 */
router.post(
  '/initialize-subscription',
  authenticate,
  authorizeRoles('employer', 'agency'),
  async (req, res, next) => {
    try {
      const { plan } = req.body;
      const selectedPlanKey = (plan || 'basic').toLowerCase();
      const selectedPlan = await subscriptionPlanService.getPlanByKey(selectedPlanKey);
      if (String(plan || '').toLowerCase() && selectedPlan.key !== selectedPlanKey) {
        // getPlanByKey silently falls back to the default plan for an
        // unknown key — for a checkout (real money) that ambiguity
        // isn't acceptable, so surface it as a client error instead.
        throw new AppError(`Unknown plan "${plan}"`, 422);
      }
      if (!selectedPlan.isActive) {
        throw new AppError(`Plan "${selectedPlan.key}" is no longer available for new subscriptions`, 422);
      }
      const amount = selectedPlan.price;

      const user = await User.findById(req.user.id);
      if (!user) throw new AppError('User not found', 404);
      assertRealEmail(user);

      // Save selected plan to profile
      const Model = req.user.role === 'employer' ? Employer : Agency;
      await Model.findOneAndUpdate({ userId: req.user.id }, { subscriptionTier: selectedPlan.key });

      const txRef = `${TX_REF_PREFIX.subscription}-${req.user.role.toUpperCase()}-${req.user.id.slice(-6)}-${Date.now()}`;

      const { checkoutUrl, isSimulated } = await chapaService.initializePayment({
        amount,
        currency: selectedPlan.currency || 'ETB',
        email: user.email,
        firstName: req.user.role === 'employer' ? 'Employer' : 'Agency',
        lastName: user.id,
        txRef,
        returnUrl: `${req.protocol}://${req.get('host')}/api/v1/payments/verify-callback?tx_ref=${txRef}&userId=${user.id}`,
      });

      // Record the transaction so it can be looked up later — most
      // importantly by admin.service.js#rejectUser, which needs a
      // stored txRef/amount to refund against once this payment is
      // verified below. Nothing before this persisted a payment row at
      // all; verify-callback just flipped verificationStatus directly.
      await Payment.create({
        userId: user.id,
        role: req.user.role,
        product: 'subscription',
        plan: selectedPlan.key,
        amount,
        currency: selectedPlan.currency || 'ETB',
        txRef,
        status: 'initialized',
      });

      return res.status(200).json({
        status: 'success',
        data: {
          checkoutUrl,
          txRef,
          plan: selectedPlan,
          amount,
          isSimulated,
        },
      });
    } catch (err) {
      return next(err);
    }
  },
);

/**
 * POST /api/v1/payments/initialize-boost
 * SEEK-xx: initializes a Chapa transaction for the authenticated seeker
 * to boost their own profile's visibility in candidate search for
 * BOOST_DURATION_MONTHS. Flat rate — no plan/body needed, unlike
 * /initialize-subscription above.
 */
router.post(
  '/initialize-boost',
  authenticate,
  authorizeRoles('seeker'),
  async (req, res, next) => {
    try {
      const user = await User.findById(req.user.id);
      if (!user) throw new AppError('User not found', 404);
      assertRealEmail(user);

      const seeker = await Seeker.findOne({ userId: req.user.id }).select('_id');
      if (!seeker) throw new AppError('Seeker profile not found', 404);

      const txRef = `${TX_REF_PREFIX.boost}-${req.user.id.slice(-6)}-${Date.now()}`;

      const { checkoutUrl, isSimulated } = await chapaService.initializePayment({
        amount: BOOST_PRICE,
        currency: 'ETB',
        email: user.email,
        firstName: 'Seeker',
        lastName: user.id,
        txRef,
        returnUrl: `${req.protocol}://${req.get('host')}/api/v1/payments/verify-callback?tx_ref=${txRef}&userId=${user.id}`,
      });

      return res.status(200).json({
        status: 'success',
        data: {
          checkoutUrl,
          txRef,
          amount: BOOST_PRICE,
          durationMonths: BOOST_DURATION_MONTHS,
          isSimulated,
        },
      });
    } catch (err) {
      return next(err);
    }
  },
);

/**
 * POST /api/v1/payments/initialize-ad  { adId }
 * AD-xx: initializes a Chapa transaction for the authenticated
 * employer/agency to pay for one of their own `draft` ads (created via
 * POST /api/v1/ads). Re-checks advertising eligibility here (not just
 * at ad creation) so a tier's `canAdvertise` being revoked by admin in
 * between blocks payment too, not just new ad creation.
 */
router.post(
  '/initialize-ad',
  authenticate,
  authorizeRoles('employer', 'agency'),
  async (req, res, next) => {
    try {
      const { adId } = req.body;
      if (!adId) throw new AppError('adId is required', 422);

      await adsService.assertCanAdvertise(req.user.id, req.user.role);
      const ad = await adsService.getOwnedAd(req.user.id, adId);
      if (ad.status !== 'draft' && ad.status !== 'rejected') {
        throw new AppError(
          `This ad is already ${ad.status} and can't be paid for again right now.`,
          422,
        );
      }

      const user = await User.findById(req.user.id);
      if (!user) throw new AppError('User not found', 404);
      assertRealEmail(user);

      const txRef = `${TX_REF_PREFIX.ad}-${req.user.id.slice(-6)}-${Date.now()}`;

      const { checkoutUrl, isSimulated } = await chapaService.initializePayment({
        amount: AD_PRICE,
        currency: 'ETB',
        email: user.email,
        firstName: req.user.role === 'employer' ? 'Employer' : 'Agency',
        lastName: user.id,
        txRef,
        returnUrl: `${req.protocol}://${req.get('host')}/api/v1/payments/verify-callback?tx_ref=${txRef}&userId=${user.id}&adId=${ad.id}`,
      });

      await Payment.create({
        userId: user.id,
        role: req.user.role,
        product: 'ad',
        adId: ad.id,
        amount: AD_PRICE,
        currency: 'ETB',
        txRef,
        status: 'initialized',
      });

      return res.status(200).json({
        status: 'success',
        data: {
          checkoutUrl,
          txRef,
          adId: ad.id,
          amount: AD_PRICE,
          durationDays: adsService.AD_DURATION_DAYS,
          isSimulated,
        },
      });
    } catch (err) {
      return next(err);
    }
  },
);

/**
 * GET /api/v1/payments/verify-callback
 * Redirect/return target after Chapa payment completion — shared by
 * both /initialize-subscription and /initialize-boost above. Branches
 * on the `tx_ref` prefix (see TX_REF_PREFIX) to know which product to
 * apply the completed payment to.
 */
router.get('/verify-callback', async (req, res, next) => {
  try {
    const { tx_ref: txRef, userId, adId } = req.query;
    if (!userId) throw new AppError('Missing userId parameter', 400);

    const verified = await chapaService.verifyPayment(txRef);
    if (!verified) {
      return res.status(400).send('<h2>Payment verification failed. Please try again.</h2>');
    }

    const isBoostPayment = typeof txRef === 'string' && txRef.startsWith(`${TX_REF_PREFIX.boost}-`);
    const isAdPayment = typeof txRef === 'string' && txRef.startsWith(`${TX_REF_PREFIX.ad}-`);

    if (isAdPayment) {
      const payment = await Payment.findOneAndUpdate(
        { txRef },
        { status: 'verified' },
        { new: true },
      );
      // Paid, but not live yet — an admin still has to approve it (see
      // ads.service.js#approveAd) before it appears in the carousel.
      await adsService.markAdPaid(adId, payment?.id);

      return res.send(`
        <!DOCTYPE html>
        <html>
        <head>
          <title>Ad Submitted</title>
          <style>
            body { font-family: sans-serif; background: #F4F6F5; color: #16191A; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
            .card { background: #FFFFFF; border: 1px solid #E0E4E1; padding: 40px; border-radius: 20px; text-align: center; max-width: 400px; }
            .icon { font-size: 50px; color: #0CAA41; margin-bottom: 20px; }
            h2 { margin-top: 0; }
            p { color: #565F63; line-height: 1.5; }
            button { background: #0CAA41; color: white; border: none; padding: 12px 24px; border-radius: 10px; font-weight: bold; cursor: pointer; margin-top: 20px; }
          </style>
        </head>
        <body>
          <div class="card">
            <div class="icon">📣</div>
            <h2>Payment received!</h2>
            <p>Your ad is now awaiting admin review. Once approved, it'll go live in the app for ${adsService.AD_DURATION_DAYS} days.</p>
            <button onclick="window.close()">Return to App</button>
          </div>
        </body>
        </html>
      `);
    }

    if (isBoostPayment) {
      // Extend from `now`, not from any previous `boostedUntil` — a
      // seeker re-boosting before expiry gets a fresh 6 months from
      // today rather than the two windows stacking, which keeps this
      // in line with how the employer/agency subscription flow below
      // also just overwrites (rather than accumulates) on each payment.
      const boostedUntil = new Date();
      boostedUntil.setMonth(boostedUntil.getMonth() + BOOST_DURATION_MONTHS);
      await Seeker.findOneAndUpdate({ userId }, { boostedUntil });

      return res.send(`
        <!DOCTYPE html>
        <html>
        <head>
          <title>Boost Activated</title>
          <style>
            body { font-family: sans-serif; background: #F4F6F5; color: #16191A; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
            .card { background: #FFFFFF; border: 1px solid #E0E4E1; padding: 40px; border-radius: 20px; text-align: center; max-width: 400px; }
            .icon { font-size: 50px; color: #0CAA41; margin-bottom: 20px; }
            h2 { margin-top: 0; }
            p { color: #565F63; line-height: 1.5; }
            button { background: #0CAA41; color: white; border: none; padding: 12px 24px; border-radius: 10px; font-weight: bold; cursor: pointer; margin-top: 20px; }
          </style>
        </head>
        <body>
          <div class="card">
            <div class="icon">🚀</div>
            <h2>Profile Boosted!</h2>
            <p>Your profile will be shown ahead of other candidates in employer and agency searches for the next ${BOOST_DURATION_MONTHS} months.</p>
            <button onclick="window.close()">Return to App</button>
          </div>
        </body>
        </html>
      `);
    }

    // Mark the stored payment row 'verified' so admin.service.js#rejectUser
    // has something to refund against if this employer/agency is later
    // rejected. Best-effort — a missing row (e.g. a payment initialized
    // before this tracking existed) shouldn't block verification from
    // proceeding, just means there's nothing to auto-refund later.
    await Payment.findOneAndUpdate({ txRef }, { status: 'verified' });

    // Update status to 'pending' review for admin approval!
    await User.findByIdAndUpdate(userId, {
      verificationStatus: 'pending',
    });

    return res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>Payment Successful</title>
        <style>
          body { font-family: sans-serif; background: #0F0F1A; color: white; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
          .card { background: #1A1A2E; padding: 40px; border-radius: 20px; text-align: center; max-width: 400px; }
          .icon { font-size: 50px; color: #4CAF50; margin-bottom: 20px; }
          h2 { margin-top: 0; }
          p { color: #888; line-height: 1.5; }
          button { background: #7B8CDE; color: white; border: none; padding: 12px 24px; border-radius: 10px; font-weight: bold; cursor: pointer; margin-top: 20px; }
        </style>
      </head>
      <body>
        <div class="card">
          <div class="icon">✓</div>
          <h2>Payment Successful!</h2>
          <p>Your subscription payment has been received. Your account application is now in <strong>Pending Review</strong> and sent to our admins for inspection.</p>
          <button onclick="window.close()">Return to App</button>
        </div>
      </body>
      </html>
    `);
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
