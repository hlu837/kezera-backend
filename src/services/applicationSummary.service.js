'use strict';

const { Application, Seeker } = require('../models');
const AppError = require('../errors/AppError');
const { resolveSubscriptionTier } = require('../utils/resolveSubscriptionTier');
const { getApplicationSummaryLimit } = require('./subscriptionPlan.service');
const { getHighestGpa } = require('../utils/gpa.util');
const { generateApplicantSummaries } = require('./ai.service');

/**
 * Supported values for the `sortBy` option on summarizeApplicationsForJob.
 * Controls both (a) which applicants are prioritized for the limited,
 * tier-capped AI-narrative slots (see APPLICATION_SUMMARY_LIMITS), and
 * (b) the order `aiSummaries`/`topApplicants` come back in. Applicants
 * missing the requested field (e.g. no GPA entered) sort to the end
 * rather than being dropped, so switching sort order never hides someone
 * who simply hasn't filled that field in.
 */
// Ordinal ranking so 'experience' sort has a well-defined order — higher
// is more senior. Unset/unrecognized levels rank lowest, same "missing
// sorts last" behavior the GPA comparator below uses.
const EXPERIENCE_RANK = { entry: 1, mid: 2, senior: 3 };
function experienceRank(level) {
  return EXPERIENCE_RANK[level] || 0;
}

const SORT_COMPARATORS = {
  recent: () => 0, // already newest-first from the query below; no-op
  gpa: (a, b) => (b.gpa ?? -1) - (a.gpa ?? -1),
  experience: (a, b) => experienceRank(b.experienceLevel) - experienceRank(a.experienceLevel),
};

/**
 * Tallies frequency of a field across applicants into a sorted
 * `{ value, count }[]` (descending by count) — shared shape for the
 * skills/city/experienceLevel breakdowns below.
 *
 * @param {Array<string|null>} values
 * @param {number} [top] - cap the returned list to the top N entries
 */
