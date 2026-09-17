'use strict';

const { SubscriptionPlan, Employer, Agency } = require('../models');
const AppError = require('../errors/AppError');

/**
 * Seed plans created once, only if the `SubscriptionPlan` collection
 * is completely empty (fresh install, or an existing deployment
 * migrating off the old hardcoded basic/premium/enterprise object).
 * Keeps the same keys/values the old hardcoded tiers used, so existing
 * `Employer.subscriptionTier` / `Agency.subscriptionTier` values
 * ('basic'/'premium'/'enterprise') keep resolving to the same
 * entitlements they always did — after this, the database rows are
 * the only source of truth and admin is free to rename, delete, or add
 * to them.
 */
const SEED_PLANS = [
  {
    key: 'basic', name: 'Basic', description: 'Get started with essential hiring tools.',
    price: 0, billingCycle: 'monthly', audience: 'both',
    features: ['Post up to 3 open jobs', 'Standard candidate search'],
    maxOpenJobs: 3, canAdvertise: false, maxPageSize: 10, maxVisibleResults: 20,
    applicationSummaryLimit: 15, isActive: true, isDefault: true, sortOrder: 0,
  },
  {
    key: 'premium', name: 'Premium', description: 'More reach and deeper candidate search.',
    price: 5, billingCycle: 'monthly', audience: 'both',
    features: ['Post up to 15 open jobs', 'Deeper candidate search', 'AI applicant summaries for up to 50 applicants'],
    maxOpenJobs: 15, canAdvertise: false, maxPageSize: 50, maxVisibleResults: 200,
    applicationSummaryLimit: 50, isActive: true, isDefault: false, sortOrder: 1,
  },
  {
    key: 'enterprise', name: 'Enterprise', description: 'Unlimited hiring at scale, with promoted ads.',
    price: 5, billingCycle: 'monthly', audience: 'both',
    features: ['Unlimited open jobs', 'Unlimited candidate search', 'Run promoted ads', 'AI applicant summaries for every applicant'],
    maxOpenJobs: null, canAdvertise: true, maxPageSize: 100, maxVisibleResults: null,
    applicationSummaryLimit: null, isActive: true, isDefault: false, sortOrder: 2,
  },
];

let _seedInFlight = null;

/**
 * Ensures at least one plan exists, seeding `SEED_PLANS` the first
 * time this is ever called against an empty collection. Safe to call
 * repeatedly/concurrently (dedupes concurrent seed attempts).
 */
async function ensureSeeded() {
  if (await SubscriptionPlan.exists({})) return;
  if (!_seedInFlight) {
    _seedInFlight = SubscriptionPlan.insertMany(SEED_PLANS, { ordered: false })
      .catch((err) => {
        // Another concurrent request may have seeded first (duplicate
        // key on `key`) — that's fine, ignore. Anything else, rethrow.
        if (err?.code !== 11000) throw err;
      })
      .finally(() => { _seedInFlight = null; });
  }
  await _seedInFlight;
}

/**
 * The plan new employer/agency accounts land on, and the fallback used
 * whenever a stored `subscriptionTier` key doesn't match any existing
 * plan (e.g. it was deleted, or predates the plan it referenced).
 */
async function getDefaultPlan() {
  await ensureSeeded();
  const byFlag = await SubscriptionPlan.findOne({ isDefault: true }).sort({ sortOrder: 1 });
  if (byFlag) return byFlag;
  // No plan explicitly marked default (shouldn't normally happen —
  // `createPlan`/`updatePlan`/`deletePlan` all keep exactly one) —
  // fall back to the lowest-priced active plan, or just the first one.
  const fallback = await SubscriptionPlan.findOne({ isActive: true }).sort({ sortOrder: 1, price: 1 });
  return fallback || SubscriptionPlan.findOne().sort({ sortOrder: 1 });
}

/**
 * @param {string|undefined|null} key - an employer/agency's `subscriptionTier`
 * @returns {Promise<import('mongoose').Document>} the matching plan, or
 *   the default plan if `key` is missing/unknown.
 */
async function getPlanByKey(key) {
  await ensureSeeded();
  if (key) {
    const plan = await SubscriptionPlan.findOne({ key: String(key).toLowerCase() });
    if (plan) return plan;
  }
  return getDefaultPlan();
}

/** @returns {Promise<number|null>} max simultaneously-open jobs, or null = unlimited. */
async function getJobPostingLimit(tier) {
  const plan = await getPlanByKey(tier);
  return plan.maxOpenJobs;
}

