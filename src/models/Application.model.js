'use strict';

const { Schema, model } = require('mongoose');

const APPLICATION_STATUSES = ['applied', 'viewed', 'shortlisted', 'rejected'];

/**
 * JS-05 "Apply to a job": a seeker's direct, self-initiated interest in
 * one specific job posting.
 *
 * Deliberately separate from `Placement` (see Placement.model.js), which
 * is the matching-engine/agency-dispatch pipeline — a candidate can be
 * `matched`/`sent`/`interviewed` there without ever having applied
 * themselves, and can apply here without the matching engine having
 * surfaced them at all. Both rows can exist for the same (jobId,
 * seekerId) pair; they record two different things (the seeker's own
 * action vs. an agency-mediated pipeline) and aren't meant to be merged
 * into one status field.
 */
const applicationSchema = new Schema(
  {
    jobId: {
      type: Schema.Types.ObjectId,
      ref: 'Job',
      required: true,
      index: true,
    },
    seekerId: {
      type: Schema.Types.ObjectId,
      ref: 'Seeker',
      required: true,
      index: true,
    },
    status: {
      type: String,
      enum: APPLICATION_STATUSES,
      default: 'applied',
    },
  },
  {
    timestamps: true,
  },
);

// A seeker can only apply once per job — a repeat
// POST /jobs/:id/apply is handled as idempotent (see
// applications.service.js#applyToJob's find-before-create), not a
// duplicate-key error a caller has to handle.
applicationSchema.index({ jobId: 1, seekerId: 1 }, { unique: true });

// Employer/agency-facing "who applied to my job" listing, newest first.
applicationSchema.index({ jobId: 1, createdAt: -1 });

// Seeker-facing "my applications" listing, newest first.
applicationSchema.index({ seekerId: 1, createdAt: -1 });

applicationSchema.set('toJSON', {
  virtuals: true,
  transform: (_doc, ret) => {
    ret.id = ret._id.toString();
    delete ret._id;
    delete ret.__v;
    if (ret.jobId) ret.jobId = ret.jobId.toString();
    if (ret.seekerId) ret.seekerId = ret.seekerId.toString();
    return ret;
  },
});

module.exports = model('Application', applicationSchema);
module.exports.APPLICATION_STATUSES = APPLICATION_STATUSES;