function tally(values, top = 10) {
  const counts = new Map();
  for (const value of values) {
    if (!value) continue;
    counts.set(value, (counts.get(value) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, top)
    .map(([value, count]) => ({ value, count }));
}

/**
 * GET /api/v1/jobs/:id/applications/summary
 * Employer/agency-facing analysis of everyone who applied to one job.
 * Ownership (this job is *yours*) and the `job.applicationSummaryEnabled`
 * opt-in are both checked by the caller
 * (applications.controller.js#getApplicationSummaryHandler), same split
 * as every other job-scoped applications endpoint.
 *
 * Two layers, priced very differently:
 *  - Structured stats (experience level / skills / city breakdown) are
 *    a cheap aggregation over EVERY applicant, regardless of tier — see
 *    utils/subscriptionTiers.js's comment on why only the AI portion is
 *    capped.
 *  - The AI-written narrative (ai.service.js) costs a real API call, so
 *    it only runs for the first `getApplicationSummaryLimit(tier)`
 *    applicants — newest first by default, or ranked by GPA/experience
 *    if `sortBy` is set (see below) — `summaryLimitReached` tells the
 *    client there's more to unlock on a higher tier.
 *
 * A seeker's GPA lives per-education-entry (`Seeker.education[].gpa`,
 * since one person can have multiple degrees) rather than as a single
 * profile field — `getHighestGpa` below takes the best one they've
 * entered as their representative GPA for ranking/display. It's
 * optional, so applicants who haven't entered one simply sort last
 * under `sortBy: 'gpa'` rather than being excluded.
 *
 * @param {string} jobId
 * @param {{ id: string, role: string }} requester - req.user
 * @param {{ title: string, description: string, skillsRequired: string[] }} job
 *   - already fetched/ownership-checked by the caller
 * @param {{ sortBy?: 'recent'|'gpa'|'experience' }} [options] - which
 *   applicants get priority for the tier-capped AI slots, and the order
 *   `aiSummaries`/`topApplicants` are returned in. Defaults to 'recent'
 *   (newest application first), unchanged from before this option existed.
 */
async function summarizeApplicationsForJob(jobId, requester, job, options = {}) {
  const sortBy = SORT_COMPARATORS[options.sortBy] ? options.sortBy : 'recent';
  const applications = await Application.find({ jobId })
    .sort({ createdAt: -1 })
    .populate({
      path: 'seekerId',
      select: 'fullName city skills experienceLevel bio experience education',
    });

  const totalApplicants = applications.length;

  let seekers = applications
    .map((app) => (app.seekerId && typeof app.seekerId === 'object' ? app.seekerId.toJSON() : null))
    .filter(Boolean)
    // `gpa` isn't a field the Seeker model stores directly (see the doc
    // comment above) — computed once here so every downstream use
    // (sorting, structured stats, the AI prompt) reads the same value.
    .map((s) => ({ ...s, gpa: getHighestGpa(s) }));

  // Applied after the base newest-first query above — 'recent' is a
  // no-op comparator so the original order survives untouched, while
  // 'gpa'/'experience' re-rank the whole applicant list, missing values
  // sorting last (see SORT_COMPARATORS' doc comment).
  seekers = [...seekers].sort(SORT_COMPARATORS[sortBy]);

  const gpaValues = seekers.map((s) => s.gpa).filter((g) => g != null);

  const structuredStats = {
    totalApplicants,
    byExperienceLevel: tally(seekers.map((s) => s.experienceLevel)),
    topSkills: tally(seekers.flatMap((s) => s.skills || [])),
    byCity: tally(seekers.map((s) => s.city)),
    // GPA-specific view: how many applicants actually reported one, the
    // pool average among those who did, and a ranked shortlist so an
    // employer can see "who's top by GPA" at a glance without having to
    // set sortBy just to peek. `average` is null (not 0) when nobody has
    // entered a GPA, same "missing means unknown, not zero" convention
    // as `gpa` itself.
    gpa: {
      reportedCount: gpaValues.length,
      average: gpaValues.length > 0
        ? Math.round((gpaValues.reduce((sum, g) => sum + g, 0) / gpaValues.length) * 100) / 100
        : null,
      topApplicants: [...seekers]
        .filter((s) => s.gpa != null)
        .sort((a, b) => b.gpa - a.gpa)
        .slice(0, 5)
        .map((s) => ({ seekerId: s.id, fullName: s.fullName, gpa: s.gpa })),
    },
  };

  if (totalApplicants === 0) {
    return {
      structuredStats,
      sortBy,
      aiSummaries: [],
      aiAvailable: true,
      summaryLimit: null,
      summaryLimitReached: false,
      subscriptionTier: await resolveSubscriptionTier(requester),
    };
  }

  const tier = await resolveSubscriptionTier(requester);
  const summaryLimit = await getApplicationSummaryLimit(tier);
  const candidatesForAi = summaryLimit === null ? seekers : seekers.slice(0, summaryLimit);

  const { available, summaries, error } = await generateApplicantSummaries({
    jobTitle: job.title,
    jobDescription: job.description,
    skillsRequired: job.skillsRequired || [],
    candidates: candidatesForAi.map((s) => ({
      seekerId: s.id,
      fullName: s.fullName,
      bio: s.bio,
      city: s.city,
      experienceLevel: s.experienceLevel,
      skills: s.skills || [],
      experience: s.experience || [],
      education: s.education || [],
      gpa: s.gpa,
    })),
  });

  const aiSummaries = candidatesForAi.map((s) => {
    const entry = summaries.get(s.id);
    return {
      seekerId: s.id,
      fullName: s.fullName,
      gpa: s.gpa,
      summary: entry?.summary ?? null,
      strengths: entry?.strengths ?? [],
      fitScore: entry?.fitScore ?? null,
    };
  });

  return {
    structuredStats,
    sortBy,
    aiSummaries,
    aiAvailable: available,
    aiError: available ? undefined : error,
    subscriptionTier: tier,
    summaryLimit,
    summaryLimitReached: summaryLimit !== null && totalApplicants > summaryLimit,
  };
}

/**
 * Thin ownership/opt-in guard shared by the controller — kept here
 * rather than duplicated inline so both the summary endpoint and (if
 * ever needed) a future one enforce the exact same rule.
 *
 * @param {object|null} job - already fetched via jobsService.getJobById
 * @param {string} requesterId
 */
function assertSummaryAllowed(job, requesterId) {
  if (!job || job.creatorId !== requesterId) {
    throw new AppError('Job not found or you do not have permission to view it', 404);
  }
  if (!job.applicationSummaryEnabled) {
    throw new AppError(
      'Application summaries are not enabled for this job. Turn it on in the job\'s settings first.',
      400,
    );
  }
}

module.exports = { summarizeApplicationsForJob, assertSummaryAllowed };
