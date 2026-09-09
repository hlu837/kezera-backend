'use strict';

const { Job, Employer, Agency } = require('../models');
const AppError = require('../errors/AppError');
const { enqueueJobMatching } = require('../queues/matching.queue');
const { enqueueJobAlerts, enqueueCategorySmsAlerts } = require('../queues/notifications.queue');
const { getJobPostingLimit } = require('./subscriptionPlan.service');
const { DEFAULT_TIER } = require('../utils/subscriptionTiers');

/** Escapes regex metacharacters so a free-text filter can't break out
 * of the intended substring match (same helper pattern already used
 * by seeker.service.js#searchSeekers). */
function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Batch-attaches a lightweight `poster` object to each job (mutating
 * the already-`.toJSON()`'d objects in place) — the posting account's
 * public profile, so the job board / job detail screen can show who's
 * hiring without a separate round trip per job. One Employer query and
 * one Agency query total, regardless of how many jobs are passed in.
 *
 * `poster` is `null` when the profile lookup comes up empty (e.g. the
 * account was deleted after posting) — callers should treat that the
 * same as "no poster info available", not throw.
 *
 * @param {object[]} jobs - already-`.toJSON()`'d job objects
 * @returns {Promise<object[]>} the same array, each job mutated in place
 */
async function attachPosterInfo(jobs) {
  if (jobs.length === 0) return jobs;

  const creatorIds = [...new Set(jobs.map((job) => job.creatorId))];

  const [employers, agencies] = await Promise.all([
    Employer.find({ userId: { $in: creatorIds } })
      .select('userId companyName logoUrl')
      .lean(),
    Agency.find({ userId: { $in: creatorIds } })
      .select('userId agencyName operationalCity')
      .lean(),
  ]);

  const employerMap = new Map(employers.map((e) => [e.userId.toString(), e]));
  const agencyMap = new Map(agencies.map((a) => [a.userId.toString(), a]));

  for (const job of jobs) {
    if (job.creatorType === 'agency') {
      const profile = agencyMap.get(job.creatorId);
      job.poster = profile
        ? {
          type: 'agency',
          name: profile.agencyName,
          city: profile.operationalCity || null,
          logoUrl: null,
          // The agency's *User* id — same value as `job.creatorId`
          // here, but surfaced explicitly on `poster` so a client can
          // link to GET /agencies/:agencyId/profile (+ /jobs) straight
          // from a job card without also having to know that
          // `creatorId` doubles as the agency id (see
          // agencyComment.validator.js's note on that).
          agencyId: profile.userId.toString(),
        }
        : null;
    } else if (job.creatorType === 'employer') {
      const profile = employerMap.get(job.creatorId);
      job.poster = profile
        ? {
          type: 'employer', name: profile.companyName, city: null, logoUrl: profile.logoUrl || null,
        }
        : null;
    } else {
      job.poster = null;
    }
  }

  return jobs;
}

/**
 * Enforces `getJobPostingLimit` (subscriptionTiers.js) against this
 * account's currently-`open` postings. Called from both createJob (a
 * brand new posting) and updateJob (reopening a closed one via
 * `status: 'open'`) — reopening is otherwise an easy way around the
 * cap on new postings, since it goes through a completely different
 * code path.
 *
 * A job's `creatorId` is always a User id (see Job.model.js), never an
 * Employer/Agency profile id, so this looks up whichever of the two
 * profile collections actually has a document for it. If neither does
 * — e.g. an admin posting "as agency" per
 * jobs.controller.js#asJobCreatorType, who has no Agency profile/
 * subscription of their own — there's no tier to enforce a cap
 * against, so posting is left unrestricted for them.
 *
 * @param {string} creatorId
 * @param {{ excludeJobId?: string }} [options] - excludeJobId: don't
 *   count this job itself (used by updateJob, reopening a job it's
 *   already counted as one of its own open postings would double-count it)
 */
async function assertWithinJobPostingLimit(creatorId, { excludeJobId } = {}) {
  const [employerProfile, agencyProfile] = await Promise.all([
    Employer.findOne({ userId: creatorId }).select('subscriptionTier').lean(),
    Agency.findOne({ userId: creatorId }).select('subscriptionTier').lean(),
  ]);
  const profile = employerProfile || agencyProfile;
  if (!profile) return;

  const tier = profile.subscriptionTier || DEFAULT_TIER;
  const maxOpenJobs = await getJobPostingLimit(tier);
  if (maxOpenJobs == null) return; // enterprise, or any tier explicitly configured as unlimited

  const query = { creatorId, status: 'open' };
  if (excludeJobId) query._id = { $ne: excludeJobId };

  const openCount = await Job.countDocuments(query);
  if (openCount >= maxOpenJobs) {
    throw new AppError(
      `Your ${tier} plan allows up to ${maxOpenJobs} active job posting${maxOpenJobs === 1 ? '' : 's'} at a time. `
      + 'Close an existing posting or upgrade your subscription to post more.',
      403,
    );
  }
}

// Wire format (request body / Joi-validated) -> schema field name.
const UPDATABLE_FIELD_MAP = {
  title: 'title',
  description: 'description',
  location: 'location',
  salary_range: 'salaryRange',
  job_type: 'jobType',
  category: 'category',
  skills_required: 'skillsRequired',
  experience_level: 'experienceLevel',
  status: 'status',
  application_summary_enabled: 'applicationSummaryEnabled',
};

/**
 * POST /api/v1/jobs/create
 * `creatorId`/`creatorType` come from the JWT, never the request body,
 * so a caller can't post a job under someone else's identity. Status
 * always defaults to 'open' at creation regardless of payload content
 * (createJobSchema strips `status` before this is ever reached).
 *
 * @param {string} creatorId - req.user.id
 * @param {'employer'|'agency'} creatorType - req.user.role
 * @param {{
 *   title: string, description: string, location: string,
 *   salary_range?: string, job_type: string, category?: string,
 *   skills_required: string[], experience_level?: string,
 *   application_summary_enabled?: boolean
 * }} payload - already Joi-validated
 */
async function createJob(creatorId, creatorType, payload) {
  await assertWithinJobPostingLimit(creatorId);

  const job = await Job.create({
    creatorId,
    creatorType,
    title: payload.title,
    description: payload.description,
    location: payload.location,
    salaryRange: payload.salary_range || null,
    jobType: payload.job_type,
    category: payload.category || null,
    skillsRequired: payload.skills_required,
    experienceLevel: payload.experience_level || null,
    status: 'open',
    applicationSummaryEnabled: payload.application_summary_enabled || false,
  });

  // Kick off an async matching run so a candidate shortlist is ready
  // shortly after the posting goes live, without holding up this
  // request on it. Enqueue failures (e.g. Redis briefly unreachable)
  // must never fail job creation itself — log and move on; the job can
  // still be matched later via a manual retry/backfill.
  try {
    await enqueueJobMatching(job.id);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[jobs.service] failed to enqueue matching for job ${job.id}:`, err.message);
  }

  // JS-03 alert preferences: separately from the matching-engine
  // shortlist, also check this new posting against every seeker's
  // alerts-enabled saved search (see jobAlerts.service.js) and email
  // the ones it matches. Independent queue task from JOB_MATCHING —
  // "was this seeker matched by the scoring algorithm" and "does this
  // job match a search this seeker explicitly saved" are different
  // questions with different audiences, so a failure in one must never
  // block or be conflated with the other.
  try {
    await enqueueJobAlerts(job.id);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[jobs.service] failed to enqueue job alerts for job ${job.id}:`, err.message);
  }

  // SEEK-01 category preferences: instant SMS to every seeker who
  // picked this job's category on the onboarding screen. Its own try/
  // catch for the same reason as the two enqueues above — an SMS
  // provider or Redis hiccup here must never fail job creation, and
  // must never be conflated with the (unrelated-audience) saved-search
  // alerts or matching-engine shortlist.
  try {
    await enqueueCategorySmsAlerts(job.id);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[jobs.service] failed to enqueue category SMS alerts for job ${job.id}:`, err.message);
  }

  return job.toJSON();
}

/**
 * GET /api/v1/jobs/my-jobs
 * Every job ever created by this creator, newest first — regardless of
 * status (open/closed/draft), since this is the owner's own dashboard.
 *
 * @param {string} creatorId - req.user.id
 */
async function getMyJobs(creatorId) {
  const jobs = await Job.find({ creatorId }).sort({ createdAt: -1 });
  const jobsJson = jobs.map((doc) => doc.toJSON());
  await attachPosterInfo(jobsJson);
  return jobsJson;
}

/**
 * PATCH /api/v1/jobs/:id
 * Partial update, restricted to jobs the caller owns. Ownership is
 * enforced in the query itself (filter on both _id and creatorId)
 * rather than via a separate find-then-update, to avoid a TOCTOU gap
 * and keep it to a single round-trip.
 *
 * @param {string} jobId
 * @param {string} creatorId - req.user.id
 * @param {object} updates - already Joi-validated (updateJobSchema)
 */
async function updateJob(jobId, creatorId, updates) {
  const fields = Object.keys(updates);
  if (fields.length === 0) {
    throw new AppError('No updatable fields provided', 422);
  }

  const setDoc = {};
  for (const field of fields) {
    setDoc[UPDATABLE_FIELD_MAP[field] || field] = updates[field];
  }

  // Reopening a closed job is otherwise a way around
  // assertWithinJobPostingLimit's check in createJob above, since it's
  // a completely separate code path. Checked here rather than at the
  // route/validator level so it stays a single source of truth
  // alongside the createJob check. Safe to run even when the job is
  // already open (a no-op status update) — excludeJobId means it never
  // counts itself against its own limit.
  if (setDoc.status === 'open') {
    await assertWithinJobPostingLimit(creatorId, { excludeJobId: jobId });
  }

  const job = await Job.findOneAndUpdate(
    // status: { $ne: 'removed' } — a listing an admin took down (see
    // admin.service.js#removeJobAsAdmin) is a terminal state from the
    // owner's side; without this filter, PATCH { status: 'open' }
    // would let the owner silently reopen it, defeating the removal.
    { _id: jobId, creatorId, status: { $ne: 'removed' } },
    { $set: setDoc },
    { new: true, runValidators: true },
  );

  if (!job) {
    // Deliberately vague: don't reveal whether the job exists but
    // belongs to someone else, is admin-removed, vs. doesn't exist at all.
    throw new AppError('Job not found or you do not have permission to modify it', 404);
  }
  return job.toJSON();
}

/**
 * GET /api/v1/jobs/:id/suggested-seekers (ownership check)
 * Looks up a job by id with no ownership filter, so the caller can
 * decide what to do when the job exists but belongs to someone else
 * (as opposed to updateJob, where "not mine" and "doesn't exist" are
 * deliberately indistinguishable).
 *
 * @param {string} jobId
 * @returns {Promise<object|undefined>}
 */
async function getJobById(jobId) {
  const job = await Job.findById(jobId);
  return job ? job.toJSON() : undefined;
}

/**
 * GET /api/v1/jobs (JS-03: seeker job board browse/search/filter)
 * Public-to-seekers listing of every OPEN job, filterable and
 * paginated. Deliberately never includes 'closed'/'draft' postings —
 * this is the job board, not an owner's management view (that's
 * getMyJobs, above, which is intentionally unfiltered by status since
 * it's the poster's own dashboard).
 *
 * @param {{
 *   keyword?: string, location?: string, job_type?: string, category?: string,
 *   creator_type?: 'employer'|'agency', experience_level?: string, page: number, limit: number
 * }} filters - already Joi-validated (browseJobsSchema)
 * @returns {Promise<{ jobs: object[], page: number, limit: number, count: number }>}
 */
async function browseJobs(filters) {
  const {
    keyword, location, job_type: jobType, category, creator_type: creatorType,
    experience_level: experienceLevel, page, limit,
  } = filters;

  const query = { status: 'open' };

  if (jobType) {
    query.jobType = jobType;
  }

  if (category) {
    query.category = category;
  }

  // "Company jobs" vs "Agency jobs" toggle on the seeker job board —
  // mirrors the jobType/category filters above exactly.
  if (creatorType) {
    query.creatorType = creatorType;
  }

  if (experienceLevel) {
    // Same convention as seeker.service.js#searchSeekers' `experienceLevel`
    // filter: an exact match against the closed EXPERIENCE_LEVEL_KEYS enum.
    query.experienceLevel = experienceLevel;
  }

  if (location) {
    // Case-insensitive partial match, same convention as
    // seeker.service.js#searchSeekers' city filter.
    query.location = new RegExp(escapeRegex(location), 'i');
  }

  if (keyword) {
    const pattern = new RegExp(escapeRegex(keyword), 'i');
    query.$or = [{ title: pattern }, { description: pattern }];
  }

  const skip = (page - 1) * limit;

  const [jobs, total] = await Promise.all([
    Job.find(query).sort({ createdAt: -1 }).skip(skip).limit(limit),
    Job.countDocuments(query),
  ]);

  const jobsJson = jobs.map((doc) => doc.toJSON());
  await attachPosterInfo(jobsJson);

  return {
    jobs: jobsJson,
    page,
    limit,
    count: jobs.length,
    total,
  };
}

/**
 * GET /api/v1/agencies/:agencyId/jobs
 * Public listing of every OPEN job posted by one agency, newest
 * first — the "see all jobs by this agency" list on
 * `AgencyProfileScreen` (reached by tapping an agency's name on a job
 * card/detail screen). Deliberately the same shape as [browseJobs]
 * (`{ jobs, page, limit, count, total }`) so the frontend can reuse
 * `JobBrowseResult.fromJson` for both.
 *
 * `agencyId` here is the agency's *User* id, i.e. `Job.creatorId` on
 * any job it posted — same id used throughout agencyComment.* for the
 * same route param (see agencyComment.validator.js's note on this).
 * Only ever matches `creatorType: 'agency'` jobs, so passing an
 * employer's user id here just yields an empty list rather than
 * leaking an employer's postings under an "agency" listing.
 *
 * @param {string} agencyId
 * @param {{ page: number, limit: number }} pagination - already
 *   Joi-validated (listAgencyJobsQuerySchema)
 */
async function getJobsByAgency(agencyId, { page, limit }) {
  const query = { creatorId: agencyId, creatorType: 'agency', status: 'open' };
  const skip = (page - 1) * limit;

  const [jobs, total] = await Promise.all([
    Job.find(query).sort({ createdAt: -1 }).skip(skip).limit(limit),
    Job.countDocuments(query),
  ]);

  const jobsJson = jobs.map((doc) => doc.toJSON());
  await attachPosterInfo(jobsJson);

  return {
    jobs: jobsJson,
    page,
    limit,
    count: jobs.length,
    total,
  };
}

module.exports = {
  createJob, getMyJobs, updateJob, getJobById, browseJobs, getJobsByAgency, attachPosterInfo,
};
