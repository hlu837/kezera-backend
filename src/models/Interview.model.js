'use strict';

const { Schema, model } = require('mongoose');

const INTERVIEW_MODES = ['in_person', 'phone', 'video'];
const INTERVIEW_STATUSES = ['scheduled', 'completed', 'cancelled'];

/**
 * EMP-02: an interview round for a Placement (candidate x job pairing).
 * Deliberately many-to-one with Placement (no unique index on
 * placementId) — a candidate can go through multiple rounds (phone
 * screen -> in-person -> final), each its own document, all tied back
 * to the same placement thread.
 *
 * Only the job's poster (employer/agency, see utils/placementAccess.js)
 * can create/reschedule/cancel these — see interviews.service.js.
 */
const interviewSchema = new Schema(
  {
    placementId: {
      type: Schema.Types.ObjectId,
      ref: 'Placement',
      required: true,
      index: true,
    },
    // Denormalized off Placement so interview queries (e.g. "this
    // poster's upcoming interviews across all their jobs") don't need
    // an extra populate just to filter — same rationale as
    // Placement.agencyId being denormalized off Job.
    jobId: {
      type: Schema.Types.ObjectId,
      ref: 'Job',
      required: true,
    },
    seekerId: {
      type: Schema.Types.ObjectId,
      ref: 'Seeker',
      required: true,
      index: true,
    },
    scheduledById: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    scheduledFor: {
      type: Date,
      required: true,
    },
    mode: {
      type: String,
      enum: INTERVIEW_MODES,
      required: true,
    },
    // Address for in_person, dial-in number for phone, meeting link for
    // video. Kept as free text since the shape differs per mode and
    // nothing else in this codebase validates URLs/E.164 numbers.
    location: {
      type: String,
      trim: true,
      default: null,
    },
    notes: {
      type: String,
      trim: true,
      maxlength: 2000,
      default: null,
    },
    status: {
      type: String,
      enum: INTERVIEW_STATUSES,
      default: 'scheduled',
      index: true,
    },
  },
  { timestamps: true },
);

// "Interviews for this placement, soonest first" — the primary read
// pattern from interviews.service.js#listInterviewsForPlacement.
interviewSchema.index({ placementId: 1, scheduledFor: -1 });

interviewSchema.set('toJSON', {
  virtuals: true,
  transform: (_doc, ret) => {
    ret.id = ret._id.toString();
    delete ret._id;
    delete ret.__v;
    ret.placementId = ret.placementId.toString();
    ret.jobId = ret.jobId.toString();
    ret.seekerId = ret.seekerId.toString();
    ret.scheduledById = ret.scheduledById.toString();
    return ret;
  },
});

// Valid manual status transitions (mirrors Placement.model.js's own
// PLACEMENT_STATUS_TRANSITIONS convention). 'scheduled' is the only
// non-terminal status — both 'completed' and 'cancelled' are endpoints.
const INTERVIEW_STATUS_TRANSITIONS = {
  scheduled: ['completed', 'cancelled'],
};

module.exports = model('Interview', interviewSchema);
module.exports.INTERVIEW_MODES = INTERVIEW_MODES;
module.exports.INTERVIEW_STATUSES = INTERVIEW_STATUSES;
module.exports.INTERVIEW_STATUS_TRANSITIONS = INTERVIEW_STATUS_TRANSITIONS;
