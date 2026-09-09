'use strict';

const mongoose = require('mongoose');
const {
  User, Seeker, Employer, Agency, Payment, Job, Placement, Application, AgencyFinancial,
  InboundSmsEvent,
} = require('../models');
const AppError = require('../errors/AppError');
const chapaService = require('./chapa.service');
const subscriptionPlanService = require('./subscriptionPlan.service');
const adsService = require('./ads.service');
const jobsService = require('./jobs.service');
const { DEFAULT_TIER } = require('../utils/subscriptionTiers');
const { getJobPostingLimit, getCandidateSearchLimits } = require('./subscriptionPlan.service');
const {
  enqueueVerificationRejectedNotification, enqueueAccountStatusChangedNotification,
} = require('../queues/notifications.queue');

/** Same regex-escape convention as jobs.service.js#escapeRegex /
 * seeker.service.js#searchSeekers — free-text search shouldn't let a
 * user-typed `.`/`*`/etc. change what the pattern actually matches. */
function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * GET /api/v1/admin/verifications
 * Returns all employer/agency accounts with a given status (default: 'pending').
 */
async function listVerifications({ status = 'pending' } = {}) {
  const users = await User.find({
    role: { $in: ['employer', 'agency'] },
    verificationStatus: status,
  }).select('-passwordHash').lean();

  // Enrich each user with their profile (tinNumber, businessLicenseUrl, etc.)
  const enriched = await Promise.all(
    users.map(async (u) => {
      let profile = null;
      if (u.role === 'employer') {
        profile = await Employer.findOne({ userId: u._id })
          .select('companyName tinNumber businessLicenseUrl subscriptionTier')
          .lean();
      } else if (u.role === 'agency') {
        profile = await Agency.findOne({ userId: u._id })
          .select('agencyName tinNumber businessLicenseUrl subscriptionTier')
          .lean();
      }
      return { ...u, profile };
    }),
  );

  return enriched;
}

/**
 * POST /api/v1/admin/verifications/:userId/approve
 */
async function approveUser(userId) {
  const user = await User.findById(userId);
  if (!user) throw new AppError('User not found', 404);
  if (!['employer', 'agency'].includes(user.role)) {
    throw new AppError('Only employer and agency accounts can be verified', 400);
  }

  user.verificationStatus = 'approved';
  user.verificationRejectionReason = null;
  await user.save();

  return user.toJSON();
}

/**
 * Looks up this user's most recent verified subscription payment and
 * refunds it via Chapa. Called from rejectUser below — "if the company
 * can't fix their document, their money should be refunded" only works
 * if something actually finds and refunds the original charge, which
 * nothing did before this (rejecting just recorded a text reason).
 *
 * Deliberately swallows Chapa/network failures into a `refund_failed`
 * result rather than throwing: a refund-provider outage must never
 * block the rejection itself from going through (the admin still needs
 * to be able to reject a bad document even if Chapa is down right now),
 * and `refund_failed` payments stay queryable via `Payment.status` for
 * manual follow-up.
 *
 * @param {string} userId
 * @param {string} reason - the admin's rejection reason, recorded as the refund's reason
 * @returns {Promise<{ status: 'refunded'|'refund_failed'|'none', amount?: number, currency?: string, txRef?: string, error?: string }>}
 */
async function refundLatestSubscriptionPayment(userId, reason) {
  const payment = await Payment.findOne({
    userId,
    product: 'subscription',
    status: 'verified',
  }).sort({ createdAt: -1 });

  if (!payment) {
    return { status: 'none' };
  }

  try {
    const { refundId } = await chapaService.refundPayment({
      txRef: payment.txRef,
      amount: payment.amount,
      reason: `KeferaJobs verification rejected: ${reason}`,
    });

    payment.status = 'refunded';
    payment.refundedAt = new Date();
    payment.refundReason = reason;
    payment.chapaRefundReference = refundId;
    await payment.save();

    return {
      status: 'refunded', amount: payment.amount, currency: payment.currency, txRef: payment.txRef,
    };
  } catch (err) {
    payment.status = 'refund_failed';
    payment.refundReason = reason;
    await payment.save();

    // eslint-disable-next-line no-console
    console.error(`[admin.service] refund failed for user_id=${userId} tx_ref=${payment.txRef}:`, err.message);

    return {
      status: 'refund_failed', txRef: payment.txRef, error: err.message,
    };
  }
}

