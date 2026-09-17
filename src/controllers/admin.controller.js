'use strict';

const adminService = require('../services/admin.service');
const messagingService = require('../services/messaging.service');

/**
 * GET /api/v1/admin/verifications?status=pending|approved|rejected
 */
async function listVerificationsHandler(req, res, next) {
  try {
    const status = req.query.status || 'pending';
    if (!['pending', 'approved', 'rejected'].includes(status)) {
      return res.status(400).json({ status: 'error', message: 'status must be pending, approved, or rejected' });
    }
    const verifications = await adminService.listVerifications({ status });
    return res.status(200).json({ status: 'success', data: { verifications } });
  } catch (err) {
    return next(err);
  }
}

/**
 * POST /api/v1/admin/verifications/:userId/approve
 */
async function approveHandler(req, res, next) {
  try {
    const user = await adminService.approveUser(req.params.userId);
    return res.status(200).json({ status: 'success', data: { user } });
  } catch (err) {
    return next(err);
  }
}

/**
 * POST /api/v1/admin/verifications/:userId/reject
 * Body: { reason: "..." }
 * Response now also includes `refund` — the outcome of automatically
 * refunding this account's latest verified subscription payment (see
 * admin.service.js#refundLatestSubscriptionPayment), so the admin
 * console can show e.g. "refunded 5 ETB" or flag a failed refund for
 * manual follow-up instead of that happening silently.
 */
async function rejectHandler(req, res, next) {
  try {
    const { reason } = req.body;
    const { user, refund } = await adminService.rejectUser(req.params.userId, reason);
    return res.status(200).json({ status: 'success', data: { user, refund } });
  } catch (err) {
    return next(err);
  }
}

/**
 * GET /api/v1/admin/accounts?role=employer|agency&search=...
 * Backs the "Subscriptions & Services" admin console — every
 * employer/agency account (any verificationStatus), each with its
 * current plan and account status. Query already Joi-validated by
 * `listAccountsQuerySchema` (see admin.routes.js).
 */
async function listAccountsHandler(req, res, next) {
  try {
    const { role, search } = req.query;
    const accounts = await adminService.listManagedAccounts({ role, search });
    return res.status(200).json({ status: 'success', data: { accounts } });
  } catch (err) {
    return next(err);
  }
}

/**
 * PATCH /api/v1/admin/accounts/:userId/subscription
 * Body: { tier: 'basic'|'premium'|'enterprise' }
 * Admin override of an account's plan — see
 * admin.service.js#updateSubscriptionTier for how this differs from
 * the normal Chapa-driven upgrade flow.
 */
async function updateSubscriptionHandler(req, res, next) {
  try {
    const { tier } = req.body;
    const profile = await adminService.updateSubscriptionTier(req.params.userId, tier);
    return res.status(200).json({ status: 'success', data: { profile } });
  } catch (err) {
    return next(err);
  }
}

/**
 * PATCH /api/v1/admin/accounts/:userId/status
 * Body: { status: 'active'|'suspended', reason?: "..." }
 * The "services" half of the console — suspending/reactivating an
 * account independent of its subscription tier or verification
 * status. See admin.service.js#setAccountStatus and
 * requireApproved.middleware.js for what suspension actually blocks.
 */
async function updateAccountStatusHandler(req, res, next) {
  try {
    const { status, reason } = req.body;
    const user = await adminService.setAccountStatus(req.params.userId, status, reason);
    return res.status(200).json({ status: 'success', data: { user } });
  } catch (err) {
    return next(err);
  }
}

/**
 * GET /api/v1/admin/subscription-plans
 * Powers the subscriptions admin console's plan editor: every
 * admin-authored plan (name, price, benefits, and the enforcement
 * limits behind them), not any one account's own plan — see
 * subscriptionPlan.service.js's doc comment for how this differs from
 * `updateSubscriptionHandler` above (which moves one account between
 * plans; this edits what a plan itself means).
 */
async function listTierPlansHandler(req, res, next) {
  try {
    const plans = await adminService.listTierPlans();
    return res.status(200).json({ status: 'success', data: { plans } });
  } catch (err) {
    return next(err);
  }
}

/**
 * POST /api/v1/admin/subscription-plans
 * Creates a brand-new plan — this is how admin decides how many plans
 * exist in the first place, not just what the fixed set of tiers means.
 */
async function createTierPlanHandler(req, res, next) {
  try {
    const plan = await adminService.createTierPlan(req.body);
    return res.status(201).json({ status: 'success', data: { plan } });
  } catch (err) {
    return next(err);
  }
}

