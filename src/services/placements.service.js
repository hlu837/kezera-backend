'use strict';

const { Placement, Agency } = require('../models');
const { attachLastSeen, attachPhone } = require('../utils/attachLastSeen');

/**
 * Persists the matching worker's ranked shortlist into `placements`
 * with status 'matched'.
 *
 * Upserts on (jobId, seekerId) so re-running matching for the same job
 * (e.g. the posting was edited and re-queued) refreshes the score
 * instead of piling up duplicates. A seeker who has already moved past
 * 'matched' in the pipeline (sent/hired/rejected) is deliberately left
 * untouched — replicated here as two bulk passes since Mongo has no
 * single-statement equivalent of Postgres'
 * `ON CONFLICT (...) DO UPDATE ... WHERE placements.status = 'matched'`:
 *
 *   1. Refresh the score on any existing placement that's still
 *      'matched' (filter includes `status: 'matched'`, so a placement
 *      that has already progressed is never touched here).
 *   2. Upsert-insert only: filter on (jobId, seekerId) alone (no status
 *      condition) with `$setOnInsert` only, so this is a strict no-op
 *      against any existing document — matched or otherwise — and only
 *      ever creates a new row when none exists yet. This is what keeps
 *      pass 1 and pass 2 together from ever duplicate-inserting or
 *      reviving a placement that moved past 'matched' some other way.
 *
 * @param {string} jobId
 * @param {string|null} agencyId - job.creatorId when creatorType = 'agency', else null
 * @param {Array<{ seekerId: string, score: number }>} candidates - ranked, best first
 * @returns {Promise<number>} number of documents inserted/updated
 */
async function saveMatchedPlacements(jobId, agencyId, candidates) {
  if (!candidates || candidates.length === 0) {
    return 0;
  }

  const refreshOps = candidates.map((candidate) => ({
    updateOne: {
      filter: { jobId, seekerId: candidate.seekerId, status: 'matched' },
      update: { $set: { score: candidate.score } },
    },
  }));
  const refreshResult = await Placement.bulkWrite(refreshOps, { ordered: false });

  const insertOnlyOps = candidates.map((candidate) => ({
    updateOne: {
      filter: { jobId, seekerId: candidate.seekerId },
      update: {
        $setOnInsert: {
          jobId,
          seekerId: candidate.seekerId,
          agencyId: agencyId || null,
          status: 'matched',
          score: candidate.score,
        },
      },
      upsert: true,
    },
  }));
  const insertResult = await Placement.bulkWrite(insertOnlyOps, { ordered: false });

  return (refreshResult.modifiedCount || 0) + (insertResult.upsertedCount || 0);
}

/**
 * GET /api/v1/jobs/:id/suggested-seekers
 * Ranked list of matched candidates for a job, joined with the seeker's
 * public profile fields the client needs to render a shortlist.
 * Ordering: best score first, ties broken by earliest match.
 *
 * MongoDB's BSON comparison order sorts `null` below every number, so
 * a plain descending sort on `score` already puts unscored placements
 * last — the equivalent of the old `ORDER BY score DESC NULLS LAST`.
 *
 * @param {string} jobId
 * @param {{ requesterRole?: string, requesterId?: string }} [caller] -
 *   req.user.role/req.user.id of whoever is asking (already verified
 *   upstream in jobs.controller.js to own this job). Used only to
 *   decide phone-number visibility — see the `attachPhone` call below.
 * @returns {Promise<Array<object>>}
 */
async function getSuggestedSeekers(jobId, { requesterRole, requesterId } = {}) {
  const placements = await Placement.find({ jobId })
    .sort({ score: -1, createdAt: 1 })
    // `userId` included so attachLastSeen (below) can resolve each
    // candidate's last-seen timestamp; `agencyId` so phone visibility
    // (below) can tell which candidates are this requester's own
    // roster — neither is otherwise part of the response shape.
    .populate('seekerId', 'fullName city skills cvUrl photoUrl userId agencyId');

  const results = placements.map((placement) => {
    // `seekerId` was populated above, so at this point it's the Seeker
    // sub-document rather than a bare id — split it back out into a
    // flat shape (placement fields + the seeker's public fields),
    // mirroring the old joined-row shape. Read fields directly off the
    // live document rather than via placement.toJSON(), since that
    // transform's `seekerId.toString()` assumes an un-populated ref.
    const seeker = placement.seekerId && typeof placement.seekerId === 'object'
      ? placement.seekerId.toJSON()
      : null;

    return {
      placementId: placement._id.toString(),
      jobId: placement.jobId.toString(),
      seekerId: seeker ? seeker.id : placement.seekerId?.toString() ?? null,
      // Carried only so attachLastSeen (below) has something to key
      // on — stripped back out before this is returned.
      userId: seeker?.userId ?? null,
      // Which agency (if any) registered THIS candidate as a walk-in —
      // distinct from `agencyId` below (the JOB's owning agency; this
      // job may have been posted by an employer, or by a different
      // agency than the one that registered the candidate). Carried
      // only so the phone-visibility check below has something to
      // compare against; stripped back out before this is returned.
      seekerAgencyId: seeker?.agencyId ?? null,
      agencyId: placement.agencyId ? placement.agencyId.toString() : null,
      status: placement.status,
      score: placement.score,
      createdAt: placement.createdAt,
      fullName: seeker?.fullName ?? null,
      city: seeker?.city ?? null,
      skills: seeker?.skills ?? [],
      cvUrl: seeker?.cvUrl ?? null,
      photoUrl: seeker?.photoUrl ?? null,
    };
  });

  await attachLastSeen(results);

  // Phone is only ever shown to the agency that actually registered
  // the candidate — i.e. its own roster — same "legitimate
  // relationship" rule `attachPhone`'s own doc comment describes for
  // agency.service.js#listCandidates. The job's poster otherwise (an
  // employer, or a different agency than the one that registered this
  // particular candidate) sees everything else on this shortlist but
  // never the phone number.
  if (requesterRole === 'agency' && requesterId) {
    const requestingAgency = await Agency.findOne({ userId: requesterId }).select('_id');
    if (requestingAgency) {
      const requestingAgencyId = requestingAgency._id.toString();
      const ownRosterRows = results.filter((r) => r.seekerAgencyId === requestingAgencyId);
      await attachPhone(ownRosterRows);
    }
  }

  results.forEach((r) => {
    delete r.userId;
    delete r.seekerAgencyId;
  });

  return results;
}

/**
 * POST /api/v1/jobs/:id/invite-candidate
 * Employer/agency-initiated counterpart to `saveMatchedPlacements` above:
 * same upsert-only shape (never revives or overwrites a placement that
 * already exists for this (jobId, seekerId) pair, matched or otherwise),
 * just triggered by a person clicking "Message" on a search result
 * instead of the matching worker. `score: null` distinguishes a
 * self-initiated placement from an algorithm-ranked one wherever score
 * is displayed.
 *
 * @param {string} jobId
 * @param {string|null} agencyId - same meaning as in saveMatchedPlacements
 * @param {string} seekerId
 * @returns {Promise<string>} the placement's id, existing or newly created
 */
async function inviteCandidate(jobId, agencyId, seekerId) {
  const placement = await Placement.findOneAndUpdate(
    { jobId, seekerId },
    {
      $setOnInsert: {
        jobId,
        seekerId,
        agencyId: agencyId || null,
        status: 'matched',
        score: null,
      },
    },
    { upsert: true, new: true },
  );
  return placement._id.toString();
}

module.exports = { saveMatchedPlacements, getSuggestedSeekers, inviteCandidate };