/**
 * POST /api/v1/admin/verifications/:userId/reject
 *
 * Beyond flipping verificationStatus, this now also (a) refunds the
 * user's latest verified subscription payment if one exists, and (b)
 * texts/emails them the rejection reason plus the refund outcome —
 * previously a rejection was silent (nothing dialed their phone, and
 * nothing gave their money back) until they happened to check
 * `GET /verification/status` themselves.
 */
async function rejectUser(userId, reason) {
  if (!reason || !reason.trim()) {
    throw new AppError('A rejection reason is required', 400);
  }

  const user = await User.findById(userId);
  if (!user) throw new AppError('User not found', 404);
  if (!['employer', 'agency'].includes(user.role)) {
    throw new AppError('Only employer and agency accounts can be rejected', 400);
  }

  const trimmedReason = reason.trim();
  user.verificationStatus = 'rejected';
  user.verificationRejectionReason = trimmedReason;
  await user.save();

  const refund = await refundLatestSubscriptionPayment(userId, trimmedReason);

  // Best-effort — an SMS/queue hiccup must not undo the rejection
  // (and refund, if any) that already committed above. The admin sees
  // `refund` in this function's return value regardless, so a failed
  // enqueue here is recoverable (they can follow up with the company
  // directly) rather than silently losing the whole rejection.
  try {
    await enqueueVerificationRejectedNotification(userId, trimmedReason, refund);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[admin.service] failed to enqueue verification-rejected notification for user_id=${userId}:`, err.message);
  }

  return { user: user.toJSON(), refund };
}

/**
 * POST /api/v1/admin/verifications/:userId/resubmit
 * Called by employer/agency themselves to reset to pending after rejection.
 */
async function resubmitVerification(userId) {
  const user = await User.findById(userId);
  if (!user) throw new AppError('User not found', 404);

  if (user.verificationStatus !== 'rejected') {
    throw new AppError('Only rejected accounts can resubmit for verification', 400);
  }

  user.verificationStatus = 'pending';
  user.verificationRejectionReason = null;
  await user.save();

  return user.toJSON();
}

/**
 * GET /api/v1/admin/accounts?role=employer|agency
 * The "subscription & services" console (as opposed to
 * `listVerifications`, which is scoped to the onboarding queue):
 * every employer/agency account regardless of verificationStatus,
 * enriched with the same profile fields plus the two levers admin
 * actually controls here — `subscriptionTier` (via
 * `updateSubscriptionTier`) and the account's `accountStatus` (via
 * `setAccountStatus`) — plus each tier's current job-posting/candidate-
 * search limits, so the admin UI can show what a tier *means* without
 * hardcoding `subscriptionTiers.js`'s numbers a second time.
 *
 * @param {{ role?: 'employer'|'agency', search?: string }} [filters]
 */
async function listManagedAccounts({ role, search } = {}) {
  const query = { role: role ? role : { $in: ['employer', 'agency'] } };

  const users = await User.find(query)
    .select('-passwordHash')
    .sort({ createdAt: -1 })
    .lean();

  const enriched = await Promise.all(
    users.map(async (u) => {
      let profile = null;
      if (u.role === 'employer') {
        profile = await Employer.findOne({ userId: u._id })
          .select('companyName tinNumber businessLicenseUrl subscriptionTier')
          .lean();
      } else if (u.role === 'agency') {
        profile = await Agency.findOne({ userId: u._id })
          .select('agencyName tinNumber businessLicenseUrl subscriptionTier')
          .lean();
      }
      const tier = profile?.subscriptionTier || DEFAULT_TIER;
      return {
        ...u,
        profile,
        limits: {
          maxOpenJobs: await getJobPostingLimit(tier),
          candidateSearch: await getCandidateSearchLimits(tier),
        },
      };
    }),
  );

  // Free-text match on company/agency name — cheap in-memory filter
  // rather than a Mongo query since this list is never large enough
  // (one document per employer/agency account) to need it server-side.
  if (search && search.trim()) {
    const needle = search.trim().toLowerCase();
    return enriched.filter((u) => {
      const name = u.profile?.companyName || u.profile?.agencyName || '';
      return name.toLowerCase().includes(needle) || (u.email || '').toLowerCase().includes(needle);
    });
  }

  return enriched;
}

/**
 * PATCH /api/v1/admin/accounts/:userId/subscription
 * Admin override of an employer/agency's plan — independent of the
 * Chapa checkout flow in payment.routes.js (no charge is made or
 * refunded here; use this for comps, manual corrections, or
 * downgrading/upgrading outside the normal payment cycle). Directly
 * mutates the Employer/Agency profile's `subscriptionTier`, the same
 * field the payment flow itself writes to.
 *
 * @param {string} userId
 * @param {string} tier - the `key` of an existing `SubscriptionPlan`
 */
async function updateSubscriptionTier(userId, tier) {
  const plans = await subscriptionPlanService.listPlans();
  const key = String(tier || '').toLowerCase();
  if (!plans.some((p) => p.key === key)) {
    throw new AppError(`tier must be one of: ${plans.map((p) => p.key).join(', ')}`, 422);
  }

  const user = await User.findById(userId).select('role');
  if (!user) throw new AppError('User not found', 404);
  if (!['employer', 'agency'].includes(user.role)) {
    throw new AppError('Only employer and agency accounts have a subscription', 400);
  }

  const ProfileModel = user.role === 'employer' ? Employer : Agency;
  const profile = await ProfileModel.findOneAndUpdate(
    { userId },
    { subscriptionTier: key },
    { new: true },
  );
  if (!profile) throw new AppError(`${user.role} profile not found`, 404);

  return profile.toJSON();
}

/**
 * PATCH /api/v1/admin/accounts/:userId/status
 * The "services" half of this console: independent of
 * `subscriptionTier` (what they're entitled to) and `verificationStatus`
 * (whether they were ever approved), `accountStatus` is admin's live
 * on/off switch for an already-approved account — see the field's doc
 * comment on User.model.js and `requireApproved.middleware.js`, which
 * is what actually enforces this on job posting, candidate search, and
 * messaging.
 *
 * @param {string} userId
 * @param {'active'|'suspended'} status
 * @param {string} [reason] - required when suspending; shown to the account and recorded
 */
async function setAccountStatus(userId, status, reason) {
  if (!['active', 'suspended'].includes(status)) {
    throw new AppError("status must be 'active' or 'suspended'", 422);
  }
  if (status === 'suspended' && (!reason || !reason.trim())) {
    throw new AppError('A reason is required to suspend an account', 400);
  }

  const user = await User.findById(userId);
  if (!user) throw new AppError('User not found', 404);
  // Admin accounts are deliberately excluded — suspending an admin
  // through this same lever isn't something this UI should be able to
  // do to itself (or another admin). Seeker added alongside
  // employer/agency now that the Users page needs to suspend any of
  // the three normal account types, not just the two subscription-
  // paying ones this originally shipped for.
  if (!['seeker', 'employer', 'agency'].includes(user.role)) {
    throw new AppError('Admin accounts cannot be suspended from this console', 400);
  }

  const trimmedReason = reason ? reason.trim() : null;
  user.accountStatus = status;
  user.accountStatusReason = status === 'suspended' ? trimmedReason : null;
  user.accountStatusUpdatedAt = new Date();
  await user.save();

  // Best-effort, same rationale as rejectUser's notification call
  // below it — a queue hiccup must never undo the status change that
  // already committed above.
  try {
    await enqueueAccountStatusChangedNotification(userId, status, trimmedReason);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[admin.service] failed to enqueue account-status-changed notification for user_id=${userId}:`, err.message);
  }

  return user.toJSON();
}