/**
 * PATCH /api/v1/admin/subscription-plans/:key
 * Applies immediately to every account currently on `:key` — see
 * subscriptionPlan.service.js#getJobPostingLimit, which reads this
 * live on every job post/reopen rather than caching it.
 */
async function updateTierPlanHandler(req, res, next) {
  try {
    const plan = await adminService.updateTierPlan(req.params.key, req.body);
    return res.status(200).json({ status: 'success', data: { plan } });
  } catch (err) {
    return next(err);
  }
}

/**
 * DELETE /api/v1/admin/subscription-plans/:key
 * Any account currently on this plan is moved to the default plan
 * first (see subscriptionPlan.service.js#deletePlan).
 */
async function deleteTierPlanHandler(req, res, next) {
  try {
    const result = await adminService.deleteTierPlan(req.params.key);
    return res.status(200).json({ status: 'success', data: result });
  } catch (err) {
    return next(err);
  }
}

/**
 * POST /api/v1/admin/subscription-plans/:key/set-default
 * Moves the "new signups land here" flag to this plan.
 */
async function setDefaultTierPlanHandler(req, res, next) {
  try {
    const plan = await adminService.setDefaultTierPlan(req.params.key);
    return res.status(200).json({ status: 'success', data: { plan } });
  } catch (err) {
    return next(err);
  }
}

/**
 * PATCH /api/v1/admin/subscription-plans/reorder
 * Body: { orderedKeys: string[] }
 */
async function reorderTierPlansHandler(req, res, next) {
  try {
    const plans = await adminService.reorderTierPlans(req.body.orderedKeys);
    return res.status(200).json({ status: 'success', data: { plans } });
  } catch (err) {
    return next(err);
  }
}

/**
 * GET /api/v1/admin/ads?status=pending_review
 * Powers the ad-moderation queue — omit `status` to see every ad.
 */
async function listAdsHandler(req, res, next) {
  try {
    const ads = await adminService.listAds(req.query.status);
    return res.status(200).json({ status: 'success', data: { ads } });
  } catch (err) {
    return next(err);
  }
}

/**
 * POST /api/v1/admin/ads/:adId/approve
 * Moves a paid, pending_review ad to active for AD_DURATION_DAYS.
 */
async function approveAdHandler(req, res, next) {
  try {
    const ad = await adminService.approveAd(req.params.adId);
    return res.status(200).json({ status: 'success', data: { ad } });
  } catch (err) {
    return next(err);
  }
}

/**
 * POST /api/v1/admin/ads/:adId/reject  { reason }
 */
async function rejectAdHandler(req, res, next) {
  try {
    const ad = await adminService.rejectAd(req.params.adId, req.body.reason);
    return res.status(200).json({ status: 'success', data: { ad } });
  } catch (err) {
    return next(err);
  }
}

/**
 * GET /api/v1/admin/conversations?page=1&limit=20
 * Oversight queue: every employer/agency <-> seeker conversation,
 * newest activity first.
 */
async function listConversationsHandler(req, res, next) {
  try {
    const page = Number(req.query.page) || 1;
    const limit = Number(req.query.limit) || 20;
    const result = await messagingService.listConversationsForAdmin({ page, limit });
    return res.status(200).json({ status: 'success', data: result });
  } catch (err) {
    return next(err);
  }
}

/**
 * GET /api/v1/admin/conversations/:placementId/messages
 * Full read-only thread for one conversation.
 */
async function listConversationMessagesHandler(req, res, next) {
  try {
    const thread = await messagingService.listMessagesForAdmin(req.params.placementId);
    return res.status(200).json({ status: 'success', data: thread });
  } catch (err) {
    return next(err);
  }
}

/**
 * GET /api/v1/admin/jobs?status=&creator_type=&search=&page=&limit=
 * Backs the "Job Listings" oversight page — every job on the platform,
 * unlike jobs.controller's own `/jobs` (open-only board) or
 * `/jobs/my-jobs` (one creator's own dashboard). Query already
 * Joi-validated by `listJobsQuerySchema`.
 */
async function listJobsHandler(req, res, next) {
  try {
    const {
      status, creator_type: creatorType, search, page, limit,
    } = req.query;
    const result = await adminService.listAllJobsForAdmin({
      status, creatorType, search, page, limit,
    });
    return res.status(200).json({ status: 'success', data: result });
  } catch (err) {
    return next(err);
  }
}

