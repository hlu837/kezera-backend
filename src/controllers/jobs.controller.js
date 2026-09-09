'use strict';

const jobsService = require('../services/jobs.service');
const placementsService = require('../services/placements.service');
const seekerService = require('../services/seeker.service');
const AppError = require('../errors/AppError');

// Job.creatorType (see models/Job.model.js) is a strict
// 'employer'|'agency' enum, and downstream code (notifications,
// agency.service ownership checks, Placement.agencyId derivation)
// treats 'agency' as the sentinel for "an agency posted/owns this
// job". Per the agency-as-admin formalization in rbac.middleware.js,
// an admin acting on this route IS acting as an agency, so their
// posted jobs must be stamped 'agency' too — passing the literal
// 'admin' role through here would fail Job's schema validation.
function asJobCreatorType(role) {
  return role === 'admin' ? 'agency' : role;
}

/**
 * POST /api/v1/jobs/create
 * Body validated upstream by validateBody(createJobSchema).
 */
async function createJobHandler(req, res, next) {
  try {
    const job = await jobsService.createJob(
      req.user.id,
      asJobCreatorType(req.user.role),
      req.body,
    );
    return res.status(201).json({ status: 'success', data: { job } });
  } catch (err) {
    return next(err);
  }
}

/**
 * GET /api/v1/jobs/my-jobs
 */
async function myJobsHandler(req, res, next) {
  try {
    const jobs = await jobsService.getMyJobs(req.user.id);
    return res.status(200).json({ status: 'success', data: { jobs, count: jobs.length } });
  } catch (err) {
    return next(err);
  }
}

/**
 * PATCH /api/v1/jobs/:id
 * Params validated upstream by validateParams(jobIdParamSchema),
 * body validated upstream by validateBody(updateJobSchema).
 */
async function updateJobHandler(req, res, next) {
  try {
    const job = await jobsService.updateJob(req.params.id, req.user.id, req.body);
    return res.status(200).json({ status: 'success', data: { job } });
  } catch (err) {
    return next(err);
  }
}

/**
 * GET /api/v1/jobs/:id/suggested-seekers
 * Params validated upstream by validateParams(jobIdParamSchema).
 * Restricted to `employer`/`agency` roles by the router-level
 * `authorizeRoles` middleware; ownership (this job is *yours*) is
 * enforced here, since role alone doesn't stop one employer from
 * reading another employer's candidate shortlist.
 */
async function getSuggestedSeekersHandler(req, res, next) {
  try {
    const job = await jobsService.getJobById(req.params.id);
    if (!job || job.creatorId !== req.user.id) {
      // Deliberately vague, mirroring updateJob: don't reveal whether
      // the job exists but belongs to someone else, vs. doesn't exist.
      throw new AppError('Job not found or you do not have permission to view it', 404);
    }

    const seekers = await placementsService.getSuggestedSeekers(req.params.id, {
      requesterRole: req.user.role,
      requesterId: req.user.id,
    });
    return res.status(200).json({ status: 'success', data: { job_id: req.params.id, seekers, count: seekers.length } });
  } catch (err) {
    return next(err);
  }
}

/**
 * POST /api/v1/jobs/:id/invite-candidate
 * Body validated upstream by validateBody(inviteCandidateSchema). The
 * "Message" button on the employer/agency "Find candidates" search —
 * turns a browsed seeker into a Placement for the chosen job so
 * `/placements/:placementId/messages` has something to attach to, then
 * hands the client that placement's id to open the chat thread with.
 */
async function inviteCandidateHandler(req, res, next) {
  try {
    const job = await jobsService.getJobById(req.params.id);
    if (!job || job.creatorId !== req.user.id) {
      throw new AppError('Job not found or you do not have permission to view it', 404);
    }

    const seeker = await seekerService.getSeekerById(req.body.seeker_id);
    if (!seeker) {
      throw new AppError('Candidate not found', 404);
    }

    const agencyId = job.creatorType === 'agency' ? job.creatorId : null;
    const placementId = await placementsService.inviteCandidate(
      req.params.id,
      agencyId,
      req.body.seeker_id,
    );
    return res.status(200).json({ status: 'success', data: { placement_id: placementId } });
  } catch (err) {
    return next(err);
  }
}

/**
 * GET /api/v1/jobs (JS-03: seeker job board browse/search/filter)
 * Query validated upstream by validateQuery(browseJobsSchema). Public —
 * no auth required (see jobs.routes.js's comment on this route).
 */
async function browseJobsHandler(req, res, next) {
  try {
    const result = await jobsService.browseJobs(req.query);
    return res.status(200).json({ status: 'success', data: result });
  } catch (err) {
    return next(err);
  }
}

/**
 * GET /api/v1/agencies/:agencyId/jobs
 * Params validated upstream by validateParams(agencyIdParamSchema),
 * query validated upstream by validateQuery(listAgencyJobsQuerySchema).
 * Mounted in agencyPublic.routes.js (not jobs.routes.js) alongside this
 * agency's other public-facing endpoints (profile, comments), but the
 * handler/service live here since this is squarely a job-board read,
 * same "public, no auth required" rationale as browseJobsHandler above.
 */
async function getAgencyJobsHandler(req, res, next) {
  try {
    const result = await jobsService.getJobsByAgency(req.params.agencyId, req.query);
    return res.status(200).json({ status: 'success', data: result });
  } catch (err) {
    return next(err);
  }
}

module.exports = {
  createJobHandler,
  myJobsHandler,
  updateJobHandler,
  getSuggestedSeekersHandler,
  inviteCandidateHandler,
  browseJobsHandler,
  getAgencyJobsHandler,
};
