'use strict';

const crypto = require('crypto');
const bcrypt = require('bcrypt');
const { mongoose } = require('../config/mongoose');
const { User, Seeker, Agency, Job, Placement, AgencyFinancial } = require('../models');
const { PLACEMENT_STATUS_TRANSITIONS } = require('../models/Placement.model');
const storageService = require('./storage.service');
const notificationsService = require('./notifications.service');
const { sanitizeFilename } = require('../utils/file.util');
const { attachLastSeen, attachPhone } = require('../utils/attachLastSeen');
const env = require('../config/env');
const AppError = require('../errors/AppError');

/**
 * Looks up the Agency profile doc for the authenticated agency user.
 * Every endpoint in this service is scoped to "this agency's own
 * candidates", so this resolution happens first and is never trusted
 * from the request body — always derived from `req.user.id` (JWT sub),
 * same pattern as seeker.service.js/employer.service.js using
 * `req.user.id` as the Mongoose filter rather than a client-supplied id.
 *
 * @param {string} agencyUserId - req.user.id of the authenticated agency user
 * @returns {Promise<import('mongoose').Document>}
 */
async function getAgencyOrThrow(agencyUserId) {
  const agency = await Agency.findOne({ userId: agencyUserId });
  if (!agency) {
    // Should only happen if an `agency`-role JWT exists without a
    // matching Agency profile doc — a data-integrity issue, not a
    // normal 404 a client should expect to hit in practice.
    throw new AppError('Agency profile not found for the authenticated user', 404);
  }
  return agency;
}

/**
 * Generates a random password for walk-in candidates who weren't given
 * one at registration time. It's never returned in any API response —
 * it only exists to satisfy passwordHash's `required` constraint on the
 * User model. The candidate can self-register a *different* login later
 * via the normal password-reset flow if/when one is added; today they'd
 * need an agency worker's help to log in, which matches how a walk-in
 * desk registration is expected to work.
 */
function generateRandomPassword() {
  return crypto.randomBytes(24).toString('base64url');
}

// Wire format (request body / Joi-validated) -> schema field name.
// Mirrors employer.service.js's UPDATABLE_FIELD_MAP.
const PROFILE_UPDATABLE_FIELD_MAP = {
  agency_name: 'agencyName',
  operational_city: 'operationalCity',
  backoffice_phone: 'backofficePhone',
  bio: 'bio',
};

/**
 * GET /api/v1/agencies/me
 * Mirrors employer.service.js#getMyProfile.
 *
 * @param {string} agencyUserId - req.user.id (JWT sub)
 */
async function getMyProfile(agencyUserId) {
  const agency = await getAgencyOrThrow(agencyUserId);
  return agency.toJSON();
}

/**
 * POST /api/v1/agencies/profile
 * Partial update — only fields present in `updates` are touched.
 * Mirrors employer.service.js#updateMyProfile.
 *
 * @param {string} agencyUserId - req.user.id (JWT sub)
 * @param {{ agency_name?: string, operational_city?: string, backoffice_phone?: string, bio?: string }} updates - already Joi-validated
 */
async function updateMyProfile(agencyUserId, updates) {
  const fields = Object.keys(updates);
  if (fields.length === 0) {
    throw new AppError('No updatable fields provided', 422);
  }

  const setDoc = {};
  for (const field of fields) {
    setDoc[PROFILE_UPDATABLE_FIELD_MAP[field] || field] = updates[field];
  }

  const agency = await Agency.findOneAndUpdate(
    { userId: agencyUserId },
    { $set: setDoc },
    { new: true, runValidators: true },
  );

  if (!agency) {
    throw new AppError('Agency profile not found', 404);
  }
  return agency.toJSON();
}

/**
 * POST /api/v1/agencies/logo
 * Mirrors employer.service.js#uploadLogo. `file` has already passed
 * multer's field/mimetype check and the magic-byte signature check
 * (upload.middleware.js) by the time it reaches here.
 *
 * @param {string} agencyUserId - req.user.id (JWT sub)
 * @param {Express.Multer.File} file
 */
async function uploadLogo(agencyUserId, file) {
  const { safeName } = sanitizeFilename(file.originalname);
  const key = `agencies/${agencyUserId}/logo/${safeName}`;
  const url = await storageService.uploadBuffer(file.buffer, key, file.mimetype);

  const agency = await Agency.findOneAndUpdate(
    { userId: agencyUserId },
    { $set: { logoUrl: url } },
    { new: true, runValidators: true },
  );

  if (!agency) {
    throw new AppError('Agency profile not found', 404);
  }
  return agency.toJSON();
}

