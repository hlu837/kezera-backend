'use strict';

const User = require('../models/User.model');

/**
 * Batch-attaches `lastSeenAt` (from User.lastActiveAt — see
 * middleware/auth.middleware.js#touchLastActive) onto a list of
 * seeker-shaped plain objects, keyed by each object's `userId`.
 *
 * One query for the whole batch rather than N+1 — every call site here
 * is already a list endpoint (candidate search, agency roster, a job's
 * applications, suggested-seekers), so this scales with page size, not
 * with a per-seeker lookup.
 *
 * @param {Array<Record<string, any>>} items - objects with a `userId`
 *   string field (e.g. Seeker.toJSON() output). Mutated in place and
 *   also returned for convenient chaining.
 * @returns {Promise<Array<Record<string, any>>>}
 */
async function attachLastSeen(items) {
  const userIds = [...new Set(items.map((item) => item?.userId).filter(Boolean))];

  if (userIds.length === 0) {
    return items;
  }

  const users = await User.find({ _id: { $in: userIds } }).select('_id lastActiveAt');
  const lastActiveById = new Map(users.map((u) => [u._id.toString(), u.lastActiveAt || null]));

  items.forEach((item) => {
    if (item) {
      item.lastSeenAt = lastActiveById.get(item.userId) || null;
    }
  });

  return items;
}

/**
 * Batch-attaches `phone` (from User.phone) onto a list of seeker-shaped
 * plain objects, keyed by each object's `userId`. Same one-query-per-batch
 * shape as `attachLastSeen` above.
 *
 * Deliberately a separate function rather than folded into
 * `attachLastSeen` — `lastSeenAt` is safe to show on any candidate list
 * (employer/agency public search included), but a phone number is
 * contact info that should only be surfaced where the caller already
 * has a legitimate relationship with the seeker. Today that's just the
 * agency's own roster (`agency.service.js#listCandidates`) — callers
 * should not wire this into the general `GET /seekers/search` pool.
 *
 * @param {Array<Record<string, any>>} items - objects with a `userId`
 *   string field (e.g. Seeker.toJSON() output). Mutated in place and
 *   also returned for convenient chaining.
 * @returns {Promise<Array<Record<string, any>>>}
 */
async function attachPhone(items) {
  const userIds = [...new Set(items.map((item) => item?.userId).filter(Boolean))];

  if (userIds.length === 0) {
    return items;
  }

  const users = await User.find({ _id: { $in: userIds } }).select('_id phone');
  const phoneById = new Map(users.map((u) => [u._id.toString(), u.phone || null]));

  items.forEach((item) => {
    if (item) {
      item.phone = phoneById.get(item.userId) || null;
    }
  });

  return items;
}

module.exports = { attachLastSeen, attachPhone };