/**
 * GET /api/v1/admin/stats
 * The stat-card numbers `AdminDashboardScreen` shows. Kept as one
 * combined query rather than several separate endpoints since the
 * frontend only ever needs all of them together, on one screen.
 *
 * - `seekerCount` / `employerAgencyCount`: split by role rather than one
 *   combined "total users" figure — an admin cares about how many job
 *   seekers vs. how many employer/agency accounts are on the platform,
 *   not just a headcount. Excludes `admin`-role accounts from both
 *   (an admin account isn't a "user" in the sense either card means).
 * - `activeJobListings`: jobs currently in `status: 'open'` — closed/
 *   draft postings don't count as "active".
 * - `placementsThisMonth`: placements that reached `status: 'hired'`
 *   with `updatedAt` in the current calendar month. `hired` is a
 *   terminal status (see PLACEMENT_STATUS_TRANSITIONS), so `updatedAt`
 *   is a reliable proxy for "when this hire happened" — there's no
 *   separate `hiredAt` field on the model to query instead.
 */
async function getPlatformStats() {
  const startOfMonth = new Date();
  startOfMonth.setDate(1);
  startOfMonth.setHours(0, 0, 0, 0);

  const [seekerCount, employerAgencyCount, activeJobListings, placementsThisMonth] =
    await Promise.all([
      User.countDocuments({ role: 'seeker' }),
      User.countDocuments({ role: { $in: ['employer', 'agency'] } }),
      Job.countDocuments({ status: 'open' }),
      Placement.countDocuments({ status: 'hired', updatedAt: { $gte: startOfMonth } }),
    ]);

  return { seekerCount, employerAgencyCount, activeJobListings, placementsThisMonth };
}