/**
 * True once the agency has a public-facing bio or logo — either one is
 * enough. Backs the "complete your public profile before posting a job"
 * gate (see requireAgencyPublicProfile.middleware.js). Treats a
 * whitespace-only bio the same as no bio, same as the KYC file fields
 * elsewhere in this model.
 *
 * @param {{ bio?: string|null, logoUrl?: string|null }} agency
 */
function hasPublicProfile(agency) {
  return Boolean((agency.bio && agency.bio.trim()) || agency.logoUrl);
}

/**
 * POST /api/v1/jobs/create gate (agency callers only — see
 * requireAgencyPublicProfile.middleware.js, the only caller of this).
 * An agency may post once it either has a complete public profile
 * (bio or logo) or has posted at least one job before — the latter
 * grandfathers in agencies that were already active before this
 * requirement shipped, so it only ever blocks agencies posting their
 * first job from here on.
 *
 * @param {string} agencyUserId - req.user.id (JWT sub)
 */
async function canPostJob(agencyUserId) {
  const agency = await getAgencyOrThrow(agencyUserId);
  if (hasPublicProfile(agency)) return true;

  const hasExistingJob = await Job.exists({
    creatorId: agencyUserId,
    creatorType: 'agency',
  });
  return Boolean(hasExistingJob);
}

/**
 * POST /api/v1/agencies/walk-in
 * Registers a candidate who visited the agency's office in person:
 * creates the shared `User` (role: 'seeker') and their `Seeker` profile
 * atomically in one Mongo transaction — the same
 * `session.withTransaction` pattern auth.service.js#register uses for
 * self-service registration — then (outside the transaction, since S3
 * isn't transactional) uploads any attached bio-data files and attaches
 * their URLs to the new profile.
 *
 * The profile is always created with `availabilityStatus: true`
 * (a walk-in candidate is, by definition, presenting themselves as
 * available right now) and `agencyId` set to this agency, regardless of
 * what the request body contains — both are enforced server-side, not
 * accepted as input.
 *
 * @param {string} agencyUserId - req.user.id of the authenticated agency user
 * @param {{
 *   full_name: string, phone: string, email?: string, password?: string,
 *   bio?: string, city?: string, skills?: string[],
 *   experience_level?: string, preferred_categories?: string[]
 * }} body - already Joi-validated (walkInSchema)
 * @param {{ cv?: Express.Multer.File[], photo?: Express.Multer.File[] }} [files]
 * @returns {Promise<{ user: object, profile: object }>}
 */
async function registerWalkIn(agencyUserId, body, files = {}) {
  const agency = await getAgencyOrThrow(agencyUserId);

  const passwordHash = await bcrypt.hash(
    body.password || generateRandomPassword(),
    env.bcrypt.saltRounds,
  );

  const session = await mongoose.startSession();

  let user;
  let profile;

  try {
    await session.withTransaction(async () => {
      const [createdUser] = await User.create(
        [{
          phone: body.phone,
          email: body.email || null,
          passwordHash,
          role: 'seeker',
        }],
        { session },
      );
      user = createdUser;

      const [createdProfile] = await Seeker.create(
        [{
          userId: user._id,
          fullName: body.full_name,
          bio: body.bio || null,
          city: body.city || null,
          skills: body.skills || [],
          experienceLevel: body.experience_level || null,
          preferredCategories: body.preferred_categories || [],
          agencyId: agency._id,
          // Forced true regardless of payload — see function doc above.
          availabilityStatus: true,
        }],
        { session },
      );
      profile = createdProfile;
    });
  } catch (err) {
    // Same E11000 -> 409 translation as auth.service.js#register, so a
    // duplicate phone/email produces the same clean error shape whether
    // the seeker self-registered or an agency registered them.
    if (err.code === 11000) {
      const field = Object.keys(err.keyPattern || {})[0] || 'value';
      throw new AppError(`A user with this ${field} already exists`, 409);
    }
    throw err;
  } finally {
    await session.endSession();
  }

  // Bio-data (CV) and/or photo are optional on this endpoint — an agency
  // worker may register the candidate now and attach documents later.
  // Uploaded after the transaction commits (S3 writes can't participate
  // in it), mirroring seeker.service.js#handleUpload's upload-then-persist
  // shape.
  const uploads = {};
  const fieldByUpload = { cv: 'cvUrl', photo: 'photoUrl' };

  for (const field of ['cv', 'photo']) {
    const file = files[field]?.[0];
    if (!file) continue;

    const { safeName } = sanitizeFilename(file.originalname);
    const key = `seekers/${user._id}/${field}/${safeName}`;
    const url = await storageService.uploadBuffer(file.buffer, key, file.mimetype);
    uploads[fieldByUpload[field]] = url;
  }

  if (Object.keys(uploads).length > 0) {
    profile = await Seeker.findOneAndUpdate(
      { _id: profile._id },
      { $set: uploads },
      { new: true, runValidators: true },
    );
  }

  return { user: user.toJSON(), profile: profile.toJSON() };
}

