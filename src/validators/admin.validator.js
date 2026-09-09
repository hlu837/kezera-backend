'use strict';

const Joi = require('joi');

/**
 * PATCH /api/v1/admin/accounts/:userId/subscription
 * `tier` is any existing plan `key` — validity is checked against the
 * live `SubscriptionPlan` list in admin.service.js#updateSubscriptionTier
 * rather than a hardcoded enum, since admin can add/rename/delete
 * plans at runtime.
 */
const updateSubscriptionSchema = Joi.object({
  tier: Joi.string().trim().lowercase().min(1).max(64).required(),
});

/**
 * PATCH /api/v1/admin/accounts/:userId/status
 * `reason` is optional at the schema level — admin.service.js#setAccountStatus
 * enforces it's present specifically when `status === 'suspended'`,
 * since a reason doesn't make sense (and shouldn't be required) when
 * reactivating an account.
 */
const updateAccountStatusSchema = Joi.object({
  status: Joi.string().valid('active', 'suspended').required(),
  reason: Joi.string().trim().max(1000).allow('').optional(),
});

/** GET /api/v1/admin/accounts?role=employer|agency&search=... */
const listAccountsQuerySchema = Joi.object({
  role: Joi.string().valid('employer', 'agency').optional(),
  search: Joi.string().trim().max(200).allow('').optional(),
});

/** GET /api/v1/admin/users?role=seeker|employer|agency|admin&search=... */
const listUsersQuerySchema = Joi.object({
  role: Joi.string().valid('seeker', 'employer', 'agency', 'admin').optional(),
  search: Joi.string().trim().max(200).allow('').optional(),
});

/**
 * GET /api/v1/admin/jobs?status=&creator_type=&search=&page=&limit=
 * `status` intentionally includes 'removed' (unlike jobs.validator.js's
 * owner-facing UPDATABLE_STATUSES) since admin needs to be able to
 * filter down to what it has already taken down.
 */
const listJobsQuerySchema = Joi.object({
  status: Joi.string().valid('open', 'closed', 'draft', 'removed').optional(),
  creator_type: Joi.string().valid('employer', 'agency').optional(),
  search: Joi.string().trim().max(200).allow('').optional(),
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(100).default(20),
});

/** POST /api/v1/admin/jobs/:jobId/remove  { reason? } */
const removeJobSchema = Joi.object({
  reason: Joi.string().trim().max(1000).allow('').optional(),
});

/**
 * GET /api/v1/admin/placements?status=&agency_only=&page=&limit=
 * Backs the "Placements" oversight page's Placements tab — every row in
 * the matching-engine/agency-dispatch pipeline (Placement.model.js),
 * platform-wide.
 */
const listPlacementsQuerySchema = Joi.object({
  status: Joi.string().valid('matched', 'sent', 'interviewed', 'hired', 'rejected').optional(),
  agency_only: Joi.boolean().optional(),
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(100).default(20),
});

/**
 * GET /api/v1/admin/agency-ledger?transaction_type=&agency_id=&page=&limit=
 * Backs the same page's Financial Ledger tab — every
 * AgencyFinancial.model.js row, across every agency (unlike an
 * agency's own GET /agencies/financials/ledger, scoped to `req.user`).
 */
const listAgencyLedgerQuerySchema = Joi.object({
  transaction_type: Joi.string().valid('registration_fee', 'commission').optional(),
  agency_id: Joi.string().hex().length(24).optional(),
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(100).default(20),
});

/**
 * GET /api/v1/admin/sms-logs?matched=&search=&page=&limit=
 * Backs the "SMS Logs" debugging page — every InboundSmsEvent.model.js
 * row (there is currently no outbound-SMS log to pair it with).
 * `matched` filters on whether the inbound sender was resolved to a
 * known seeker (see smsInbound.service.js#findSeekerByPhone); `search`
 * free-texts against the sender's phone number.
 */
const listSmsLogsQuerySchema = Joi.object({
  matched: Joi.boolean().optional(),
  search: Joi.string().trim().max(200).allow('').optional(),
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(100).default(20),
});

/**
 * GET /api/v1/admin/reports?days=
 * Backs the "Reports" page — growth, conversion, and payment analytics
 * over a trailing window. `days` bounds match admin.service.js
 * #getReportsForAdmin's own clamping (7-180), duplicated here so a
 * bad value 400s before hitting the aggregation instead of silently
 * being clamped server-side.
 */
const getReportsQuerySchema = Joi.object({
  days: Joi.number().integer().min(7).max(180).default(30),
});

const PLAN_KEY = Joi.string().trim().lowercase().pattern(/^[a-z0-9-]+$/).min(1).max(64);

/**
 * POST /api/v1/admin/subscription-plans
 * Creates a brand-new admin-authored plan.
 */
const createPlanSchema = Joi.object({
  key: PLAN_KEY.required(),
  name: Joi.string().trim().min(1).max(80).required(),
  description: Joi.string().trim().max(500).allow('').optional(),
  audience: Joi.string().valid('employer', 'agency', 'both').optional(),
  price: Joi.number().min(0).required(),
  currency: Joi.string().trim().max(10).optional(),
  billingCycle: Joi.string().valid('monthly', 'yearly').optional(),
  features: Joi.array().items(Joi.string().trim().max(200)).max(30).optional(),
  maxOpenJobs: Joi.number().integer().min(0).allow(null).optional(),
  canAdvertise: Joi.boolean().optional(),
  maxPageSize: Joi.number().integer().min(1).optional(),
  maxVisibleResults: Joi.number().integer().min(0).allow(null).optional(),
  applicationSummaryLimit: Joi.number().integer().min(0).allow(null).optional(),
  isActive: Joi.boolean().optional(),
  sortOrder: Joi.number().optional(),
});

/**
 * PATCH /api/v1/admin/subscription-plans/:key
 * Every field optional (partial update) — `key` itself can't be
 * changed via this route (see subscriptionPlan.service.js#updatePlan).
 */
const updatePlanSchema = Joi.object({
  name: Joi.string().trim().min(1).max(80).optional(),
  description: Joi.string().trim().max(500).allow('').optional(),
  audience: Joi.string().valid('employer', 'agency', 'both').optional(),
  price: Joi.number().min(0).optional(),
  currency: Joi.string().trim().max(10).optional(),
  billingCycle: Joi.string().valid('monthly', 'yearly').optional(),
  features: Joi.array().items(Joi.string().trim().max(200)).max(30).optional(),
  maxOpenJobs: Joi.number().integer().min(0).allow(null).optional(),
  canAdvertise: Joi.boolean().optional(),
  maxPageSize: Joi.number().integer().min(1).optional(),
  maxVisibleResults: Joi.number().integer().min(0).allow(null).optional(),
  applicationSummaryLimit: Joi.number().integer().min(0).allow(null).optional(),
  isActive: Joi.boolean().optional(),
  sortOrder: Joi.number().optional(),
})
  .min(1)
  .messages({
    'object.min': 'Provide at least one field to update',
  });

/** PATCH /api/v1/admin/subscription-plans/reorder */
const reorderPlansSchema = Joi.object({
  orderedKeys: Joi.array().items(PLAN_KEY).min(1).required(),
});

module.exports = {
  updateSubscriptionSchema,
  updateAccountStatusSchema,
  listAccountsQuerySchema,
  listUsersQuerySchema,
  createPlanSchema,
  updatePlanSchema,
  reorderPlansSchema,
  listJobsQuerySchema,
  removeJobSchema,
  listPlacementsQuerySchema,
  listAgencyLedgerQuerySchema,
  listSmsLogsQuerySchema,
  getReportsQuerySchema,
};
