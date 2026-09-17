'use strict';

const mongoose = require('mongoose');
const {
  Agency, AgencyComment, Seeker, Employer, User, Job,
} = require('../models');
const AppError = require('../errors/AppError');

/** Same regex-escape convention as admin.service.js#escapeRegex /
 * jobs.service.js#escapeRegex — free-text search shouldn't let a
 * user-typed `.`/`*`/etc. change what the pattern actually matches. */
function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Resolves the Agency doc from the *User* id found in the route (see
 * agencyComment.validator.js's note on `agencyId`) — same lookup
 * agency.service.js#getAgencyOrThrow does for the authenticated
 * agency's own id, just for an arbitrary/public one here.
 *
 * @param {string} agencyUserId
 */
async function getAgencyByUserIdOrThrow(agencyUserId) {
  const agency = await Agency.findOne({ userId: agencyUserId }).select(
    'userId agencyName operationalCity bio logoUrl foundedYear',
  );
  if (!agency) {
    throw new AppError('Agency not found', 404);
  }
  return agency;
}

/**
 * GET /api/v1/agencies/:agencyId/profile
 * Public — the bio/logo/name a seeker sees before deciding to apply
 * through (or comment on) this agency. No verification/KYC fields
 * (tinNumber, businessLicenseUrl) ever leave this function.
 */
async function getPublicProfile(agencyUserId) {
  const agency = await getAgencyByUserIdOrThrow(agencyUserId);
  // Seeker.agencyId stores the Agency *document's* own _id (see
  // agency.service.js#registerWalkIn's `agencyId: agency._id`), not
  // this function's agencyUserId param — using the wrong one here
  // would silently count zero candidates for every agency.
  const candidateCount = await Seeker.countDocuments({ agencyId: agency._id });
  return {
    id: agency.userId.toString(),
    agencyName: agency.agencyName,
    operationalCity: agency.operationalCity,
    bio: agency.bio,
    logoUrl: agency.logoUrl,
    foundedYear: agency.foundedYear,
    candidateCount,
  };
}

/**
 * GET /api/v1/agencies
 * Public agency directory — the "Agencies" tab on the landing page
 * (`PublicAgencyScreen`), one card per approved/active agency with the
 * key stats a visitor scans before drilling into a profile:
 * `openJobsCount` (mirrors `getJobsByAgency`'s own `open`-only filter,
 * so the number matches what they'd actually see on that agency's
 * profile), plus whatever rating/comment volume it has accumulated.
 * Optional free-text `search` matches on agency name or operational
 * city. Sorted alphabetically by name — this is a directory to browse,
 * not a feed, so there's no natural "recency" ordering to fall back to.
 *
 * Deliberately excludes any agency whose account isn't
 * `verificationStatus: 'approved'` and `accountStatus: 'active'` — an
 * unverified or suspended agency has no business appearing in a public
 * directory, even though its own profile/jobs endpoints
 * (getPublicProfile/getJobsByAgency) don't separately re-check this.
 * That's fine for those: they're only ever reached via a link from a
 * job posting or an already-known agency id, which itself implies the
 * agency passed verification to post that job in the first place. This
 * list has no such implicit filter, so the check has to live here.
 *
 * @param {{ page: number, limit: number, search?: string }} params -
 *   already Joi-validated (listAgenciesQuerySchema)
 */
async function listAgencies({ page, limit, search }) {
  const skip = (page - 1) * limit;
  const match = {};
  if (search) {
    const regex = new RegExp(escapeRegex(search), 'i');
    match.$or = [{ agencyName: regex }, { operationalCity: regex }];
  }

  const [result] = await Agency.aggregate([
    { $match: match },
    {
      $lookup: {
        from: User.collection.name,
        localField: 'userId',
        foreignField: '_id',
        as: 'user',
      },
    },
    { $unwind: '$user' },
    { $match: { 'user.verificationStatus': 'approved', 'user.accountStatus': 'active' } },
    { $sort: { agencyName: 1 } },
    {
      $facet: {
        data: [
          { $skip: skip },
          { $limit: limit },
          {
            $project: {
              _id: 0,
              id: { $toString: '$userId' },
              // The Agency document's own _id — separate from `id`
              // above (the *User* id every other public agency route
              // keys off). Needed only to look up `candidateCount`
              // below, since Seeker.agencyId stores this value, not
              // the user id (see agency.service.js#registerWalkIn's
              // `agencyId: agency._id`). Not part of the public
              // response shape — stripped out before returning.
              agencyDocId: { $toString: '$_id' },
              agencyName: 1,
              operationalCity: 1,
              bio: 1,
              logoUrl: 1,
              foundedYear: 1,
            },
          },
        ],
        totalCount: [{ $count: 'count' }],
      },
    },
  ]);

  const agencies = result.data;
  const total = result.totalCount[0]?.count ?? 0;

  if (agencies.length === 0) {
    return {
      agencies, total, page, limit,
    };
  }

  const agencyUserIds = agencies.map((a) => new mongoose.Types.ObjectId(a.id));
  const agencyDocIds = agencies.map((a) => new mongoose.Types.ObjectId(a.agencyDocId));
  const [jobCounts, commentStats, candidateCounts] = await Promise.all([
    Job.aggregate([
      { $match: { creatorId: { $in: agencyUserIds }, creatorType: 'agency', status: 'open' } },
      { $group: { _id: '$creatorId', count: { $sum: 1 } } },
    ]),
    AgencyComment.aggregate([
      { $match: { agencyId: { $in: agencyUserIds } } },
      { $group: { _id: '$agencyId', avgRating: { $avg: '$rating' }, total: { $sum: 1 } } },
    ]),
    // Keyed by the Agency doc's own _id (agencyDocId), not the user id
    // the rest of this response uses — see the $project stage above.
    Seeker.aggregate([
      { $match: { agencyId: { $in: agencyDocIds } } },
      { $group: { _id: '$agencyId', count: { $sum: 1 } } },
    ]),
  ]);

  const jobCountMap = new Map(jobCounts.map((j) => [j._id.toString(), j.count]));
  const commentMap = new Map(commentStats.map((c) => [c._id.toString(), c]));
  const candidateCountMap = new Map(candidateCounts.map((c) => [c._id.toString(), c.count]));

  for (const agency of agencies) {
    const stats = commentMap.get(agency.id);
    agency.openJobsCount = jobCountMap.get(agency.id) ?? 0;
    agency.averageRating = stats && stats.avgRating != null
      ? Math.round(stats.avgRating * 10) / 10
      : null;
    agency.commentsCount = stats ? stats.total : 0;
    agency.candidateCount = candidateCountMap.get(agency.agencyDocId) ?? 0;
    // Internal-only key used solely to build candidateCountMap above —
    // never part of the public directory response.
    delete agency.agencyDocId;
  }

  return {
    agencies, total, page, limit,
  };
}

/**
 * Resolves a display name for each distinct comment author on a page
 * of comments. Mirrors jobs.service.js#attachPosterInfo's
 * batch-lookup-then-Map pattern, extended to seeker authors (a job
 * posting never has a seeker poster, but agency comments do).
 * Mutates and returns the same array.
 */
async function attachAuthorInfo(comments) {
  if (comments.length === 0) return comments;

  const seekerIds = [];
  const employerIds = [];
  const agencyIds = [];
  for (const comment of comments) {
    if (comment.authorRole === 'seeker') seekerIds.push(comment.authorId);
    else if (comment.authorRole === 'employer') employerIds.push(comment.authorId);
    else if (comment.authorRole === 'agency') agencyIds.push(comment.authorId);
  }

  const [seekers, employers, agencies] = await Promise.all([
    seekerIds.length
      ? Seeker.find({ userId: { $in: seekerIds } }).select('userId fullName').lean()
      : [],
    employerIds.length
      ? Employer.find({ userId: { $in: employerIds } }).select('userId companyName').lean()
      : [],
    agencyIds.length
      ? Agency.find({ userId: { $in: agencyIds } }).select('userId agencyName').lean()
      : [],
  ]);

  const seekerMap = new Map(seekers.map((s) => [s.userId.toString(), s.fullName]));
  const employerMap = new Map(employers.map((e) => [e.userId.toString(), e.companyName]));
  const agencyMap = new Map(agencies.map((a) => [a.userId.toString(), a.agencyName]));

  for (const comment of comments) {
    const id = comment.authorId.toString();
    if (comment.authorRole === 'seeker') comment.authorName = seekerMap.get(id) || 'Job seeker';
    else if (comment.authorRole === 'employer') comment.authorName = employerMap.get(id) || 'Employer';
    else if (comment.authorRole === 'agency') comment.authorName = agencyMap.get(id) || 'Agency';
    else comment.authorName = 'Admin';
  }

  return comments;
}

/**
 * GET /api/v1/agencies/:agencyId/comments
 * Public, newest first, paginated. Also returns a simple average of
 * whatever ratings are present on the current page's comments — good
 * enough for a "3.8 average" label without a separate aggregation
 * query, since the page size (max 50) is small either way.
 *
 * @param {string} agencyUserId
 * @param {{page: number, limit: number}} pagination
 */
async function listComments(agencyUserId, { page, limit }) {
  await getAgencyByUserIdOrThrow(agencyUserId);

  const skip = (page - 1) * limit;
  const [docs, total] = await Promise.all([
    AgencyComment.find({ agencyId: agencyUserId })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit),
    AgencyComment.countDocuments({ agencyId: agencyUserId }),
  ]);

  const comments = docs.map((doc) => doc.toJSON());
  await attachAuthorInfo(comments);

  const ratings = comments.filter((c) => c.rating != null).map((c) => c.rating);
  const averageRating = ratings.length
    ? Math.round((ratings.reduce((sum, r) => sum + r, 0) / ratings.length) * 10) / 10
    : null;

  return {
    comments,
    total,
    page,
    limit,
    averageRating,
  };
}