/**
 * GET /api/v1/admin/users
 * The Users page: every account on the platform regardless of role,
 * lightly enriched with just enough profile info to identify who's who
 * (a name, basically) — unlike `listManagedAccounts`, which is scoped to
 * employer/agency and loads subscription-tier/limits data this page has
 * no use for. Kept as its own function/route rather than widening
 * `listManagedAccounts` so the Subscriptions page's query keeps its
 * existing (smaller, tier-enriched) shape.
 *
 * @param {{ role?: 'seeker'|'employer'|'agency'|'admin', search?: string }} [filters]
 */
async function listAllUsers({ role, search } = {}) {
  const query = role ? { role } : {};

  const users = await User.find(query)
    .select('-passwordHash')
    .sort({ createdAt: -1 })
    .lean();

  const enriched = await Promise.all(
    users.map(async (u) => {
      let profile = null;
      if (u.role === 'seeker') {
        profile = await Seeker.findOne({ userId: u._id }).select('fullName city').lean();
      } else if (u.role === 'employer') {
        profile = await Employer.findOne({ userId: u._id }).select('companyName').lean();
      } else if (u.role === 'agency') {
        profile = await Agency.findOne({ userId: u._id }).select('agencyName').lean();
      }
      return { ...u, profile };
    }),
  );

  if (search && search.trim()) {
    const needle = search.trim().toLowerCase();
    return enriched.filter((u) => {
      const name =
        u.profile?.fullName || u.profile?.companyName || u.profile?.agencyName || '';
      return (
        name.toLowerCase().includes(needle) ||
        (u.email || '').toLowerCase().includes(needle) ||
        (u.phone || '').toLowerCase().includes(needle)
      );
    });
  }

  return enriched;
}

/**
 * GET /api/v1/admin/jobs?status=&creator_type=&search=&page=&limit=
 * Every job on the platform regardless of status — unlike
 * jobs.service.js#browseJobs (open-only, for the seeker job board) or
 * #getMyJobs (one creator's own dashboard). Backs the admin "Job
 * Listings" oversight page: browse/search/filter everything, then
 * close or remove (see closeJobAsAdmin/removeJobAsAdmin below) a
 * listing regardless of who posted it.
 *
 * @param {{ status?: string, creatorType?: string, search?: string,
 *   page?: number, limit?: number }} [filters]
 */
async function listAllJobsForAdmin({
  status, creatorType, search, page = 1, limit = 20,
} = {}) {
  const safePage = Math.max(1, Number(page) || 1);
  const safeLimit = Math.min(100, Math.max(1, Number(limit) || 20));
  const skip = (safePage - 1) * safeLimit;

  const query = {};
  if (status) query.status = status;
  if (creatorType) query.creatorType = creatorType;
  if (search && search.trim()) {
    const pattern = new RegExp(escapeRegex(search.trim()), 'i');
    query.$or = [{ title: pattern }, { location: pattern }];
  }

  const [jobs, total] = await Promise.all([
    Job.find(query).sort({ createdAt: -1 }).skip(skip).limit(safeLimit),
    Job.countDocuments(query),
  ]);

  const jobsJson = jobs.map((doc) => doc.toJSON());
  await jobsService.attachPosterInfo(jobsJson);

  // Application count per job, same "one grouped query regardless of
  // how many jobs" shape as attachPosterInfo above.
  const jobIds = jobsJson.map((j) => j.id);
  const counts = jobIds.length > 0
    ? await Application.aggregate([
      // Aggregation pipelines don't auto-cast query values the way
      // Mongoose queries do, so jobId (an ObjectId field) needs an
      // explicit cast from the stringified ids attachPosterInfo left on
      // jobsJson — a plain string `$in` here would match nothing.
      { $match: { jobId: { $in: jobIds.map((id) => new mongoose.Types.ObjectId(id)) } } },
      { $group: { _id: '$jobId', count: { $sum: 1 } } },
    ])
    : [];
  const countByJobId = new Map(counts.map((c) => [c._id.toString(), c.count]));
  for (const job of jobsJson) {
    job.applicationCount = countByJobId.get(job.id) || 0;
  }

  return {
    jobs: jobsJson, page: safePage, limit: safeLimit, total,
  };
}

