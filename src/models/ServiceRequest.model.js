'use strict';

const { Schema, model } = require('mongoose');
const { EXPERT_TRADE_CATEGORY_KEYS } = require('../utils/expertTradeCategories.taxonomy');

const REQUESTER_ROLES = ['seeker', 'employer', 'agency'];
const SERVICE_REQUEST_TARGET_TYPES = ['seeker', 'agency', 'technician'];
const SERVICE_REQUEST_STATUSES = [
  'pending',
  'assigned',
  'accepted',
  'declined',
  'completed',
  'cancelled',
];

/**
 * "Request Service" — an ordinary account (seeker, employer, or agency,
 * acting as a consumer here rather than in their usual role) booking a
 * one-off job from an Expert (a Seeker with `tradeCategory` set) or an
 * Agency, found via the guest-facing `/seekers/nearby` or
 * `/agencies/nearby` directories.
 *
 * Deliberately NOT a `Job`/`Placement`/`Application` — those three all
 * assume a formal job posting exists first (see Placement.model.js and
 * placements.controller.js#inviteCandidateHandler's "Send Job Request",
 * which requires the caller to already own a `Job` document). A
 * homeowner booking a plumber for an afternoon has no job posting and
 * shouldn't need one; this is a standalone, lighter-weight entity, the
 * same way Application.model.js's doc comment describes itself as
 * "deliberately separate" from Placement rather than merged into it.
 *
 * Three ways a request can be routed (`targetType`):
 *   - 'seeker': the requester picked one specific formal Expert (a
 *     `Seeker` with `tradeCategory` set — legacy, pre-Technician-split
 *     data) directly. `assignedSeekerId` is set to `targetSeekerId`
 *     immediately at creation — there's no separate assignment step —
 *     so every downstream query ("requests I must respond to") can key
 *     off `assignedSeekerId` alone regardless of how the request arrived.
 *   - 'technician': the requester picked one specific Trade Technician
 *     (a `Technician` doc — see that model's doc comment) directly, off
 *     the "Find a technician near you" map/directory. Same immediate-
 *     assignment shape as 'seeker', just against `assignedTechnicianId`/
 *     `targetTechnicianId` instead — a Technician profile has no agency
 *     routing concept, so there is no 'technician'-flavored equivalent
 *     of the 'agency' branch below.
 *   - 'agency': the requester picked an Agency (not a specific person).
 *     `assignedSeekerId` starts null; the agency picks one of its own
 *     roster (`Seeker.agencyId`, see agency.service.js#listCandidates)
 *     to hand it to, mirroring how `dispatchCandidates` already lets an
 *     agency shortlist its roster against a job.
 */