/**
 * POST /api/v1/agencies/:agencyId/comments
 * Any authenticated role may comment except the agency itself —
 * commenting on your own public profile isn't a real review.
 *
 * @param {{id: string, role: string}} user - req.user
 * @param {string} agencyUserId
 * @param {{body: string, rating?: number}} payload - already
 *   Joi-validated (createAgencyCommentSchema)
 */
async function createComment(user, agencyUserId, payload) {
  await getAgencyByUserIdOrThrow(agencyUserId);

  if (user.role === 'agency' && user.id === agencyUserId) {
    throw new AppError('You cannot comment on your own agency profile', 403);
  }

  const doc = await AgencyComment.create({
    agencyId: agencyUserId,
    authorId: user.id,
    authorRole: user.role,
    body: payload.body,
    rating: payload.rating ?? null,
  });

  const comment = doc.toJSON();
  await attachAuthorInfo([comment]);
  return comment;
}

/**
 * DELETE /api/v1/agencies/:agencyId/comments/:commentId
 * The comment's own author, or an admin, may remove it.
 *
 * @param {{id: string, role: string}} user - req.user
 * @param {string} agencyUserId
 * @param {string} commentId
 */
async function deleteComment(user, agencyUserId, commentId) {
  const comment = await AgencyComment.findOne({ _id: commentId, agencyId: agencyUserId });
  if (!comment) {
    throw new AppError('Comment not found', 404);
  }

  if (comment.authorId.toString() !== user.id && user.role !== 'admin') {
    throw new AppError('You do not have permission to delete this comment', 403);
  }

  await comment.deleteOne();
}

module.exports = {
  listAgencies,
  getPublicProfile,
  listComments,
  createComment,
  deleteComment,
};