/**
 * POST /api/v1/admin/jobs/:jobId/close
 * Admin override of the poster's own "close listing" action.
 */
async function closeJobHandler(req, res, next) {
  try {
    const job = await adminService.closeJobAsAdmin(req.params.jobId);
    return res.status(200).json({ status: 'success', data: { job } });
  } catch (err) {
    return next(err);
  }
}

/**
 * POST /api/v1/admin/jobs/:jobId/remove  { reason? }
 * Takes a listing down for a policy violation — terminal from the
 * poster's side (see jobs.service.js#updateJob's removed-status guard).
 */
async function removeJobHandler(req, res, next) {
  try {
    const { reason } = req.body;
    const job = await adminService.removeJobAsAdmin(req.params.jobId, reason);
    return res.status(200).json({ status: 'success', data: { job } });
  } catch (err) {
    return next(err);
  }
}

/**
 * GET /api/v1/admin/placements?status=&agency_only=&page=&limit=
 * Backs the "Placements" oversight page's Placements tab.
 */
async function listPlacementsHandler(req, res, next) {
  try {
    const {
      status, agency_only: agencyOnly, page, limit,
    } = req.query;
    const result = await adminService.listAllPlacementsForAdmin({
      status, agencyOnly, page, limit,
    });
    return res.status(200).json({ status: 'success', data: result });
  } catch (err) {
    return next(err);
  }
}

/**
 * GET /api/v1/admin/agency-ledger?transaction_type=&agency_id=&page=&limit=
 * Backs the same page's Financial Ledger tab.
 */
async function listAgencyLedgerHandler(req, res, next) {
  try {
    const {
      transaction_type: transactionType, agency_id: agencyId, page, limit,
    } = req.query;
    const result = await adminService.listAgencyLedgerForAdmin({
      transactionType, agencyId, page, limit,
    });
    return res.status(200).json({ status: 'success', data: result });
  } catch (err) {
    return next(err);
  }
}

/**
 * GET /api/v1/admin/sms-logs?matched=&search=&page=&limit=
 * Backs the "SMS Logs" debugging page.
 */
async function listSmsLogsHandler(req, res, next) {
  try {
    const {
      matched, search, page, limit,
    } = req.query;
    const result = await adminService.listSmsLogsForAdmin({
      matched, search, page, limit,
    });
    return res.status(200).json({ status: 'success', data: result });
  } catch (err) {
    return next(err);
  }
}

/**
 * GET /api/v1/admin/reports?days=
 * Backs the "Reports" page.
 */
async function getReportsHandler(req, res, next) {
  try {
    const { days } = req.query;
    const result = await adminService.getReportsForAdmin({ days });
    return res.status(200).json({ status: 'success', data: result });
  } catch (err) {
    return next(err);
  }
}

/**
 * GET /api/v1/admin/users?role=seeker|employer|agency|admin&search=...
 * Backs the Users page — every account on the platform, unlike
 * `listAccountsHandler` which is scoped to employer/agency.
 */
async function listUsersHandler(req, res, next) {
  try {
    const { role, search } = req.query;
    const users = await adminService.listAllUsers({ role, search });
    return res.status(200).json({ status: 'success', data: { users } });
  } catch (err) {
    return next(err);
  }
}

/**
 * GET /api/v1/admin/stats
 * Backs the four stat cards on `AdminDashboardScreen` — total users,
 * active job listings, and placements this month (pending verifications
 * already has its own count via `listVerificationsHandler`).
 */
async function getStatsHandler(req, res, next) {
  try {
    const stats = await adminService.getPlatformStats();
    return res.status(200).json({ status: 'success', data: stats });
  } catch (err) {
    return next(err);
  }
}

module.exports = {
  listVerificationsHandler,
  approveHandler,
  rejectHandler,
  listAccountsHandler,
  updateSubscriptionHandler,
  updateAccountStatusHandler,
  listTierPlansHandler,
  createTierPlanHandler,
  updateTierPlanHandler,
  deleteTierPlanHandler,
  setDefaultTierPlanHandler,
  reorderTierPlansHandler,
  listAdsHandler,
  approveAdHandler,
  rejectAdHandler,
  listConversationsHandler,
  listConversationMessagesHandler,
  listJobsHandler,
  closeJobHandler,
  removeJobHandler,
  listPlacementsHandler,
  listAgencyLedgerHandler,
  listSmsLogsHandler,
  getReportsHandler,
  getStatsHandler,
  listUsersHandler,
};