/**
 * POST /api/v1/admin/jobs/:jobId/close
 * Admin override of the owner's own "close a listing" action (PATCH
 * /jobs/:id { status: 'closed' }) — no creatorId ownership filter,
 * since admin is acting on someone else's posting. Reversible: unlike
 * removeJobAsAdmin below, the owner can still reopen a closed job
 * themselves afterwards (status 'closed' isn't blocked by
 * jobs.service.js#updateJob's `$ne: 'removed'` guard).
 *
 * @param {string} jobId
 */
async function closeJobAsAdmin(jobId) {
  const job = await Job.findByIdAndUpdate(
    jobId,
    { $set: { status: 'closed' } },
    { new: true, runValidators: true },
  );
  if (!job) throw new AppError('Job not found', 404);
  return job.toJSON();
}

/**
 * POST /api/v1/admin/jobs/:jobId/remove  { reason? }
 * Takes a listing down for a policy violation. Deliberately a status
 * flip (status: 'removed') rather than actually deleting the Job
 * document: Application/Placement/Message rows key off jobId, and
 * every reader of those already tolerates a missing/foreign job (see
 * messaging.service.js#listConversationsForAdmin's `job?.title ||
 * 'Unknown job'` fallback) — flipping status keeps that history intact
 * and attributable instead of orphaning it. `reason` is stored on the
 * job itself so the poster can see why, same convention as
 * ads.service.js#rejectAd's `rejectionReason`. Terminal from the
 * owner's side — see jobs.service.js#updateJob's `$ne: 'removed'` guard.
 *
 * @param {string} jobId
 * @param {string} [reason]
 */
async function removeJobAsAdmin(jobId, reason) {
  const job = await Job.findByIdAndUpdate(
    jobId,
    { $set: { status: 'removed', removedReason: reason || null } },
    { new: true, runValidators: true },
  );
  if (!job) throw new AppError('Job not found', 404);
  return job.toJSON();
}

/**
 * GET /api/v1/admin/placements?status=&agency_only=&page=&limit=
 * Backs the "Placements" oversight page's Placements tab — every row
 * in the matching-engine/agency-dispatch pipeline (see Placement.model.js's
 * doc comment on how this differs from Application), platform-wide and
 * read-only. There's deliberately no admin-driven status transition
 * here (unlike jobs' close/remove above): a placement's status is
 * owned by the matching worker and the agency's own dispatch workflow
 * (agency.service.js#updatePlacementStatus), and admin overriding it
 * out from under that workflow would desync whatever the agency/
 * employer and seeker already see on their own screens.
 *
 * @param {{ status?: string, agencyOnly?: boolean, page?: number, limit?: number }} [filters]
 */