const serviceRequestSchema = new Schema(
  {
    requesterId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      // "My requests" listing (serviceRequests.service.js#listMyRequests),
      // newest first — paired with the schema-level index below.
      index: true,
    },
    // Denormalized off the requester's role at creation time (never
    // trusted back from the client) — same convention as
    // Message.senderRole and AgencyComment.authorRole, so the UI can
    // label "Requested by an Employer/Agency/fellow Expert" without an
    // extra User lookup on every row.
    requesterRole: {
      type: String,
      enum: REQUESTER_ROLES,
      required: true,
    },
    targetType: {
      type: String,
      enum: SERVICE_REQUEST_TARGET_TYPES,
      required: true,
    },
    targetSeekerId: {
      type: Schema.Types.ObjectId,
      ref: 'Seeker',
      default: null,
    },
    // Mirrors `targetSeekerId` above, one collection over — set only
    // when `targetType === 'technician'`.
    targetTechnicianId: {
      type: Schema.Types.ObjectId,
      ref: 'Technician',
      default: null,
    },
    // Points at the agency's *User* document, not `Agency._id` — same
    // deliberate convention as `AgencyComment.agencyId` and
    // `Job.creatorId`, so this can be reached directly from
    // `GET /agencies/nearby`'s `id` (already the agency's userId; see
    // agency.service.js#nearbyAgencies's `$toString: '$userId'`
    // projection) without an extra Agency lookup on the client.
    targetAgencyId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    // The Expert currently responsible for responding: `targetSeekerId`
    // itself for a direct request, or whichever roster seeker the
    // agency picked for an agency-routed one. Null only while an
    // agency-routed request is still waiting on that assignment.
    assignedSeekerId: {
      type: Schema.Types.ObjectId,
      ref: 'Seeker',
      default: null,
      index: true,
    },
    // The Technician currently responsible for responding — same
    // immediate-set-at-creation shape as `assignedSeekerId`, just for
    // `targetType === 'technician'` requests. A Technician profile has
    // no agency routing, so unlike `assignedSeekerId` this is never
    // filled in by a later assignment step; it's set once, at creation,
    // or not at all.
    assignedTechnicianId: {
      type: Schema.Types.ObjectId,
      ref: 'Technician',
      default: null,
      index: true,
    },
    category: {
      type: String,
      enum: EXPERT_TRADE_CATEGORY_KEYS,
      required: true,
      index: true,
    },
    title: {
      type: String,
      required: true,
      trim: true,
    },
    description: {
      type: String,
      required: true,
      trim: true,
    },
    // Free-text job-site address, same convention as Job.location —
    // this is a one-off site visit, not a GPS pin, so free text (with
    // the requester's own words: "behind the blue gate", "Bole, near
    // Edna Mall") is more useful here than coordinates.
    location: {
      type: String,
      required: true,
      trim: true,
    },
    preferredDate: {
      type: Date,
      default: null,
    },
    // Free-text budget, same "optional free text" convention as
    // Job.salaryRange — a home-service budget is rarely a clean range.
    budget: {
      type: String,
      trim: true,
      default: null,
    },
    status: {
      type: String,
      enum: SERVICE_REQUEST_STATUSES,
      default: 'pending',
      index: true,
    },
    respondedAt: {
      type: Date,
      default: null,
    },
    completedAt: {
      type: Date,
      default: null,
    },
    cancelledAt: {
      type: Date,
      default: null,
    },
    cancelledBy: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
  },
  {
    timestamps: true,
  },
);

// Requester's "My Requests" listing, newest first.
serviceRequestSchema.index({ requesterId: 1, createdAt: -1 });

// An Expert's "Requests for me" inbox (direct + agency-assigned alike),
// newest first.
serviceRequestSchema.index({ assignedSeekerId: 1, status: 1, createdAt: -1 });

// A Technician's "Requests for me" inbox, newest first.
serviceRequestSchema.index({ assignedTechnicianId: 1, status: 1, createdAt: -1 });

// An Agency's inbox of requests routed to it (before/regardless of
// assignment), newest first.
serviceRequestSchema.index({ targetAgencyId: 1, status: 1, createdAt: -1 });

serviceRequestSchema.set('toJSON', {
  virtuals: true,
  transform: (_doc, ret) => {
    ret.id = ret._id.toString();
    delete ret._id;
    delete ret.__v;
    ret.requesterId = ret.requesterId.toString();
    if (ret.targetSeekerId) ret.targetSeekerId = ret.targetSeekerId.toString();
    if (ret.targetTechnicianId) ret.targetTechnicianId = ret.targetTechnicianId.toString();
    if (ret.targetAgencyId) ret.targetAgencyId = ret.targetAgencyId.toString();
    if (ret.assignedSeekerId) ret.assignedSeekerId = ret.assignedSeekerId.toString();
    if (ret.assignedTechnicianId) ret.assignedTechnicianId = ret.assignedTechnicianId.toString();
    if (ret.cancelledBy) ret.cancelledBy = ret.cancelledBy.toString();
    return ret;
  },
});

module.exports = model('ServiceRequest', serviceRequestSchema);
module.exports.REQUESTER_ROLES = REQUESTER_ROLES;
module.exports.SERVICE_REQUEST_TARGET_TYPES = SERVICE_REQUEST_TARGET_TYPES;
module.exports.SERVICE_REQUEST_STATUSES = SERVICE_REQUEST_STATUSES;
