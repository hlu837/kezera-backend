'use strict';

const { Schema, model } = require('mongoose');

const PLACEMENT_STATUSES = ['matched', 'sent', 'interviewed', 'hired', 'rejected'];

/**
 * Replaces the `placements` table from 005_create_placements_table.sql
 * (plus the `updated_at` column added in 006_create_inbound_sms_events.sql).
 * Persists the matching worker's ranked output so results survive past
 * a single BullMQ job's return value.
 */
const placementSchema = new Schema(
  {
    jobId: {
      type: Schema.Types.ObjectId,
      ref: 'Job',
      required: true,
    },
    seekerId: {
      type: Schema.Types.ObjectId,
      ref: 'Seeker',
      required: true,
    },
    // Set when the job was posted by an agency (job.creatorType ===
    // 'agency'), so that agency owns/handles this placement. null when
    // the job was posted directly by an employer.
    agencyId: {
      type: Schema.Types.ObjectId,
      ref: 'Agency',
      default: null,
    },
    status: {
      type: String,
      enum: PLACEMENT_STATUSES,
      default: 'matched',
      index: true,
    },
    // The matching algorithm's score (see matching.service.js#scoreCandidate)
    // at the time this row was written. Nullable so rows created by any
    // future path that doesn't have a score can still be inserted.
    score: {
      type: Number,
      min: 0,
      max: 1,
      default: null,
    },
    // Task 7 (Agency Dispatches): set the moment this placement
    // transitions 'matched' -> 'sent' (see agency.service.js
    // #dispatchCandidates). Tracked separately from `updatedAt`
    // because `sent` is NOT a terminal status — a placement can move
    // on to 'hired'/'rejected' later the same day or on a later day,
    // which would otherwise overwrite `updatedAt` and make "dispatches
    // sent today" (GET /api/v1/agencies/dashboard/stats) undercount or
    // miscount once any of today's dispatches progress further.
    sentAt: {
      type: Date,
      default: null,
      index: true,
    },
  },
  {
    timestamps: true,
  },
);

// A seeker should only ever have one placement doc per job. Re-running
// the matching worker for the same job (e.g. after the posting is
// edited) must upsert rather than accumulate duplicates.
placementSchema.index({ jobId: 1, seekerId: 1 }, { unique: true });

// GET /api/v1/jobs/:id/suggested-seekers reads by jobId, ordered by score.
placementSchema.index({ jobId: 1, score: -1 });

// Agency-facing "my placements" dashboards.
placementSchema.index({ agencyId: 1 }, { partialFilterExpression: { agencyId: { $type: 'objectId' } } });

placementSchema.set('toJSON', {
  virtuals: true,
  transform: (_doc, ret) => {
    ret.id = ret._id.toString();
    delete ret._id;
    delete ret.__v;
    // Stringify ref fields explicitly (see Job.model.js for why) so
    // downstream comparisons/serialization get plain strings, not live
    // ObjectId instances.
    if (ret.jobId) ret.jobId = ret.jobId.toString();
    if (ret.seekerId) ret.seekerId = ret.seekerId.toString();
    if (ret.agencyId) ret.agencyId = ret.agencyId.toString();
    return ret;
  },
});

// Task 7: dashboard stats' "dispatches sent today" aggregation filters
// on (agencyId, status, sentAt range).
placementSchema.index({ agencyId: 1, status: 1, sentAt: -1 });

// Valid manual transitions an agency can make via
// PATCH /api/v1/agencies/placements/:id/status (see agency.service.js
// #updatePlacementStatus). 'matched' and 'sent' are NOT reachable here —
// they're only ever set automatically (by the matching worker and by
// dispatchCandidates/the inbound-SMS webhook, respectively). Rejection
// is allowed from either 'sent' or 'interviewed' since a candidate can
// be turned down before or after an interview happens.
const PLACEMENT_STATUS_TRANSITIONS = {
  sent: ['interviewed', 'hired', 'rejected'],
  interviewed: ['hired', 'rejected'],
};

module.exports = model('Placement', placementSchema);
module.exports.PLACEMENT_STATUSES = PLACEMENT_STATUSES;
module.exports.PLACEMENT_STATUS_TRANSITIONS = PLACEMENT_STATUS_TRANSITIONS;