// Wire format (request body / Joi-validated) -> schema field name.
// Reused by listCandidates below for the free-text `keyword` match.
const SEARCHABLE_TEXT_FIELDS = ['fullName', 'bio'];

/**
 * GET /api/v1/agencies/candidates
 * Fetches the authenticated agency's candidate roster — every Seeker
 * whose `agencyId` points at this agency — with pagination and the same
 * optional search filters as seeker.service.js#searchSeekers
 * (experienceLevel/city/keyword), plus an availability toggle.
 *
 * Unlike `searchSeekers` (a hiring-pool endpoint for employers/agencies
 * browsing candidates in general), this is NOT restricted to
 * `availabilityStatus: true` by default — an agency needs to see and
 * manage its whole roster, including candidates already placed
 * elsewhere or marked unavailable. It also attaches each candidate's
 * `phone` (see `attachPhone` above) — every candidate here is either a
 * walk-in the agency registered themselves or one otherwise tied to
 * this agency, so, unlike the general candidate-search pool, the agency
 * already has a legitimate reason to see (and call/text) the number.
 *
 * @param {string} agencyUserId - req.user.id of the authenticated agency user
 * @param {{
 *   experience_level?: string, city?: string, keyword?: string,
 *   availability_status?: boolean, page: number, limit: number
 * }} filters - already Joi-validated (listCandidatesSchema)
 */
