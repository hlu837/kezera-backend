'use strict';

const { Job, Seeker } = require('../models');
const AppError = require('../errors/AppError');

/**
 * Normalizes a skill string for comparison (trim + lowercase), so
 * "React", " react", and "REACT " are all treated as the same skill
 * regardless of how each side entered it.
 * @param {string} skill
 */
function normalizeSkill(skill) {
  return String(skill).trim().toLowerCase();
}

/**
 * Loads the job's matching-relevant fields.
 * Throws if the job doesn't exist — a matching run for a nonexistent
 * job is a data/programming error upstream, not a "zero candidates"
 * result, so it's surfaced distinctly.
 *
 * @param {string} jobId
 * @returns {Promise<{id: string, creatorId: string, creatorType: 'employer'|'agency', title: string, location: string, jobType: string, skillsRequired: string[], status: string}>}
 */
async function getJobForMatching(jobId) {
  const job = await Job.findById(jobId).select(
    'creatorId creatorType title location jobType skillsRequired status',
  );

  if (!job) {
    throw new AppError(`Job ${jobId} not found`, 404);
  }
  return job.toJSON();
}

/**
 * Loads the candidate pool to score against a job.
 *
 * Pre-filtered at the DB level to keep the in-memory scoring pass cheap:
 *   - `availabilityStatus: true` — never suggest a seeker who has
 *     marked themselves unavailable.
 *   - `skills: { $in: requiredSkills }` — the seeker must share AT
 *     LEAST ONE required skill ("any of" containment, backed by the
 *     `skills` index on the Seeker model). Seekers with zero overlap
 *     can never outscore ones with partial overlap, so excluding them
 *     up front is a safe optimization, not an approximation.
 *
 * The precise weighted score (partial-match ratio + location bonus) is
 * computed in application code in `scoreCandidate`, since it doesn't
 * map cleanly onto a single query.
 *
 * @param {string[]} requiredSkills - already normalized job.skillsRequired
 * @returns {Promise<Array<object>>}
 */
async function getCandidatePool(requiredSkills) {
  const query = { availabilityStatus: true };

  // Job has no listed skill requirements — every available seeker is
  // a candidate; scoring falls back to location match only.
  if (requiredSkills && requiredSkills.length > 0) {
    query.skills = { $in: requiredSkills };
  }

  const candidates = await Seeker.find(query).select(
    'userId fullName city skills cvUrl photoUrl',
  );

  return candidates.map((doc) => doc.toJSON());
}

/**
 * Scores a single seeker against a job's requirements.
 *
 * Weighting (deliberately simple and easy to tune later):
 *   - 80% of the score: fraction of the job's required skills the
 *     seeker actually has (skills intersection / total required).
 *   - 20% bonus: exact location/city match. A well-matched local
 *     candidate is usually more useful than a perfectly-skilled one
 *     who isn't in the right place for site-based work.
 *
 * @param {{ skillsRequired: string[], location: string }} job
 * @param {{ skills: string[], city: string }} seeker
 * @returns {{ score: number, matchedSkills: string[], skillMatchRatio: number, locationMatch: boolean }}
 */
function scoreCandidate(job, seeker) {
  const SKILL_WEIGHT = 0.8;
  const LOCATION_WEIGHT = 0.2;

  const requiredSkills = (job.skillsRequired || []).map(normalizeSkill);
  const seekerSkillSet = new Set((seeker.skills || []).map(normalizeSkill));

  const matchedSkills = requiredSkills.filter((skill) => seekerSkillSet.has(skill));
  const skillMatchRatio = requiredSkills.length > 0
    ? matchedSkills.length / requiredSkills.length
    : 0;

  const locationMatch = Boolean(
    job.location
      && seeker.city
      && job.location.trim().toLowerCase() === seeker.city.trim().toLowerCase(),
  );

  const score = (skillMatchRatio * SKILL_WEIGHT) + (locationMatch ? LOCATION_WEIGHT : 0);

  return {
    score: Number(score.toFixed(4)),
    matchedSkills,
    skillMatchRatio: Number(skillMatchRatio.toFixed(4)),
    locationMatch,
  };
}

/**
 * Core matching algorithm consumed by the `JOB_MATCHING` worker task.
 *
 * @param {string} jobId
 * @param {{ topN?: number, minScore?: number }} [options]
 *   topN - max candidates to return (default 20).
 *   minScore - exclusive lower bound; candidates scoring at or below
 *     this are dropped entirely rather than padding the list with
 *     zero-relevance matches (default 0).
 * @returns {Promise<{ job: object, candidates: Array<object>, evaluatedCount: number }>}
 */
async function matchCandidatesForJob(jobId, options = {}) {
  const { topN = 20, minScore = 0 } = options;

  const job = await getJobForMatching(jobId);
  const requiredSkills = (job.skillsRequired || []).map(normalizeSkill);
  const candidatePool = await getCandidatePool(requiredSkills);

  const ranked = candidatePool
    .map((seeker) => {
      const { score, matchedSkills, skillMatchRatio, locationMatch } = scoreCandidate(job, seeker);
      return {
        seekerId: seeker.id,
        userId: seeker.userId,
        fullName: seeker.fullName,
        city: seeker.city,
        cvUrl: seeker.cvUrl,
        photoUrl: seeker.photoUrl,
        score,
        skillMatchRatio,
        matchedSkills,
        locationMatch,
      };
    })
    .filter((candidate) => candidate.score > minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, topN);

  return { job, candidates: ranked, evaluatedCount: candidatePool.length };
}

module.exports = {
  matchCandidatesForJob,
  scoreCandidate,
  normalizeSkill,
};