async function listAllPlacementsForAdmin({
  status, agencyOnly, page = 1, limit = 20,
} = {}) {
  const safePage = Math.max(1, Number(page) || 1);
  const safeLimit = Math.min(100, Math.max(1, Number(limit) || 20));
  const skip = (safePage - 1) * safeLimit;

  const query = {};
  if (status) query.status = status;
  if (agencyOnly) query.agencyId = { $ne: null };

  const [placements, total] = await Promise.all([
    Placement.find(query).sort({ createdAt: -1 }).skip(skip).limit(safeLimit).lean(),
    Placement.countDocuments(query),
  ]);

  const jobIds = [...new Set(placements.map((p) => p.jobId.toString()))];
  const seekerIds = [...new Set(placements.map((p) => p.seekerId.toString()))];
  const agencyIds = [...new Set(
    placements.filter((p) => p.agencyId).map((p) => p.agencyId.toString()),
  )];

  const [jobs, seekers, agencies] = await Promise.all([
    Job.find({ _id: { $in: jobIds } }).select('title creatorId creatorType').lean(),
    Seeker.find({ _id: { $in: seekerIds } }).select('fullName').lean(),
    Agency.find({ userId: { $in: agencyIds } }).select('userId agencyName').lean(),
  ]);
  const jobById = new Map(jobs.map((j) => [j._id.toString(), j]));
  const seekerById = new Map(seekers.map((s) => [s._id.toString(), s]));
  // Placement.agencyId is an Agency *document* id (unlike Job.creatorId,
  // which is a User id) — see how it's populated in
  // placements.service.js#saveMatchedPlacements — so this looks up by
  // Agency._id, not Agency.userId, unlike agencyByUserId elsewhere in
  // this file.
  const agencyById = new Map(agencies.map((a) => [a.userId.toString(), a]));

  // Employer name for non-agency (direct) placements — job.creatorType
  // === 'employer' — batched the same way listConversationsForAdmin
  // above does it.
  const employerCreatorIds = jobs
    .filter((j) => j.creatorType === 'employer')
    .map((j) => j.creatorId);
  const employers = await Employer.find({ userId: { $in: employerCreatorIds } })
    .select('userId companyName')
    .lean();
  const employerByUserId = new Map(employers.map((e) => [e.userId.toString(), e]));

  const enriched = placements.map((p) => {
    const job = jobById.get(p.jobId.toString());
    const seeker = seekerById.get(p.seekerId.toString());
    const agency = p.agencyId ? agencyById.get(p.agencyId.toString()) : null;
    const employer = job && job.creatorType === 'employer'
      ? employerByUserId.get(job.creatorId.toString())
      : null;

    return {
      id: p._id.toString(),
      status: p.status,
      score: p.score,
      sentAt: p.sentAt,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
      jobId: p.jobId.toString(),
      jobTitle: job?.title || 'Unknown job',
      seekerId: p.seekerId.toString(),
      seekerName: seeker?.fullName || 'Unknown',
      agencyId: p.agencyId ? p.agencyId.toString() : null,
      agencyName: agency?.agencyName || null,
      employerName: employer?.companyName || null,
    };
  });

  return {
    placements: enriched, page: safePage, limit: safeLimit, total,
  };
}

/**
 * GET /api/v1/admin/agency-ledger?transaction_type=&agency_id=&page=&limit=
 * Backs the same page's Financial Ledger tab — every
 * AgencyFinancial.model.js entry across every agency, read-only.
 * Unlike an agency's own finances (there is currently no "list my
 * entries" endpoint at all — agency.service.js#recordLedgerEntry only
 * writes, and the agency dashboard only ever shows aggregated stats),
 * this is admin's one place to see the raw entries behind every
 * agency's `ledgerBalance`.
 *
 * @param {{ transactionType?: string, agencyId?: string, page?: number, limit?: number }} [filters]
 */
async function listAgencyLedgerForAdmin({
  transactionType, agencyId, page = 1, limit = 20,
} = {}) {
  const safePage = Math.max(1, Number(page) || 1);
  const safeLimit = Math.min(100, Math.max(1, Number(limit) || 20));
  const skip = (safePage - 1) * safeLimit;

  const query = {};
  if (transactionType) query.transactionType = transactionType;
  if (agencyId) query.agencyId = agencyId;

  const [entries, total] = await Promise.all([
    AgencyFinancial.find(query).sort({ date: -1 }).skip(skip).limit(safeLimit).lean(),
    AgencyFinancial.countDocuments(query),
  ]);

  const agencyDocIds = [...new Set(entries.map((e) => e.agencyId.toString()))];
  const agencies = await Agency.find({ _id: { $in: agencyDocIds } }).select('agencyName').lean();
  const agencyById = new Map(agencies.map((a) => [a._id.toString(), a]));

  const enriched = entries.map((e) => ({
    id: e._id.toString(),
    agencyId: e.agencyId.toString(),
    agencyName: agencyById.get(e.agencyId.toString())?.agencyName || 'Unknown agency',
    amount: e.amount,
    transactionType: e.transactionType,
    description: e.description,
    date: e.date,
    createdAt: e.createdAt,
  }));

  return {
    entries: enriched, page: safePage, limit: safeLimit, total,
  };
}

/**
 * GET /api/v1/admin/sms-logs?matched=&search=&page=&limit=
 * Backs the "SMS Logs" debugging page — read-only, platform-wide view
 * over InboundSmsEvent.model.js (see smsInbound.service.js, which is
 * the only writer). Outbound sends (sms.service.js#sendSMS) aren't
 * persisted anywhere yet, so this is inbound-only for now.
 *
 * `matched` filters on whether attachEventContext() ever resolved the
 * sender to a seeker — i.e. whether `seekerId` is set, not whether a
 * placement was found (a matched seeker can still have no placement).
 * `search` free-texts against the raw `fromPhone` as stored (no digit
 * normalization, since InboundSmsEvent doesn't have a phoneLast9-style
 * derived field the way User does).
 *
 * @param {{ matched?: boolean, search?: string, page?: number, limit?: number }} [filters]
 */
