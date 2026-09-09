'use strict';

const applicationsService = require('../services/applications.service');
const applicationSummaryService = require('../services/applicationSummary.service');
const jobsService = require('../services/jobs.service');
const AppError = require('../errors/AppError');

/**
 * POST /api/v1/jobs/:id/apply
 * Params validated upstream by validateParams(jobIdParamSchema).
 * Seeker-only — enforced by rbac in jobs.routes.js.
 */
async function applyToJobHandler(req, res, next) {
  try {
    const { application, alreadyApplied } = await applicationsService.applyToJob(
      req.user.id,
      req.params.id,
    );
    return res.status(alreadyApplied ? 200 : 201).json({
      status: 'success',
      data: { application, already_applied: alreadyApplied },
    });
  } catch (err) {
    return next(err);
  }
}

/**
 * GET /api/v1/jobs/:id/applications
 * Params validated upstream by validateParams(jobIdParamSchema).
 * Restricted to `employer`/`agency` roles by the router-level
 * `authorizeRoles` middleware; ownership (this job is *yours*) is
 * enforced here — same split as jobs.controller.js#getSuggestedSeekersHandler.
 */
async function getJobApplicationsHandler(req, res, next) {
  try {
    const job = await jobsService.getJobById(req.params.id);
    if (!job || job.creatorId !== req.user.id) {
      throw new AppError('Job not found or you do not have permission to view it', 404);
    }

    const applications = await applicationsService.getApplicationsForJob(req.params.id);
    return res.status(200).json({
      status: 'success',
      data: { job_id: req.params.id, applications, count: applications.length },
    });
  } catch (err) {
    return next(err);
  }
}

/**
 * GET /api/v1/seekers/me/applications
 * Seeker-only — enforced by rbac in seeker.routes.js.
 */
async function myApplicationsHandler(req, res, next) {
  try {
    const applications = await applicationsService.getMyApplications(req.user.id);
    return res.status(200).json({
      status: 'success',
      data: { applications, count: applications.length },
    });
  } catch (err) {
    return next(err);
  }
}

/**
 * PATCH /api/v1/jobs/:id/applications/:applicationId/status
 * Params validated upstream by validateParams(jobApplicationParamSchema),
 * body by validateBody(updateApplicationStatusSchema). Restricted to
 * `employer`/`agency` roles by the router-level `authorizeRoles`
 * middleware; ownership (this job is *yours*) is enforced here — same
 * split as getJobApplicationsHandler above. This is the "Shortlist"
 * button on the "View candidates" screen.
 */
async function updateApplicationStatusHandler(req, res, next) {
  try {
    const job = await jobsService.getJobById(req.params.id);
    if (!job || job.creatorId !== req.user.id) {
      throw new AppError('Job not found or you do not have permission to view it', 404);
    }

    const application = await applicationsService.updateApplicationStatus(
      req.params.id,
      req.params.applicationId,
      req.body.status,
    );
    return res.status(200).json({
      status: 'success',
      data: { application },
    });
  } catch (err) {
    return next(err);
  }
}

/**
 * GET /api/v1/jobs/:id/applications/summary
 * Params validated upstream by validateParams(jobIdParamSchema).
 * Restricted to `employer`/`agency` roles by the router-level
 * `authorizeRoles` middleware; ownership AND the per-job
 * `applicationSummaryEnabled` opt-in are both enforced by
 * applicationSummary.service.js#assertSummaryAllowed — same ownership
 * split as every other job-scoped endpoint here, plus the extra opt-in
 * check this one needs.
 */
async function getApplicationSummaryHandler(req, res, next) {
  try {
    const job = await jobsService.getJobById(req.params.id);
    applicationSummaryService.assertSummaryAllowed(job, req.user.id);

    const summary = await applicationSummaryService.summarizeApplicationsForJob(
      req.params.id,
      req.user,
      job,
      { sortBy: req.query.sortBy },
    );
    return res.status(200).json({
      status: 'success',
      data: { job_id: req.params.id, ...summary },
    });
  } catch (err) {
    return next(err);
  }
}

module.exports = {
  applyToJobHandler,
  getJobApplicationsHandler,
  myApplicationsHandler,
  updateApplicationStatusHandler,
  getApplicationSummaryHandler,
};
