'use strict';

const { Router } = require('express');
const { authenticate } = require('../middleware/auth.middleware');
const { authorizeRoles } = require('../middleware/rbac.middleware');
const { validateBody, validateQuery } = require('../middleware/validate.middleware');
const {
  updateSubscriptionSchema, updateAccountStatusSchema, listAccountsQuerySchema,
  listUsersQuerySchema,
  createPlanSchema, updatePlanSchema, reorderPlansSchema,
  listJobsQuerySchema, removeJobSchema,
  listPlacementsQuerySchema, listAgencyLedgerQuerySchema, listSmsLogsQuerySchema,
  getReportsQuerySchema,
} = require('../validators/admin.validator');
const { rejectAdSchema, listAdsQuerySchema } = require('../validators/ads.validator');
const {
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
  getStatsHandler,
  listUsersHandler,
  listJobsHandler,
  closeJobHandler,
  removeJobHandler,
  listPlacementsHandler,
  listAgencyLedgerHandler,
  listSmsLogsHandler,
  getReportsHandler,
} = require('../controllers/admin.controller');

const router = Router();

// All admin routes require a valid JWT AND the `admin` role.
router.use(authenticate, authorizeRoles('admin'));

// GET /api/v1/admin/stats — total users, active job listings, placements
// this month (see admin.service.js#getPlatformStats). Backs the
// dashboard's stat cards.
router.get('/stats', getStatsHandler);

// GET /api/v1/admin/users?role=seeker|employer|agency|admin&search=...
// The Users page — every account on the platform. Distinct from
// /accounts below, which is scoped to employer/agency and tier-enriched
// for the Subscriptions page.
router.get('/users', validateQuery(listUsersQuerySchema), listUsersHandler);

// GET /api/v1/admin/verifications?status=pending
router.get('/verifications', listVerificationsHandler);

// POST /api/v1/admin/verifications/:userId/approve
router.post('/verifications/:userId/approve', approveHandler);

// POST /api/v1/admin/verifications/:userId/reject  { reason: "..." }
router.post('/verifications/:userId/reject', rejectHandler);

// "Subscriptions & Services" console — admin's two levers over
// employer/agency plans:
//   1. subscription-plans/*  — admin fully owns this: how many plans
//      exist, their names/prices/benefits, and the limits behind them
//      (e.g. "Premium = up to 15 open jobs"). Editing/deleting a plan
//      applies immediately to everyone currently on it.
//   2. accounts/*            — one ACCOUNT's assigned plan, and whether
//      that account is currently active or suspended.

// GET /api/v1/admin/subscription-plans
router.get('/subscription-plans', listTierPlansHandler);

// POST /api/v1/admin/subscription-plans  { key, name, price, features, ... }
router.post(
  '/subscription-plans',
  validateBody(createPlanSchema),
  createTierPlanHandler,
);

// PATCH /api/v1/admin/subscription-plans/reorder  { orderedKeys: string[] }
// Registered before the `:key` route below so "reorder" is never
// mistaken for a plan key.
router.patch(
  '/subscription-plans/reorder',
  validateBody(reorderPlansSchema),
  reorderTierPlansHandler,
);

// POST /api/v1/admin/subscription-plans/:key/set-default
router.post('/subscription-plans/:key/set-default', setDefaultTierPlanHandler);

// PATCH /api/v1/admin/subscription-plans/:key  { name?, price?, maxOpenJobs?, ... }
router.patch(
  '/subscription-plans/:key',
  validateBody(updatePlanSchema),
  updateTierPlanHandler,
);

// DELETE /api/v1/admin/subscription-plans/:key
router.delete('/subscription-plans/:key', deleteTierPlanHandler);

// GET /api/v1/admin/accounts?role=employer|agency&search=...
router.get('/accounts', validateQuery(listAccountsQuerySchema), listAccountsHandler);

// PATCH /api/v1/admin/accounts/:userId/subscription  { tier: "..." }
router.patch(
  '/accounts/:userId/subscription',
  validateBody(updateSubscriptionSchema),
  updateSubscriptionHandler,
);

// PATCH /api/v1/admin/accounts/:userId/status  { status: "...", reason?: "..." }
router.patch(
  '/accounts/:userId/status',
  validateBody(updateAccountStatusSchema),
  updateAccountStatusHandler,
);

// Ad moderation queue — an ad only reaches here (pending_review) after
// the owning employer/agency has already paid for it (see
// payment.routes.js#initialize-ad); admin's job is just approve/reject.

// GET /api/v1/admin/ads?status=pending_review
router.get('/ads', validateQuery(listAdsQuerySchema), listAdsHandler);

// POST /api/v1/admin/ads/:adId/approve
router.post('/ads/:adId/approve', approveAdHandler);

// POST /api/v1/admin/ads/:adId/reject  { reason: "..." }
router.post('/ads/:adId/reject', validateBody(rejectAdSchema), rejectAdHandler);

// Read-only oversight of employer/agency <-> seeker chat, per the
// platform policy that admin can review any conversation. Deliberately
// separate from the participant-scoped `/placements/:id/messages`
// route (placements.routes.js) — admin is never a participant, and
// must not trigger that route's "mark as read" side effect.

// GET /api/v1/admin/conversations?page=1&limit=20
router.get('/conversations', listConversationsHandler);

// GET /api/v1/admin/conversations/:placementId/messages
router.get('/conversations/:placementId/messages', listConversationMessagesHandler);

// "Job Listings" oversight page — browse/search/filter every job on
// the platform regardless of status or who posted it, then close or
// remove one directly (independent of the poster's own ownership-scoped
// PATCH /jobs/:id). See admin.service.js#listAllJobsForAdmin,
// #closeJobAsAdmin, #removeJobAsAdmin.

// GET /api/v1/admin/jobs?status=&creator_type=&search=&page=&limit=
router.get('/jobs', validateQuery(listJobsQuerySchema), listJobsHandler);

// POST /api/v1/admin/jobs/:jobId/close
router.post('/jobs/:jobId/close', closeJobHandler);

// POST /api/v1/admin/jobs/:jobId/remove  { reason?: "..." }
router.post('/jobs/:jobId/remove', validateBody(removeJobSchema), removeJobHandler);

// "Placements" oversight page — read-only, platform-wide view into the
// matching-engine/agency-dispatch pipeline and the agency financial
// ledger behind it. See admin.service.js#listAllPlacementsForAdmin /
// #listAgencyLedgerForAdmin for why this stays view-only (no admin-driven
// status transitions).

// GET /api/v1/admin/placements?status=&agency_only=&page=&limit=
router.get('/placements', validateQuery(listPlacementsQuerySchema), listPlacementsHandler);

// GET /api/v1/admin/agency-ledger?transaction_type=&agency_id=&page=&limit=
router.get('/agency-ledger', validateQuery(listAgencyLedgerQuerySchema), listAgencyLedgerHandler);

// "SMS Logs" debugging page — every inbound SMS webhook delivery
// (InboundSmsEvent.model.js), read-only, platform-wide. See
// admin.service.js#listSmsLogsForAdmin for why this is inbound-only.

// GET /api/v1/admin/sms-logs?matched=&search=&page=&limit=
router.get('/sms-logs', validateQuery(listSmsLogsQuerySchema), listSmsLogsHandler);

// "Reports" page — growth, conversion, and payment analytics over a
// trailing window. See admin.service.js#getReportsForAdmin.

// GET /api/v1/admin/reports?days=
router.get('/reports', validateQuery(getReportsQuerySchema), getReportsHandler);

module.exports = router;
