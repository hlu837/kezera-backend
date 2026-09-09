'use strict';

const { Placement, Job, Seeker } = require('../models');
const AppError = require('../errors/AppError');

/**
 * Resolves a Placement and verifies the caller is one of its two
 * participants:
 *   - the "poster": whoever owns the job (job.creatorId), i.e. the
 *     employer or agency account that posted it.
 *   - the "seeker": the candidate the placement is for
 *     (Seeker.userId).
 *
 * Shared by interviews.service.js and messaging.service.js (EMP-02),
 * since both features are scoped identically: "the two sides of this
 * placement can interact about it, no one else."
 *
 * Deliberately throws the same 404 message regardless of *why* access
 * was denied (placement doesn't exist vs. exists but caller isn't a
 * participant) — same "don't reveal existence to non-owners"
 * convention already used by jobs.service.js#updateJob and
 * agency.service.js#updatePlacementStatus.
 *
 * @param {string} placementId
 * @param {string} userId - req.user.id
 * @param {'employer'|'agency'|'admin'|'seeker'} role - req.user.role
 * @returns {Promise<{
 *   placement: object, job: object, seeker: object,
 *   viewerRole: 'poster'|'seeker'
 * }>}
 */
async function resolvePlacementForParticipant(placementId, userId, role) {
  const placement = await Placement.findById(placementId).catch(() => null);
  if (!placement) {
    throw new AppError('Placement not found or you do not have permission to access it', 404);
  }

  const [job, seeker] = await Promise.all([
    Job.findById(placement.jobId).select('creatorId creatorType title'),
    Seeker.findById(placement.seekerId).select('userId fullName'),
  ]);

  // Data-integrity edge case (the referenced Job/Seeker was deleted out
  // from under an existing Placement) rather than a normal "not found"
  // a client should ever expect to hit in practice.
  if (!job || !seeker) {
    throw new AppError('Placement references a missing job or seeker profile', 500);
  }

  const isPoster = role !== 'seeker' && job.creatorId.toString() === userId;
  const isSeeker = role === 'seeker' && seeker.userId.toString() === userId;

  if (!isPoster && !isSeeker) {
    throw new AppError('Placement not found or you do not have permission to access it', 404);
  }

  return {
    placement: placement.toJSON(),
    job: job.toJSON(),
    seeker: seeker.toJSON(),
    viewerRole: isPoster ? 'poster' : 'seeker',
  };
}

module.exports = { resolvePlacementForParticipant };
