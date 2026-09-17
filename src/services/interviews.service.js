'use strict';

const { Interview, Placement } = require('../models');
const { INTERVIEW_STATUS_TRANSITIONS } = require('../models/Interview.model');
const AppError = require('../errors/AppError');
const { resolvePlacementForParticipant } = require('../utils/placementAccess');
const { enqueueInterviewNotification } = require('../queues/notifications.queue');

/**
 * A placement must have already been sent to/accepted by the candidate
 * before an interview makes sense; 'matched' (not yet sent) and the
 * terminal 'hired'/'rejected' statuses can't be scheduled against.
 */
const SCHEDULABLE_PLACEMENT_STATUSES = ['sent', 'interviewed'];

/** Best-effort notification enqueue — never let a delivery failure fail the request that triggered it. */
async function safeNotify(interviewId, event) {
  try {
    await enqueueInterviewNotification(interviewId, event);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(
      `[interviews.service] failed to enqueue "${event}" notification for interview ${interviewId}:`,
      err.message,
    );
  }
}

/**
 * POST /api/v1/placements/:placementId/interviews
 * Only the placement's job poster (employer/agency) can schedule.
 *
 * The FIRST interview scheduled against a placement auto-advances its
 * status 'sent' -> 'interviewed'. This is now the only thing that
 * makes that transition happen automatically — it replaces the
 * manual-only flip that agency.service.js#updatePlacementStatus
 * offered before, and (unlike that agency-only endpoint) gives
 * employers the same capability, tied to a real scheduling event
 * instead of a bare status field. Scheduling a second/third round
 * against a placement that's already 'interviewed' leaves the
 * placement status untouched.
 *
 * @param {string} userId - req.user.id
 * @param {'employer'|'agency'|'admin'} role - req.user.role
 * @param {string} placementId
 * @param {{ scheduled_for: string, mode: string, location?: string, notes?: string }} payload - already Joi-validated
 */
async function scheduleInterview(userId, role, placementId, payload) {
  const {
    placement, job, seeker, viewerRole,
  } = await resolvePlacementForParticipant(placementId, userId, role);

  if (viewerRole !== 'poster') {
    throw new AppError('Only the job poster can schedule an interview', 403);
  }
  if (!SCHEDULABLE_PLACEMENT_STATUSES.includes(placement.status)) {
    throw new AppError(
      `Cannot schedule an interview for a placement with status '${placement.status}'. `
      + `Valid statuses: ${SCHEDULABLE_PLACEMENT_STATUSES.join(', ')}.`,
      409,
    );
  }

  const interview = await Interview.create({
    placementId: placement.id,
    jobId: job.id,
    seekerId: seeker.id,
    scheduledById: userId,
    scheduledFor: payload.scheduled_for,
    mode: payload.mode,
    location: payload.location || null,
    notes: payload.notes || null,
  });

  if (placement.status === 'sent') {
    await Placement.findByIdAndUpdate(placement.id, { $set: { status: 'interviewed' } });
  }

  await safeNotify(interview.id, 'scheduled');

  return interview.toJSON();
}

/**
 * GET /api/v1/placements/:placementId/interviews
 * Every interview round for a placement, soonest-first. Either
 * participant (job poster or the candidate) can view.
 *
 * @param {string} userId
 * @param {string} role
 * @param {string} placementId
 */
async function listInterviewsForPlacement(userId, role, placementId) {
  await resolvePlacementForParticipant(placementId, userId, role); // throws if not a participant

  const interviews = await Interview.find({ placementId }).sort({ scheduledFor: -1 });
  return interviews.map((doc) => doc.toJSON());
}

/**
 * Loads a single interview and verifies the caller is a participant of
 * its placement — shared by the two id-keyed mutation endpoints below.
 *
 * @param {string} interviewId
 * @param {string} userId
 * @param {string} role
 * @returns {Promise<{ interview: import('mongoose').Document, viewerRole: 'poster'|'seeker' }>}
 */
async function getInterviewForParticipant(interviewId, userId, role) {
  const interview = await Interview.findById(interviewId).catch(() => null);
  if (!interview) {
    throw new AppError('Interview not found or you do not have permission to access it', 404);
  }

  const { viewerRole } = await resolvePlacementForParticipant(
    interview.placementId.toString(),
    userId,
    role,
  );

  return { interview, viewerRole };
}

/**
 * PATCH /api/v1/interviews/:id
 * Reschedules an already-'scheduled' interview in place (updates
 * timing/mode/location/notes) rather than creating a new document,
 * since it's still the same round, just moved. Poster-only; only while
 * status is still 'scheduled' — a completed/cancelled interview is a
 * historical record, not editable.
 *
 * @param {string} userId
 * @param {string} role
 * @param {string} interviewId
 * @param {{ scheduled_for?: string, mode?: string, location?: string, notes?: string }} updates - already Joi-validated
 */
async function rescheduleInterview(userId, role, interviewId, updates) {
  const { interview, viewerRole } = await getInterviewForParticipant(interviewId, userId, role);

  if (viewerRole !== 'poster') {
    throw new AppError('Only the job poster can reschedule an interview', 403);
  }
  if (interview.status !== 'scheduled') {
    throw new AppError(`Cannot reschedule an interview with status '${interview.status}'.`, 409);
  }

  const FIELD_MAP = {
    scheduled_for: 'scheduledFor', mode: 'mode', location: 'location', notes: 'notes',
  };
  for (const [wireField, modelField] of Object.entries(FIELD_MAP)) {
    if (updates[wireField] !== undefined) {
      interview[modelField] = updates[wireField];
    }
  }
  await interview.save();

  await safeNotify(interview.id, 'rescheduled');

  return interview.toJSON();
}

/**
 * PATCH /api/v1/interviews/:id/status
 * Marks an interview 'completed' or 'cancelled'. Poster-only — there's
 * no product requirement yet for the candidate to confirm attendance
 * from their own side.
 *
 * @param {string} userId
 * @param {string} role
 * @param {string} interviewId
 * @param {'completed'|'cancelled'} newStatus - already Joi-validated
 */
async function updateInterviewStatus(userId, role, interviewId, newStatus) {
  const { interview, viewerRole } = await getInterviewForParticipant(interviewId, userId, role);

  if (viewerRole !== 'poster') {
    throw new AppError('Only the job poster can update an interview status', 403);
  }

  const allowedNextStatuses = INTERVIEW_STATUS_TRANSITIONS[interview.status] || [];
  if (!allowedNextStatuses.includes(newStatus)) {
    throw new AppError(
      `Cannot move an interview from '${interview.status}' to '${newStatus}'. `
      + `Valid next status(es) from '${interview.status}': `
      + `${allowedNextStatuses.length > 0 ? allowedNextStatuses.join(', ') : 'none (terminal status)'}.`,
      409,
    );
  }

  interview.status = newStatus;
  await interview.save();

  if (newStatus === 'cancelled') {
    await safeNotify(interview.id, 'cancelled');
  }

  return interview.toJSON();
}

module.exports = {
  scheduleInterview,
  listInterviewsForPlacement,
  rescheduleInterview,
  updateInterviewStatus,
};