async function listCandidates(agencyUserId, filters) {
  const agency = await getAgencyOrThrow(agencyUserId);
  const {
    experience_level: experienceLevel, city, keyword, availability_status: availabilityStatus, page, limit,
  } = filters;

  const query = { agencyId: agency._id };

  if (typeof availabilityStatus === 'boolean') {
    query.availabilityStatus = availabilityStatus;
  }

  if (experienceLevel) {
    query.experienceLevel = experienceLevel;
  }

  if (city) {
    // Case-insensitive partial match, same as searchSeekers's `ILIKE %city%` equivalent.
    query.city = new RegExp(city.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  }

  if (keyword) {
    const pattern = new RegExp(keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    query.$or = SEARCHABLE_TEXT_FIELDS.map((field) => ({ [field]: pattern }));
  }

  const skip = (page - 1) * limit;

  const [candidates, total] = await Promise.all([
    Seeker.find(query).sort({ updatedAt: -1 }).skip(skip).limit(limit),
    Seeker.countDocuments(query),
  ]);

  const candidateJson = candidates.map((doc) => doc.toJSON());
  await Promise.all([attachLastSeen(candidateJson), attachPhone(candidateJson)]);

  return {
    candidates: candidateJson,
    page,
    limit,
    total,
    totalPages: Math.max(1, Math.ceil(total / limit)),
  };
}

/**
 * POST /api/v1/agencies/dispatch
 * Sends a shortlist of this agency's already-matched candidates to a
 * job's poster: flips each (jobId, seekerId) placement from 'matched'
 * to 'sent' — only those two states are a valid transition here, so a
 * seeker who was never matched to this job, or who has already moved
 * past 'matched' (sent/hired/rejected), is silently skipped rather than
 * erroring the whole batch — then fans out the interview-instruction
 * SMS to each dispatched candidate and one summary alert to the job's
 * poster, reusing notifications.service.js#dispatchCandidateAlerts (the
 * same function the matching worker uses after an automated match run,
 * so a manually-curated agency dispatch and an automated one produce
 * identical candidate/poster messaging).
 *
 * Ownership: restricted to jobs THIS agency posted (`job.creatorId`
 * points at the agency's own User doc — see Job.model.js — and
 * `job.creatorType === 'agency'`), mirroring the ownership check
 * jobs.service.js#updateJob and jobs.controller.js#getSuggestedSeekersHandler
 * use elsewhere. An agency dispatching on an employer-posted job is out
 * of scope for this endpoint.
 *
 * @param {string} agencyUserId - req.user.id of the authenticated agency user
 * @param {string} jobId
 * @param {string[]} seekerIds
 * @returns {Promise<{
 *   jobId: string,
 *   dispatched: string[],
 *   skipped: Array<{ seekerId: string, reason: string }>,
 *   notifications: object,
 * }>}
 */
async function dispatchCandidates(agencyUserId, jobId, seekerIds) {
  const agency = await getAgencyOrThrow(agencyUserId);

  const job = await Job.findById(jobId).select('creatorId creatorType');
  if (!job || job.creatorId.toString() !== agencyUserId || job.creatorType !== 'agency') {
    // Deliberately vague, mirroring jobs.service.js#updateJob: don't
    // reveal whether the job exists but belongs to someone else, vs.
    // doesn't exist at all.
    throw new AppError('Job not found or you do not have permission to dispatch for it', 404);
  }

  // Only placements currently 'matched' for THIS job are eligible —
  // scoping the initial lookup to agencyId as well guards against a
  // seekerId that has a 'matched' placement on this job but was matched
  // under a different agency's run (shouldn't normally happen given how
  // saveMatchedPlacements stamps agencyId, but cheap to make explicit).
  const eligiblePlacements = await Placement.find({
    jobId,
    seekerId: { $in: seekerIds },
    status: 'matched',
    agencyId: agency._id,
  }).select('seekerId');

  const eligibleSeekerIds = new Set(eligiblePlacements.map((p) => p.seekerId.toString()));
  const skipped = seekerIds
    .filter((id) => !eligibleSeekerIds.has(id))
    .map((seekerId) => ({
      seekerId,
      reason: 'No matched placement found for this job/agency (already dispatched, not matched, or invalid)',
    }));

  let dispatched = [];
  if (eligibleSeekerIds.size > 0) {
    const dispatchedIds = [...eligibleSeekerIds];
    const sentAt = new Date();

    await Placement.updateMany(
      { jobId, seekerId: { $in: dispatchedIds }, status: 'matched', agencyId: agency._id },
      { $set: { status: 'sent', sentAt } },
    );

    dispatched = dispatchedIds;
  }

  // Notifications are best-effort and never roll back the status
  // change above — the placements are genuinely 'sent' from this
  // agency's operational standpoint even if, say, the SMS provider is
  // down; dispatchCandidateAlerts already isolates per-candidate SMS
  // failures internally (see its doc comment) and reports them back
  // here rather than throwing.
  let notifications = {
    smsAttempted: 0,
    smsSent: 0,
    smsFailed: [],
    posterEmailSent: false,
    posterEmailError: null,
  };

  if (dispatched.length > 0) {
    const dispatchedSeekers = await Seeker.find({ _id: { $in: dispatched } }).select('userId fullName');
    const candidateList = dispatchedSeekers.map((seeker) => ({
      seekerId: seeker._id.toString(),
      userId: seeker.userId.toString(),
      fullName: seeker.fullName,
    }));

    notifications = await notificationsService.dispatchCandidateAlerts(jobId, candidateList);
  }

  return { jobId, dispatched, skipped, notifications };
}

/**
 * Amount sign applied to `Agency.ledgerBalance` per transaction type.
 * `AgencyFinancial.amount` is always stored as a positive magnitude
 * (see AgencyFinancial.model.js) — this map is the single place that
 * decides whether a given type credits or debits the running balance.
 * Both current types are money collected BY the agency (a walk-in fee
 * paid at the desk, or a commission earned on a successful placement),
 * so both credit the balance today; a future debit-type entry (e.g. a
 * payout/withdrawal) would simply add a `-1` here without touching any
 * other code in `recordLedgerEntry`.
 */
const LEDGER_SIGN_BY_TRANSACTION_TYPE = {
  registration_fee: 1,
  commission: 1,
};

/**
 * POST /api/v1/agencies/finance/ledger
 * Records one financial event and atomically applies its effect to
 * `Agency.ledgerBalance` — both writes happen inside a single Mongo
 * transaction (same `session.withTransaction` pattern as
 * auth.service.js#register / agency.service.js#registerWalkIn) so the
 * ledger and the running balance can never drift apart, even under
 * concurrent requests or a mid-write crash.
 *
 * @param {string} agencyUserId - req.user.id of the authenticated agency user
 * @param {{
 *   amount: number, transaction_type: 'registration_fee'|'commission',
 *   description?: string, date?: Date
 * }} body - already Joi-validated (ledgerEntrySchema)
 * @returns {Promise<{ entry: object, ledgerBalance: number }>}
 */
async function recordLedgerEntry(agencyUserId, body) {
  const agency = await getAgencyOrThrow(agencyUserId);

  const sign = LEDGER_SIGN_BY_TRANSACTION_TYPE[body.transaction_type];
  const balanceDelta = sign * body.amount;

  const session = await mongoose.startSession();

  let entry;
  let updatedAgency;

  try {
    await session.withTransaction(async () => {
      [entry] = await AgencyFinancial.create(
        [{
          agencyId: agency._id,
          amount: body.amount,
          transactionType: body.transaction_type,
          description: body.description || null,
          date: body.date || new Date(),
        }],
        { session },
      );

      // `ledgerBalance` has `min: 0` on the Agency schema (see
      // Agency.model.js) — `runValidators` enforces that here too, so
      // a debit-type entry (once one exists) that would overdraw the
      // agency's balance is rejected and the whole transaction rolls
      // back, rather than silently going negative.
      updatedAgency = await Agency.findOneAndUpdate(
        { _id: agency._id },
        { $inc: { ledgerBalance: balanceDelta } },
        { new: true, runValidators: true, session },
      );

      if (!updatedAgency) {
        throw new AppError('Agency not found while updating ledger balance', 404);
      }
    });
  } finally {
    await session.endSession();
  }

  return { entry: entry.toJSON(), ledgerBalance: updatedAgency.ledgerBalance };
}

/**
 * Resolves the [start, end) UTC boundaries of the calendar day
 * containing `referenceDate` (defaults to now). Every daily aggregation
 * below shares this helper so "today" always means the exact same
 * window across the walk-in count, dispatch count, placement count, and
 * revenue breakdown.
 *
 * @param {Date} [referenceDate]
 * @returns {{ start: Date, end: Date }}
 */
function getDayBounds(referenceDate = new Date()) {
  const start = new Date(Date.UTC(
    referenceDate.getUTCFullYear(),
    referenceDate.getUTCMonth(),
    referenceDate.getUTCDate(),
  ));
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 1);
  return { start, end };
}

/**
 * GET /api/v1/agencies/dashboard/stats
 * Real-time daily operational KPIs for the authenticated agency:
 *   - walkInsRegisteredToday: Seeker docs created with this agency's
 *     `agencyId` today (see agency.service.js#registerWalkIn).
 *   - dispatchesSentToday: Placements this agency flipped to 'sent'
 *     today (`sentAt`, not `updatedAt` — see Placement.model.js's doc
 *     comment on that field for why).
 *   - successfulPlacementsToday: Placements that reached 'hired' today.
 *     `hired` is a terminal status (no code path transitions a
 *     placement away from it), so `updatedAt` reliably reflects the
 *     moment it became 'hired' with no risk of a later change moving it
 *     out of today's window.
 *   - revenue: today's `AgencyFinancial` entries, broken down by
 *     transaction type plus a combined net total, computed with a
 *     single `$facet` aggregation pipeline (one round trip covers both
 *     the per-type breakdown and the overall sum).
 *
 * All three collections' queries and the aggregation's `$match` share
 * the exact same `[start, end)` Date range from `getDayBounds` — the
 * "parameterized date filters" the task calls for, as opposed to
 * building date strings/values by hand differently in each place.
 *
 * @param {string} agencyUserId - req.user.id of the authenticated agency user
 * @param {{ date?: Date }} filters - already Joi-validated (dashboardStatsQuerySchema)
 */
async function getDashboardStats(agencyUserId, filters = {}) {
  const agency = await getAgencyOrThrow(agencyUserId);
  const { start, end } = getDayBounds(filters.date);

  const [
    walkInsRegisteredToday,
    dispatchesSentToday,
    successfulPlacementsToday,
    revenueFacets,
  ] = await Promise.all([
    Seeker.countDocuments({
      agencyId: agency._id,
      createdAt: { $gte: start, $lt: end },
    }),
    Placement.countDocuments({
      agencyId: agency._id,
      status: 'sent',
      sentAt: { $gte: start, $lt: end },
    }),
    Placement.countDocuments({
      agencyId: agency._id,
      status: 'hired',
      updatedAt: { $gte: start, $lt: end },
    }),
    AgencyFinancial.aggregate([
      { $match: { agencyId: agency._id, date: { $gte: start, $lt: end } } },
      {
        $facet: {
          byType: [
            {
              $group: {
                _id: '$transactionType',
                total: { $sum: '$amount' },
                count: { $sum: 1 },
              },
            },
          ],
          overall: [
            {
              $group: {
                _id: null,
                total: { $sum: '$amount' },
                count: { $sum: 1 },
              },
            },
          ],
        },
      },
    ]),
  ]);

  // $facet always returns exactly one document (even when every branch
  // is empty), but each branch's array is empty when there's no
  // matching data for the day — default to zeroes rather than leaving
  // fields undefined in the response.
  const facetResult = revenueFacets[0] || { byType: [], overall: [] };
  const revenueByType = { registration_fee: 0, commission: 0 };
  for (const bucket of facetResult.byType) {
    revenueByType[bucket._id] = bucket.total;
  }
  const netRevenueToday = facetResult.overall[0]?.total || 0;

  return {
    date: start.toISOString().slice(0, 10),
    walkInsRegisteredToday,
    dispatchesSentToday,
    successfulPlacementsToday,
    revenue: {
      registrationFeesToday: revenueByType.registration_fee,
      commissionsToday: revenueByType.commission,
      netRevenueToday,
    },
    ledgerBalance: agency.ledgerBalance,
  };
}

/**
 * PATCH /api/v1/agencies/placements/:id/status
 * Manually advances a placement past 'sent' — to 'interviewed', or
 * straight to 'hired'/'rejected'. 'matched' -> 'sent' is deliberately
 * NOT reachable through this endpoint; that transition only ever
 * happens automatically (dispatchCandidates above, or the inbound-SMS
 * webhook accepting on the candidate's behalf).
 *
 * Ownership: only placements belonging to THIS agency (`agencyId`) can
 * be updated — mirrors the ownership check dispatchCandidates uses for
 * jobs. The transition itself is validated against
 * PLACEMENT_STATUS_TRANSITIONS so, e.g., a placement that's already
 * 'hired' can't be silently moved back to 'interviewed'.
 *
 * @param {string} agencyUserId - req.user.id of the authenticated agency user
 * @param {string} placementId
 * @param {'interviewed'|'hired'|'rejected'} newStatus
 * @returns {Promise<object>} the updated placement, `.toJSON()`-shaped
 */
async function updatePlacementStatus(agencyUserId, placementId, newStatus) {
  const agency = await getAgencyOrThrow(agencyUserId);

  const placement = await Placement.findOne({ _id: placementId, agencyId: agency._id });
  if (!placement) {
    // Deliberately vague — mirrors dispatchCandidates: don't reveal
    // whether the placement exists but belongs to another agency, vs.
    // doesn't exist at all.
    throw new AppError('Placement not found or you do not have permission to update it', 404);
  }

  const allowedNextStatuses = PLACEMENT_STATUS_TRANSITIONS[placement.status] || [];
  if (!allowedNextStatuses.includes(newStatus)) {
    throw new AppError(
      `Cannot move a placement from '${placement.status}' to '${newStatus}'. `
        + `Valid next status(es) from '${placement.status}': `
        + `${allowedNextStatuses.length > 0 ? allowedNextStatuses.join(', ') : 'none (terminal status)'}.`,
      409,
    );
  }

  placement.status = newStatus;
  await placement.save();

  return placement.toJSON();
}

module.exports = {
  getMyProfile,
  updateMyProfile,
  uploadLogo,
  hasPublicProfile,
  canPostJob,
  registerWalkIn,
  listCandidates,
  dispatchCandidates,
  recordLedgerEntry,
  getDashboardStats,
  updatePlacementStatus,
};