async function listSmsLogsForAdmin({
  matched, search, page = 1, limit = 20,
} = {}) {
  const safePage = Math.max(1, Number(page) || 1);
  const safeLimit = Math.min(100, Math.max(1, Number(limit) || 20));
  const skip = (safePage - 1) * safeLimit;

  const query = {};
  if (matched === true) query.seekerId = { $ne: null };
  if (matched === false) query.seekerId = null;
  if (search) query.fromPhone = new RegExp(escapeRegex(search), 'i');

  const [events, total] = await Promise.all([
    InboundSmsEvent.find(query).sort({ createdAt: -1 }).skip(skip).limit(safeLimit).lean(),
    InboundSmsEvent.countDocuments(query),
  ]);

  const seekerIds = [...new Set(
    events.filter((e) => e.seekerId).map((e) => e.seekerId.toString()),
  )];
  const placementIds = [...new Set(
    events.filter((e) => e.placementId).map((e) => e.placementId.toString()),
  )];

  const [seekers, placements] = await Promise.all([
    Seeker.find({ _id: { $in: seekerIds } }).select('fullName').lean(),
    Placement.find({ _id: { $in: placementIds } }).select('jobId status').lean(),
  ]);
  const seekerById = new Map(seekers.map((s) => [s._id.toString(), s]));
  const placementById = new Map(placements.map((p) => [p._id.toString(), p]));

  const jobIds = [...new Set(placements.map((p) => p.jobId.toString()))];
  const jobs = await Job.find({ _id: { $in: jobIds } }).select('title').lean();
  const jobById = new Map(jobs.map((j) => [j._id.toString(), j]));

  const enriched = events.map((e) => {
    const seeker = e.seekerId ? seekerById.get(e.seekerId.toString()) : null;
    const placement = e.placementId ? placementById.get(e.placementId.toString()) : null;
    const job = placement ? jobById.get(placement.jobId.toString()) : null;

    return {
      id: e._id.toString(),
      provider: e.provider,
      providerMessageId: e.providerMessageId,
      fromPhone: e.fromPhone,
      body: e.body,
      seekerId: e.seekerId ? e.seekerId.toString() : null,
      seekerName: seeker?.fullName || null,
      placementId: e.placementId ? e.placementId.toString() : null,
      placementStatus: placement?.status || null,
      jobTitle: job?.title || null,
      createdAt: e.createdAt,
    };
  });

  return {
    events: enriched, page: safePage, limit: safeLimit, total,
  };
}

/**
 * GET /api/v1/admin/reports?days=
 * Backs the "Reports" page — growth, conversion, and payment analytics
 * over a trailing window (default 30 days). Unlike getPlatformStats
 * (a point-in-time snapshot for the dashboard's stat cards), everything
 * here is scoped to the same [start, end] window so the growth trend,
 * conversion funnel, and revenue figures describe one coherent period
 * rather than mixing "all time" totals with "this week" trends.
 *
 * @param {{ days?: number }} [filters]
 */
