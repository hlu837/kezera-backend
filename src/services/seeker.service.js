'use strict';

const { Seeker, Placement } = require('../models');
const AppError = require('../errors/AppError');
const storageService = require('./storage.service');
const cvParserService = require('./cvParser.service');
const { sanitizeFilename } = require('../utils/file.util');
const { getCandidateSearchLimits } = require('./subscriptionPlan.service');
const { resolveSubscriptionTier } = require('../utils/resolveSubscriptionTier');
const { attachLastSeen } = require('../utils/attachLastSeen');

/**
 * GET /api/v1/seekers/me
 * @param {string} userId - from req.user.id (JWT sub)
 */
async function getMyProfile(userId) {
  const profile = await Seeker.findOne({ userId });
  if (!profile) {
    throw new AppError('Seeker profile not found', 404);
  }
  return profile.toJSON();
}

/**
 * Looks up a seeker by their Seeker document id (not userId) — used by
 * jobs.controller#inviteCandidateHandler to confirm a candidate the
 * employer found via `GET /seekers/search` still exists before turning
 * them into a Placement. Returns `null` rather than throwing so the
 * caller can produce its own 404 message.
 * @param {string} seekerId
 */
async function getSeekerById(seekerId) {
  const seeker = await Seeker.findById(seekerId);
  return seeker ? seeker.toJSON() : null;
}

// Wire format (request body / Joi-validated) -> schema field name.
// Keeps the API's snake_case request contract intact while the
// persistence layer underneath uses Mongoose's camelCase convention.
const UPDATABLE_FIELD_MAP = {
  full_name: 'fullName',
  bio: 'bio',
  // CV-02: seeker-editable so the CV review screen can save corrections
  // to what cvParser.service.js auto-filled on upload.
  skills: 'skills',
  city: 'city',
  experience_level: 'experienceLevel',
};

/**
 * PATCH /api/v1/seekers/me
 * Partial update — only fields present in `updates` are touched.
 *
 * @param {string} userId
 * @param {{ full_name?: string, bio?: string, skills?: string[], city?: string }} updates - already Joi-validated
 */
async function updateMyProfile(userId, updates) {
  const fields = Object.keys(updates);
  if (fields.length === 0) {
    throw new AppError('No updatable fields provided', 422);
  }

  const setDoc = {};
  for (const field of fields) {
    let value = updates[field];
    // '' means "clear it" for an enum field — Mongoose's enum validator
    // rejects '' outright, so normalize to null before it hits the model.
    if (field === 'experience_level' && value === '') {
      value = null;
    }
    setDoc[UPDATABLE_FIELD_MAP[field] || field] = value;
  }

  const profile = await Seeker.findOneAndUpdate(
    { userId },
    { $set: setDoc },
    { new: true, runValidators: true },
  );

  if (!profile) {
    throw new AppError('Seeker profile not found', 404);
  }
  return profile.toJSON();
}

/**
 * PATCH /api/v1/seekers/me/availability
 * @param {string} userId
 * @param {boolean} availabilityStatus
 */
async function updateAvailability(userId, availabilityStatus) {
  const profile = await Seeker.findOneAndUpdate(
    { userId },
    { $set: { availabilityStatus } },
    { new: true, runValidators: true },
  );

  if (!profile) {
    throw new AppError('Seeker profile not found', 404);
  }
  return profile.toJSON();
}

/**
 * PATCH /api/v1/seekers/me/preferences
 * SEEK-01 onboarding: saves the seeker's chosen job categories + their
 * location-access choice in one shot, and stamps `onboardingCompletedAt`
 * on first save (subsequent re-saves — e.g. later editing preferences
 * from settings — leave the original timestamp alone).
 *
 * @param {string} userId
 * @param {{ categories: string[], location_opt_in: boolean }} updates - already Joi-validated
 */
async function updatePreferences(userId, updates) {
  const existing = await Seeker.findOne({ userId }).select('onboardingCompletedAt');
  if (!existing) {
    throw new AppError('Seeker profile not found', 404);
  }

  const setDoc = {
    preferredCategories: updates.categories,
    locationOptIn: updates.location_opt_in,
  };
  if (!existing.onboardingCompletedAt) {
    setDoc.onboardingCompletedAt = new Date();
  }

  const profile = await Seeker.findOneAndUpdate(
    { userId },
    { $set: setDoc },
    { new: true, runValidators: true },
  );

  return profile.toJSON();
}

