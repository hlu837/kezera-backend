'use strict';

const { SavedSearch, Seeker } = require('../models');
const AppError = require('../errors/AppError');

// Wire format (request body / Joi-validated) -> schema field name.
const FIELD_MAP = {
  name: 'name',
  keyword: 'keyword',
  location: 'location',
  job_type: 'jobType',
  experience_level: 'experienceLevel',
  alerts_enabled: 'alertsEnabled',
};

/**
 * Resolves the caller's Seeker profile id from their User id (JWT
 * subject). Every saved-search operation is scoped to this, mirroring
 * seeker.service.js's own `getSeekerOrThrow`-style pattern.
 *
 * @param {string} userId - req.user.id
 * @returns {Promise<string>} seeker._id
 */
async function getSeekerIdOrThrow(userId) {
  const seeker = await Seeker.findOne({ userId }).select('_id');
  if (!seeker) {
    throw new AppError('Seeker profile not found', 404);
  }
  return seeker._id;
}

/**
 * POST /api/v1/seekers/saved-searches
 *
 * @param {string} userId - req.user.id
 * @param {object} payload - already Joi-validated (createSavedSearchSchema)
 */
async function createSavedSearch(userId, payload) {
  const seekerId = await getSeekerIdOrThrow(userId);

  const doc = await SavedSearch.create({
    seekerId,
    name: payload.name || null,
    keyword: payload.keyword || null,
    location: payload.location || null,
    jobType: payload.job_type || null,
    experienceLevel: payload.experience_level || null,
    alertsEnabled: payload.alerts_enabled,
  });

  return doc.toJSON();
}

/**
 * GET /api/v1/seekers/saved-searches
 * Every saved search belonging to the caller, newest first.
 *
 * @param {string} userId - req.user.id
 */
async function listSavedSearches(userId) {
  const seekerId = await getSeekerIdOrThrow(userId);
  const docs = await SavedSearch.find({ seekerId }).sort({ createdAt: -1 });
  return docs.map((doc) => doc.toJSON());
}

/**
 * PATCH /api/v1/seekers/saved-searches/:id
 * Ownership is enforced in the query itself (filter on both _id and
 * seekerId) rather than a separate find-then-update, same TOCTOU-safe
 * pattern as jobs.service.js#updateJob.
 *
 * @param {string} userId - req.user.id
 * @param {string} savedSearchId
 * @param {object} updates - already Joi-validated (updateSavedSearchSchema)
 */
async function updateSavedSearch(userId, savedSearchId, updates) {
  const seekerId = await getSeekerIdOrThrow(userId);

  const fields = Object.keys(updates);
  if (fields.length === 0) {
    throw new AppError('No updatable fields provided', 422);
  }

  const setDoc = {};
  for (const field of fields) {
    setDoc[FIELD_MAP[field] || field] = updates[field];
  }

  const doc = await SavedSearch.findOneAndUpdate(
    { _id: savedSearchId, seekerId },
    { $set: setDoc },
    { new: true, runValidators: true },
  );

  if (!doc) {
    // Deliberately vague: don't reveal whether the saved search exists
    // but belongs to someone else, vs. doesn't exist at all — same
    // convention as jobs.service.js#updateJob.
    throw new AppError('Saved search not found or you do not have permission to modify it', 404);
  }
  return doc.toJSON();
}

/**
 * DELETE /api/v1/seekers/saved-searches/:id
 *
 * @param {string} userId - req.user.id
 * @param {string} savedSearchId
 */
async function deleteSavedSearch(userId, savedSearchId) {
  const seekerId = await getSeekerIdOrThrow(userId);

  const doc = await SavedSearch.findOneAndDelete({ _id: savedSearchId, seekerId });
  if (!doc) {
    throw new AppError('Saved search not found or you do not have permission to delete it', 404);
  }
  return doc.toJSON();
}

module.exports = {
  createSavedSearch,
  listSavedSearches,
  updateSavedSearch,
  deleteSavedSearch,
};
