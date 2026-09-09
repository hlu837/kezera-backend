'use strict';

const { Application, Job, Seeker } = require('../models');
const AppError = require('../errors/AppError');
const { enqueueNewApplicationNotification } = require('../queues/notifications.queue');
const { attachLastSeen } = require('../utils/attachLastSeen');

/**
 * POST /api/v1/jobs/:id/apply
 * JS-05: a seeker directly applies to one job. Idempotent by design —
 * a repeat apply on a job the seeker already applied to just returns
 * the existing row (`alreadyApplied: true`) rather than throwing on
 * Application's unique (jobId, seekerId) index, since from the
 * seeker's side tapping "Apply" twice isn't an error case.
 *
 * @param {string} userId - req.user.id
 * @param {string} jobId
 * @returns {Promise<{ application: object, alreadyApplied: boolean }>}
 */
async function applyToJob(userId, jobId) {
  const job = await Job.findById(jobId).select('status');
  if (!job) {
    throw new AppError('Job not found', 404);
  }
  if (job.status !== 'open') {
    throw new AppError('This job is no longer accepting applications', 400);
  }

  const seeker = await Seeker.findOne({ userId }).select('_id cvUrl');
  if (!seeker) {
    throw new AppError('Seeker profile not found', 404);
  }

  // JS-05: applying is always "with a CV" — either uploaded or built in
  // the app (both paths write to `Seeker.cvUrl`, see
  // seeker.service.js#saveUploadedFiles and the CV builder's `generate`
  // endpoint). Block the apply itself rather than silently letting an
  // employer receive a CV-less application, which they'd otherwise only
  // discover after the fact.
  if (!seeker.cvUrl) {
    throw new AppError(
      'Please upload or build your CV before applying to jobs.',
      400,
    );
  }

  const existing = await Application.findOne({ jobId, seekerId: seeker._id });
  if (existing) {
    return { application: existing.toJSON(), alreadyApplied: true };
  }

  const application = await Application.create({ jobId, seekerId: seeker._id });

  // Best-effort — a misconfigured/unreachable SMS or email provider
  // must never fail the apply request itself (same "create the row
  // first, enqueue after, catch the enqueue" shape as
  // messaging.service.js#sendMessage).
  try {
    await enqueueNewApplicationNotification(application.id);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(
      `[applications.service] failed to enqueue notification for application ${application.id}:`,
      err.message,
    );
  }

  return { application: application.toJSON(), alreadyApplied: false };
}

/**
 * GET /api/v1/seekers/me/applications
 * A seeker's own application history, newest first. `job` is populated
 * (not just `jobId`) so the app can render a list without a second
 * round trip per row.
 *
 * @param {string} userId - req.user.id
 */
async function getMyApplications(userId) {
  const seeker = await Seeker.findOne({ userId }).select('_id');
  if (!seeker) {
    throw new AppError('Seeker profile not found', 404);
  }

  const applications = await Application.find({ seekerId: seeker._id })
    .sort({ createdAt: -1 })
    .populate('jobId');

  return applications.map((doc) => {
    const json = doc.toJSON();
    // `jobId` was populated above, so it's a full Job doc, not a bare
    // id string — reshape into `{ ...application, job }` so the wire
    // format matches what a client actually wants (an applications
    // list with the job details inline), rather than leaking the
    // populate mechanics into the response shape.
    const job = doc.jobId && typeof doc.jobId === 'object' ? doc.jobId.toJSON() : null;
    return { ...json, jobId: job ? job.id : json.jobId, job };
  });
}

/**
 * GET /api/v1/jobs/:id/applications
 * Employer/agency-facing "who applied to my job" list. Ownership (this
 * job is *yours*) is checked by the caller (applications.controller.js),
 * same split as jobs.controller.js#getSuggestedSeekersHandler.
 *
 * @param {string} jobId
 */
async function getApplicationsForJob(jobId) {
  const applications = await Application.find({ jobId })
    .sort({ createdAt: -1 })
    .populate({
      path: 'seekerId',
      // `cvUrl` included so the employer/agency application list can
      // link straight to the CV that was current at apply time — this
      // is the whole point of JS-05 requiring a CV to apply at all.
      // `userId` included so attachLastSeen (below) can resolve each
      // applicant's last-seen timestamp; not otherwise shown to the
      // employer/agency.
      select: 'fullName city skills availabilityStatus photoUrl boostedUntil cvUrl userId',
    });

  const results = applications.map((doc) => {
    const json = doc.toJSON();
    const seeker = doc.seekerId && typeof doc.seekerId === 'object' ? doc.seekerId.toJSON() : null;
    return { ...json, seekerId: seeker ? seeker.id : json.seekerId, seeker };
  });

  await attachLastSeen(results.map((r) => r.seeker).filter(Boolean));

  return results;
}

/**
 * PATCH /api/v1/jobs/:id/applications/:applicationId/status
 * Employer/agency triaging a direct applicant — most notably
 * "Shortlist" on the "View candidates" screen. Ownership (this job is
 * *yours*) is checked by the caller (applications.controller.js), same
 * split as getApplicationsForJob. Scoped to `jobId` as well as the
 * application's own `_id` so an applicationId can't be replayed
 * against a job it doesn't belong to.
 *
 * @param {string} jobId
 * @param {string} applicationId
 * @param {string} status - one of validators/jobs.validator.js's
 *   APPLICATION_UPDATABLE_STATUSES
 */
async function updateApplicationStatus(jobId, applicationId, status) {
  const application = await Application.findOneAndUpdate(
    { _id: applicationId, jobId },
    { status },
    { new: true },
  ).populate({
    path: 'seekerId',
    select: 'fullName city skills availabilityStatus photoUrl boostedUntil cvUrl userId',
  });

  if (!application) {
    throw new AppError('Application not found', 404);
  }

  const json = application.toJSON();
  const seeker = application.seekerId && typeof application.seekerId === 'object'
    ? application.seekerId.toJSON()
    : null;

  if (seeker) {
    await attachLastSeen([seeker]);
  }

  return { ...json, seekerId: seeker ? seeker.id : json.seekerId, seeker };
}

module.exports = {
  applyToJob,
  getMyApplications,
  getApplicationsForJob,
  updateApplicationStatus,
};