async function getReportsForAdmin({ days = 30 } = {}) {
  const safeDays = Math.min(180, Math.max(7, Number(days) || 30));
  const end = new Date();
  const start = new Date(end.getTime() - safeDays * 24 * 60 * 60 * 1000);
  const dateMatch = { createdAt: { $gte: start, $lte: end } };

  /** Daily counts for a model within the window, zero-filled for days with no rows. */
  const dailySeries = async (Model, extraMatch = {}) => {
    const rows = await Model.aggregate([
      { $match: { ...dateMatch, ...extraMatch } },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
          count: { $sum: 1 },
        },
      },
    ]);
    const byDate = new Map(rows.map((r) => [r._id, r.count]));
    const series = [];
    for (let i = 0; i < safeDays; i += 1) {
      const d = new Date(start.getTime() + i * 24 * 60 * 60 * 1000);
      const key = d.toISOString().slice(0, 10);
      series.push({ date: key, count: byDate.get(key) || 0 });
    }
    return series;
  };

  const [
    newUsers, newJobs, newPlacements, newApplications,
    jobsPosted, totalApplications, shortlistedApplications,
    totalPlacements, hiredPlacements,
  ] = await Promise.all([
    dailySeries(User),
    dailySeries(Job),
    dailySeries(Placement),
    dailySeries(Application),
    Job.countDocuments(dateMatch),
    Application.countDocuments(dateMatch),
    Application.countDocuments({ ...dateMatch, status: 'shortlisted' }),
    Placement.countDocuments(dateMatch),
    Placement.countDocuments({ ...dateMatch, status: 'hired' }),
  ]);

  const verifiedMatch = { ...dateMatch, status: 'verified' };

  const [byProductRows, byPlanRows, dailyRevenueRows, revenueTotalRows, refundTotalRows] = await Promise.all([
    Payment.aggregate([
      { $match: verifiedMatch },
      { $group: { _id: '$product', amount: { $sum: '$amount' }, count: { $sum: 1 } } },
      { $sort: { amount: -1 } },
    ]),
    Payment.aggregate([
      { $match: { ...verifiedMatch, plan: { $ne: null } } },
      { $group: { _id: '$plan', amount: { $sum: '$amount' }, count: { $sum: 1 } } },
      { $sort: { amount: -1 } },
    ]),
    Payment.aggregate([
      { $match: verifiedMatch },
      { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } }, amount: { $sum: '$amount' } } },
    ]),
    Payment.aggregate([
      { $match: verifiedMatch },
      { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } },
    ]),
    // Refunds are booked against `refundedAt`, not `createdAt` (the
    // payment itself may have been created outside this window) —
    // mirrors admin.service.js#refundLatestSubscriptionPayment, the
    // only writer of refundedAt.
    Payment.aggregate([
      { $match: { status: 'refunded', refundedAt: { $gte: start, $lte: end } } },
      { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } },
    ]),
  ]);

  const revenueByDate = new Map(dailyRevenueRows.map((r) => [r._id, r.amount]));
  const dailyRevenue = [];
  for (let i = 0; i < safeDays; i += 1) {
    const d = new Date(start.getTime() + i * 24 * 60 * 60 * 1000);
    const key = d.toISOString().slice(0, 10);
    dailyRevenue.push({ date: key, amount: revenueByDate.get(key) || 0 });
  }

  return {
    range: { start: start.toISOString(), end: end.toISOString(), days: safeDays },
    growth: {
      newUsers, newJobs, newPlacements, newApplications,
    },
    funnel: {
      jobsPosted,
      totalApplications,
      shortlistedApplications,
      totalPlacements,
      hiredPlacements,
      applicationToShortlistRate: totalApplications ? shortlistedApplications / totalApplications : 0,
      placementToHiredRate: totalPlacements ? hiredPlacements / totalPlacements : 0,
    },
    payments: {
      totalRevenue: revenueTotalRows[0]?.total || 0,
      paymentCount: revenueTotalRows[0]?.count || 0,
      totalRefunded: refundTotalRows[0]?.total || 0,
      refundCount: refundTotalRows[0]?.count || 0,
      byProduct: byProductRows.map((r) => ({ product: r._id, amount: r.amount, count: r.count })),
      byPlan: byPlanRows.map((r) => ({ plan: r._id, amount: r.amount, count: r.count })),
      daily: dailyRevenue,
    },
  };
}

module.exports = {
  listVerifications,
  approveUser,
  rejectUser,
  resubmitVerification,
  refundLatestSubscriptionPayment,
  listManagedAccounts,
  listAllUsers,
  updateSubscriptionTier,
  setAccountStatus,
  getPlatformStats,
  listTierPlans: subscriptionPlanService.listPlans,
  createTierPlan: subscriptionPlanService.createPlan,
  updateTierPlan: subscriptionPlanService.updatePlan,
  deleteTierPlan: subscriptionPlanService.deletePlan,
  setDefaultTierPlan: subscriptionPlanService.setDefaultPlan,
  reorderTierPlans: subscriptionPlanService.reorderPlans,
  listAds: adsService.listAdsForAdmin,
  approveAd: adsService.approveAd,
  rejectAd: adsService.rejectAd,
  listAllJobsForAdmin,
  closeJobAsAdmin,
  removeJobAsAdmin,
  listAllPlacementsForAdmin,
  listAgencyLedgerForAdmin,
  listSmsLogsForAdmin,
  getReportsForAdmin,
};