/** @returns {Promise<boolean>} */
async function getCanAdvertise(tier) {
  const plan = await getPlanByKey(tier);
  return Boolean(plan.canAdvertise);
}

/** @returns {Promise<{ maxPageSize: number, maxVisibleResults: number|null }>} */
async function getCandidateSearchLimits(tier) {
  const plan = await getPlanByKey(tier);
  return { maxPageSize: plan.maxPageSize, maxVisibleResults: plan.maxVisibleResults };
}

/** @returns {Promise<number|null>} */
async function getApplicationSummaryLimit(tier) {
  const plan = await getPlanByKey(tier);
  return plan.applicationSummaryLimit;
}

/**
 * GET /api/v1/admin/subscription-plans
 * Every plan, in display order, regardless of active/default state —
 * the admin console needs to see and edit inactive plans too.
 */
async function listPlans() {
  await ensureSeeded();
  const plans = await SubscriptionPlan.find().sort({ sortOrder: 1, createdAt: 1 });
  return plans.map((p) => p.toJSON());
}

/**
 * GET /api/v1/subscription-plans (public/employer-facing, active only)
 */
async function listActivePlans({ audience } = {}) {
  await ensureSeeded();
  const query = { isActive: true };
  if (audience) query.audience = { $in: [audience, 'both'] };
  const plans = await SubscriptionPlan.find(query).sort({ sortOrder: 1, createdAt: 1 });
  return plans.map((p) => p.toJSON());
}

function validatePlanFields(fields, { partial = false } = {}) {
  const errors = [];
  const has = (k) => Object.prototype.hasOwnProperty.call(fields, k);

  if ((!partial || has('key')) && (!fields.key || !/^[a-z0-9-]+$/.test(String(fields.key).toLowerCase()))) {
    errors.push('key is required and may contain only lowercase letters, numbers, and hyphens');
  }
  if ((!partial || has('name')) && !fields.name?.trim()) {
    errors.push('name is required');
  }
  if (has('price') && (typeof fields.price !== 'number' || fields.price < 0)) {
    errors.push('price must be a non-negative number');
  }
  if (has('billingCycle') && !['monthly', 'yearly'].includes(fields.billingCycle)) {
    errors.push('billingCycle must be monthly or yearly');
  }
  if (has('audience') && !['employer', 'agency', 'both'].includes(fields.audience)) {
    errors.push('audience must be employer, agency, or both');
  }
  if (has('features') && !Array.isArray(fields.features)) {
    errors.push('features must be an array of strings');
  }
  if (has('maxOpenJobs') && fields.maxOpenJobs !== null
    && (!Number.isInteger(fields.maxOpenJobs) || fields.maxOpenJobs < 0)) {
    errors.push('maxOpenJobs must be a non-negative integer or null (unlimited)');
  }
  if (has('canAdvertise') && typeof fields.canAdvertise !== 'boolean') {
    errors.push('canAdvertise must be a boolean');
  }
  if (has('maxPageSize') && (!Number.isInteger(fields.maxPageSize) || fields.maxPageSize < 1)) {
    errors.push('maxPageSize must be a positive integer');
  }
  if (has('maxVisibleResults') && fields.maxVisibleResults !== null
    && (!Number.isInteger(fields.maxVisibleResults) || fields.maxVisibleResults < 0)) {
    errors.push('maxVisibleResults must be a non-negative integer or null (unlimited)');
  }
  if (has('applicationSummaryLimit') && fields.applicationSummaryLimit !== null
    && (!Number.isInteger(fields.applicationSummaryLimit) || fields.applicationSummaryLimit < 0)) {
    errors.push('applicationSummaryLimit must be a non-negative integer or null (unlimited)');
  }
  if (has('isActive') && typeof fields.isActive !== 'boolean') {
    errors.push('isActive must be a boolean');
  }
  if (has('sortOrder') && typeof fields.sortOrder !== 'number') {
    errors.push('sortOrder must be a number');
  }

  if (errors.length) throw new AppError(errors.join('; '), 422);
}

const PLAN_FIELDS = [
  'key', 'name', 'description', 'audience', 'price', 'currency', 'billingCycle',
  'features', 'maxOpenJobs', 'canAdvertise', 'maxPageSize', 'maxVisibleResults',
  'applicationSummaryLimit', 'isActive', 'sortOrder',
];

function pickFields(source) {
  const out = {};
  for (const f of PLAN_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(source, f)) out[f] = source[f];
  }
  return out;
}

/**
 * POST /api/v1/admin/subscription-plans
 * Creates a brand-new plan. The very first plan ever created (on top
 * of the seeded defaults) is never automatically made default — admin
 * does that explicitly via `setDefaultPlan` so an accidental new plan
 * can't silently start capturing new signups.
 */