/**
 * Merges CV-extracted skills into whatever skills the seeker already
 * has, case-insensitively deduped, preserving the casing of whichever
 * version (existing or extracted) was seen first.
 *
 * @param {string[]} existingSkills
 * @param {string[]} extractedSkills
 * @returns {string[]}
 */
function mergeSkills(existingSkills, extractedSkills) {
  const seen = new Set();
  const merged = [];
  for (const skill of [...(existingSkills || []), ...extractedSkills]) {
    const key = skill.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    merged.push(skill);
  }
  return merged;
}

/**
 * POST /api/v1/seekers/upload
 * Uploads whichever of `cv` / `photo` were provided to S3, then persists
 * the resulting URL(s) on the seeker's document in a single update.
 *
 * When a `cv` is uploaded and it's a PDF, it's also run through
 * cvParser.service.js and used to auto-fill the profile:
 *   - `skills`: extracted skills are UNIONED with whatever the seeker
 *     already has (never removes an existing skill).
 *   - `city` / `bio`: only filled in if currently empty — a CV re-parse
 *     never clobbers a value the seeker (or an agency desk worker, see
 *     agency.service.js#registerWalkIn) already set intentionally.
 * DOCX CVs and unparseable PDFs simply skip auto-fill; the upload
 * itself always succeeds regardless of parse outcome (see
 * cvParser.service.js's contract — it never throws).
 *
 * Files are expected to have already passed multer's field/mimetype
 * filter AND the deeper signature check (see upload.middleware.js) —
 * this function trusts `files` at this point and focuses on storage
 * + persistence.
 *
 * @param {string} userId
 * @param {{ cv?: Express.Multer.File[], photo?: Express.Multer.File[] }} files
 */
async function handleUpload(userId, files) {
  const updates = {};
  const fieldByUpload = { cv: 'cvUrl', photo: 'photoUrl' };
  const cvFile = files.cv?.[0];

  // Fetch the current profile up front (only needed when a CV is being
  // uploaded) so auto-fill can merge/skip against existing values
  // instead of overwriting them.
  const existingProfile = cvFile ? await Seeker.findOne({ userId }) : null;
  if (cvFile && !existingProfile) {
    throw new AppError('Seeker profile not found', 404);
  }

  // Upload sequentially rather than Promise.all — keeps S3 request
  // volume predictable and error messages attributable to one file.
  for (const field of ['cv', 'photo']) {
    const file = files[field]?.[0];
    if (!file) continue;

    const { safeName } = sanitizeFilename(file.originalname);
    const key = `seekers/${userId}/${field}/${safeName}`;
    const url = await storageService.uploadBuffer(file.buffer, key, file.mimetype);
    updates[fieldByUpload[field]] = url;
  }

  if (Object.keys(updates).length === 0) {
    throw new AppError('At least one file (cv or photo) must be provided.', 422);
  }

  if (cvFile) {
    const { skills, city, bio } = await cvParserService.parseCv(cvFile.buffer, cvFile.mimetype);

    if (skills.length > 0) {
      updates.skills = mergeSkills(existingProfile.skills, skills);
    }
    if (city && !existingProfile.city) {
      updates.city = city;
    }
    if (bio && !existingProfile.bio) {
      updates.bio = bio;
    }
  }

  const profile = await Seeker.findOneAndUpdate(
    { userId },
    { $set: updates },
    { new: true, runValidators: true },
  );

  if (!profile) {
    throw new AppError('Seeker profile not found', 404);
  }
  return profile.toJSON();
}

/**
 * GET /api/v1/seekers/search (employer/agency only)
 * Always scoped to `availabilityStatus: true` — this endpoint is a
 * hiring pool, not a general directory. All filters are optional and
 * combined with AND; `skills` matches if the seeker has ANY of the
 * requested skills ($in, mirrors the old jsonb `?|` behavior).
 *
 * The size of the pool a caller can actually see is gated by their
 * `subscriptionTier` (see utils/subscriptionTiers.js): a Basic
 * employer/agency gets a smaller page size and can never page past
 * `maxVisibleResults`, Premium gets a larger version of the same caps,
 * and Enterprise is uncapped. Without this, every tier saw the exact
 * same unrestricted list, which defeated the point of paid plans.
 *
 * @param {{
 *   skills?: string[], city?: string, keyword?: string,
 *   page: number, limit: number
 * }} filters - already Joi-validated (searchSeekersSchema)
 * @param {{ id: string, role: string }} [requester] - req.user, used to
 *   resolve the caller's subscriptionTier
 */
