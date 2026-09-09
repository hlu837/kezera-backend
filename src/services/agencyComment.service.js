'use strict';

const { Agency, AgencyComment, Seeker, Employer } = require('../models');
const AppError = require('../errors/AppError');

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
    'userId agencyName operationalCity bio logoUrl',
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
  return {
    id: agency.userId.toString(),
    agencyName: agency.agencyName,
    operationalCity: agency.operationalCity,
    bio: agency.bio,
    logoUrl: agency.logoUrl,
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
  getPublicProfile,
  listComments,
  createComment,
  deleteComment,
};