async function createPlan(fields) {
  await ensureSeeded();
  const data = pickFields(fields);
  data.key = String(data.key || '').toLowerCase().trim();
  validatePlanFields(data);

  const existing = await SubscriptionPlan.findOne({ key: data.key });
  if (existing) throw new AppError(`A plan with key "${data.key}" already exists`, 409);

  if (data.sortOrder === undefined) {
    const highest = await SubscriptionPlan.findOne().sort({ sortOrder: -1 });
    data.sortOrder = (highest?.sortOrder ?? -1) + 1;
  }

  const plan = await SubscriptionPlan.create(data);
  return plan.toJSON();
}

/**
 * PATCH /api/v1/admin/subscription-plans/:key
 * Partial update — omitted fields are left unchanged. Applies
 * immediately to every account currently on this plan (see the
 * resolver functions above, none of which cache).
 */
async function updatePlan(key, fields) {
  await ensureSeeded();
  const plan = await SubscriptionPlan.findOne({ key: String(key).toLowerCase() });
  if (!plan) throw new AppError(`No plan found with key "${key}"`, 404);

  const data = pickFields(fields);
  // Renaming the key isn't allowed via update — it's the stable
  // identifier already stored on every subscribed account.
  delete data.key;
  validatePlanFields(data, { partial: true });

  Object.assign(plan, data);
  await plan.save();
  return plan.toJSON();
}

/**
 * DELETE /api/v1/admin/subscription-plans/:key
 * Refuses to delete the default plan (there must always be one), and
 * moves any accounts currently on this plan to the default plan first
 * so nobody is left pointing at a plan that no longer exists.
 */
async function deletePlan(key) {
  await ensureSeeded();
  const plan = await SubscriptionPlan.findOne({ key: String(key).toLowerCase() });
  if (!plan) throw new AppError(`No plan found with key "${key}"`, 404);
  if (plan.isDefault) {
    throw new AppError('Cannot delete the default plan — set another plan as default first', 422);
  }

  const totalPlans = await SubscriptionPlan.countDocuments();
  if (totalPlans <= 1) {
    throw new AppError('Cannot delete the only remaining plan', 422);
  }

  const defaultPlan = await getDefaultPlan();
  await Promise.all([
    Employer.updateMany({ subscriptionTier: plan.key }, { subscriptionTier: defaultPlan.key }),
    Agency.updateMany({ subscriptionTier: plan.key }, { subscriptionTier: defaultPlan.key }),
  ]);
  await SubscriptionPlan.deleteOne({ _id: plan._id });
  return { deleted: true, reassignedTo: defaultPlan.key };
}

/**
 * POST /api/v1/admin/subscription-plans/:key/set-default
 * Moves the `isDefault` flag to this plan and off every other one —
 * exactly one plan is default at all times.
 */
async function setDefaultPlan(key) {
  await ensureSeeded();
  const plan = await SubscriptionPlan.findOne({ key: String(key).toLowerCase() });
  if (!plan) throw new AppError(`No plan found with key "${key}"`, 404);
  if (!plan.isActive) {
    throw new AppError('Cannot make an inactive plan the default — activate it first', 422);
  }

  await SubscriptionPlan.updateMany({ _id: { $ne: plan._id } }, { isDefault: false });
  plan.isDefault = true;
  await plan.save();
  return plan.toJSON();
}

/**
 * PATCH /api/v1/admin/subscription-plans/reorder
 * @param {string[]} orderedKeys - every plan key, in the desired display order.
 */
async function reorderPlans(orderedKeys) {
  await ensureSeeded();
  if (!Array.isArray(orderedKeys) || orderedKeys.length === 0) {
    throw new AppError('orderedKeys must be a non-empty array', 422);
  }
  const normalized = orderedKeys.map((k) => String(k).toLowerCase());
  const count = await SubscriptionPlan.countDocuments({ key: { $in: normalized } });
  if (count !== normalized.length) {
    throw new AppError('orderedKeys contains a key that does not match any plan', 422);
  }

  await Promise.all(
    normalized.map((key, index) => SubscriptionPlan.updateOne({ key }, { sortOrder: index })),
  );
  return listPlans();
}

module.exports = {
  getJobPostingLimit,
  getCanAdvertise,
  getCandidateSearchLimits,
  getApplicationSummaryLimit,
  getPlanByKey,
  getDefaultPlan,
  listPlans,
  listActivePlans,
  createPlan,
  updatePlan,
  deletePlan,
  setDefaultPlan,
  reorderPlans,
};