async function searchSeekers(filters, requester) {
  const { skills, city, keyword, category, experienceLevel, page } = filters;

  const tier = await resolveSubscriptionTier(requester);
  const { maxPageSize, maxVisibleResults } = await getCandidateSearchLimits(tier);

  // A tier's page size caps what's requested — a Basic caller asking
  // for `?limit=100` still only gets `maxPageSize` back per page.
  const limit = Math.min(filters.limit, maxPageSize);
  const skip = (page - 1) * limit;

  // A tier's visibility ceiling caps how deep pagination can go at
  // all, independent of page size — e.g. Basic can never see past
  // candidate #20 no matter how many pages it clicks through.
  const limitReached = maxVisibleResults !== null && skip >= maxVisibleResults;
  if (limitReached) {
    return {
      seekers: [],
      page,
      limit,
      count: 0,
      subscriptionTier: tier,
      limitReached: true,
    };
  }
  const effectiveLimit =
    maxVisibleResults !== null ? Math.min(limit, maxVisibleResults - skip) : limit;

  const query = { availabilityStatus: true };

  if (skills && skills.length > 0) {
    query.skills = { $in: skills };
  }

  if (city) {
    // Case-insensitive partial match, equivalent to the old `ILIKE %city%`.
    query.city = new RegExp(city.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  }

  if (keyword) {
    const pattern = new RegExp(keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    query.$or = [{ fullName: pattern }, { bio: pattern }];
  }

  if (category) {
    query.preferredCategories = category;
  }

  if (experienceLevel) {
    query.experienceLevel = experienceLevel;
  }

  const now = new Date();

  // SEEK-xx "Boost my profile": a seeker with a currently-active
  // `boostedUntil` (paid, not yet expired) is surfaced ahead of
  // everyone else, most-recently-updated first within each group. This
  // needs an aggregation rather than a plain `.find().sort()` because
  // "is boosted" is a per-document *comparison* (`boostedUntil > now`),
  // not a stored value `.sort()` can key on directly — sorting on the
  // raw `boostedUntil` date would incorrectly rank an *expired* boost
  // above a seeker who was never boosted (a past date still sorts above
  // `null`).
  const seekers = await Seeker.aggregate([
    { $match: query },
    {
      $addFields: {
        isCurrentlyBoosted: {
          $and: [{ $ne: ['$boostedUntil', null] }, { $gt: ['$boostedUntil', now] }],
        },
      },
    },
    { $sort: { isCurrentlyBoosted: -1, updatedAt: -1 } },
    { $skip: skip },
    { $limit: effectiveLimit },
  ]);

  // toJSON()/the id+isBoosted transform live on the Mongoose document,
  // not on a plain aggregate result — rehydrate each into a model
  // instance so the response keeps the same shape as every other
  // Seeker endpoint (see Seeker.model.js's schema.set('toJSON', ...)).
  const hydrated = seekers.map((doc) => new Seeker(doc).toJSON());
  await attachLastSeen(hydrated);

  return {
    seekers: hydrated,
    page,
    limit,
    count: seekers.length,
    subscriptionTier: tier,
    // True once this page has reached the tier's visibility ceiling —
    // lets the client show an upgrade prompt instead of a dead-end
    // "Next" button.
    limitReached: maxVisibleResults !== null && skip + seekers.length >= maxVisibleResults,
  };
}

/**
 * GET /api/v1/seekers/public-search (no auth — guest landing page)
 * A capped, tier-agnostic preview of the candidate pool for anonymous
 * visitors — same query shape as `searchSeekers` above, minus the
 * subscription-tier gating (there's no logged-in caller to gate) and
 * minus `cvUrl`/`photoUrl` in the response (a guest can browse who's
 * out there, but downloading a CV or photo is a sign-up-gated action,
 * same principle as "Apply" being gated for guests on the job board).
 *
 * Fixed at a small page size with a low visibility ceiling — this is a
 * taster to pull employers/agencies into signing up, not a substitute
 * for the real (tiered) `/search` endpoint.
 *
 * @param {{ skills?: string[], city?: string, keyword?: string, page: number }} filters - already Joi-validated
 */
const PUBLIC_SEARCH_PAGE_SIZE = 12;
const PUBLIC_SEARCH_MAX_VISIBLE = 48; // 4 pages

async function publicSearchSeekers(filters) {
  const { skills, city, keyword, category, experienceLevel, page } = filters;
  const limit = PUBLIC_SEARCH_PAGE_SIZE;
  const skip = (page - 1) * limit;

  if (skip >= PUBLIC_SEARCH_MAX_VISIBLE) {
    return { seekers: [], page, limit, count: 0, limitReached: true };
  }
  const effectiveLimit = Math.min(limit, PUBLIC_SEARCH_MAX_VISIBLE - skip);

  const query = { availabilityStatus: true };

  if (skills && skills.length > 0) {
    query.skills = { $in: skills };
  }
  if (city) {
    query.city = new RegExp(city.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  }
  if (keyword) {
    const pattern = new RegExp(keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    query.$or = [{ fullName: pattern }, { bio: pattern }];
  }

  if (category) {
    query.preferredCategories = category;
  }

  if (experienceLevel) {
    query.experienceLevel = experienceLevel;
  }

  const now = new Date();

  // Same "boosted first" ordering as the authenticated search — a
  // seeker who paid to boost their profile should show up ahead of
  // everyone else here too, not just in the gated employer view.
  const seekers = await Seeker.aggregate([
    { $match: query },
    {
      $addFields: {
        isCurrentlyBoosted: {
          $and: [{ $ne: ['$boostedUntil', null] }, { $gt: ['$boostedUntil', now] }],
        },
      },
    },
    { $sort: { isCurrentlyBoosted: -1, updatedAt: -1 } },
    { $skip: skip },
    { $limit: effectiveLimit },
  ]);

  const hydrated = seekers.map((doc) => {
    const json = new Seeker(doc).toJSON();
    // Strip download/contact-adjacent fields — see doc comment above.
    delete json.cvUrl;
    delete json.photoUrl;
    return json;
  });

  return {
    seekers: hydrated,
    page,
    limit,
    count: seekers.length,
    limitReached: skip + seekers.length >= PUBLIC_SEARCH_MAX_VISIBLE,
  };
}

/**
 * GET /api/v1/seekers/me/placements
 * EMP-02: every placement this seeker is part of, newest first, with
 * just enough job context (title/location/type) to identify what
 * they're being messaged/interviewed about. This is the seeker-side
 * entry point for discovering a `placementId` to hit the
 * `/api/v1/placements/:placementId/{interviews,messages}` endpoints
 * with — before this, placements were only ever discoverable from the
 * poster's side (GET /jobs/:id/suggested-seekers), so a seeker had no
 * way to even learn a placement's id.
 *
 * @param {string} userId
 * @returns {Promise<Array<object>>}
 */
async function getMyPlacements(userId) {
  const seeker = await Seeker.findOne({ userId }).select('_id');
  if (!seeker) {
    throw new AppError('Seeker profile not found', 404);
  }

  const placements = await Placement.find({ seekerId: seeker._id })
    .sort({ createdAt: -1 })
    .populate('jobId', 'title location jobType creatorType');

  return placements.map((placement) => {
    // `jobId` was populated above, so at this point it's the Job
    // sub-document rather than a bare id — same flattening pattern as
    // placements.service.js#getSuggestedSeekers below.
    const job = placement.jobId && typeof placement.jobId === 'object'
      ? placement.jobId.toJSON()
      : null;

    return {
      placementId: placement._id.toString(),
      jobId: job ? job.id : placement.jobId?.toString() ?? null,
      jobTitle: job?.title ?? null,
      jobLocation: job?.location ?? null,
      jobType: job?.jobType ?? null,
      status: placement.status,
      createdAt: placement.createdAt,
    };
  });
}

module.exports = {
  getMyProfile,
  getSeekerById,
  updateMyProfile,
  updateAvailability,
  updatePreferences,
  handleUpload,
  searchSeekers,
  publicSearchSeekers,
  getMyPlacements,
};
