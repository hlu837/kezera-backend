'use strict';

const { Schema, model } = require('mongoose');
const { EXPERT_TRADE_CATEGORY_KEYS } = require('../utils/expertTradeCategories.taxonomy');

const RATE_UNITS = ['hourly', 'daily', 'per_job'];

/**
 * Trade Expert / Technician Profile — the lightweight, on-demand
 * counterpart to `Seeker` (formal CV job seekers). Introduced to split
 * "Experts" into two distinct postings (see the feature discussion
 * this model came out of):
 *
 *   - `Seeker`: CV-driven, browsed by employers/agencies searching for
 *     a formal hire.
 *   - `Technician` (this model): name + skill + location + rate,
 *     browsed by anyone nearby who needs a plumber/electrician/etc.
 *     *right now*, via GPS map/list search rather than a CV search.
 *
 * Deliberately its own top-level collection rather than a sub-document
 * or shared fields on `Seeker` (which is where `tradeCategory` and the
 * nearby-search lat/lng/location fields used to live) — a technician
 * profile has no CV, no experience/education, no boost pricing, none
 * of what `Seeker` exists for. Keeping it separate means the CV search
 * indexes/queries never need to account for technician-only fields,
 * and vice versa.
 *
 * One user CAN hold both a `Seeker` doc and a `Technician` doc — e.g.
 * an electrician who also wants to apply to formal jobs. `User.role`
 * stays `'seeker'` for both; this model is an additional profile a
 * seeker-role account may optionally create, not a new role.
 *
 * Phase 1 of the migration: this model is purely additive. Existing
 * `Seeker.tradeCategory` data is backfilled into this collection by a
 * separate migration script (Phase 3) rather than here, and
 * `Seeker.tradeCategory`/lat/lng are left in place until the frontend
 * has fully cut over (Phase 6) — so nothing reads from or depends on
 * this model yet.
 */
const technicianSchema = new Schema(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      // One technician profile per user — mirrors Seeker.userId's
      // uniqueness constraint. A user who also has a Seeker/CV profile
      // has two separate documents (one per collection), each unique
      // on userId within its own collection.
      unique: true,
      index: true,
    },
    fullName: {
      type: String,
      required: true,
      trim: true,
    },
    // Which single skilled trade this profile offers — same taxonomy
    // `Seeker.tradeCategory` used, so the "Experts" directory's
    // per-category counts and nearby-search `trade` filter carry over
    // unchanged once nearby/trade-categories endpoints are repointed
    // at this collection (Phase 4).
    tradeCategory: {
      type: String,
      enum: EXPERT_TRADE_CATEGORY_KEYS,
      required: true,
      index: true,
    },
    // Free-text specifics within the trade (e.g. "AC repair",
    // "kitchen cabinets") — deliberately free text rather than a
    // closed enum, unlike `tradeCategory`: a single trade covers a
    // wide range of specific jobs, and a technician's own wording is
    // more useful to a nearby searcher here than a fixed list would be.
    skills: {
      type: [String],
      default: [],
    },
    // Short optional description of experience/what they offer — the
    // technician-profile equivalent of Seeker.bio, without any of the
    // CV builder machinery around it.
    bio: {
      type: String,
      trim: true,
      default: null,
    },
    photoUrl: {
      type: String,
      trim: true,
      default: null,
    },
    // What this technician charges, and how. Both optional — a
    // technician can list a rate to help a nearby searcher budget
    // before reaching out, or leave it blank and negotiate per job
    // (same "optional free-ish text" spirit as ServiceRequest.budget).
    rateAmount: {
      type: Number,
      min: 0,
      default: null,
    },
    rateUnit: {
      type: String,
      enum: RATE_UNITS,
      default: null,
    },
    city: {
      type: String,
      trim: true,
      default: null,
    },
    // Device-GPS coordinates, captured client-side the same way
    // Seeker's used to be (see category_preferences_screen.dart) —
    // re-savable any time via a future `PATCH /technicians/me/location`
    // (Phase 2). `null` means location access was never granted, and
    // this profile is simply excluded from nearby-search results
    // rather than sorted to the bottom.
    latitude: {
      type: Number,
      min: -90,
      max: 90,
      default: null,
    },
    longitude: {
      type: Number,
      min: -180,
      max: 180,
      default: null,
    },
    // GeoJSON mirror of latitude/longitude, kept in sync by
    // technician.service.js#setCoordinates (Phase 2) — same reason as
    // Seeker.location: Mongo's `2dsphere` index needs this shape, plain
    // Number fields can't be geo-indexed directly.
    location: {
      type: {
        type: String,
        enum: ['Point'],
        default: 'Point',
      },
      coordinates: {
        type: [Number], // [longitude, latitude], GeoJSON order
        default: undefined,
      },
    },
    // Whether this technician is currently taking on work — lets a
    // technician step away (fully booked, on leave) without deleting
    // or hiding their whole profile. Defaults true, same convention as
    // Seeker.availabilityStatus.
    availabilityStatus: {
      type: Boolean,
      default: true,
      index: true,
    },
  },
  {
    timestamps: true,
  },
);

// Nearby search (technician.service.js#nearbyTechnicians, Phase 2) —
// sparse for the same reason as Seeker's: `location` is only set once
// a technician has granted GPS access.
technicianSchema.index({ location: '2dsphere' }, { sparse: true });
// Experts directory per-category counts / filtered browsing.
technicianSchema.index({ tradeCategory: 1, availabilityStatus: 1 });

technicianSchema.set('toJSON', {
  virtuals: true,
  transform: (_doc, ret) => {
    ret.id = ret._id.toString();
    delete ret._id;
    delete ret.__v;
    if (ret.userId) {
      ret.userId = ret.userId.toString();
    }
    // Internal-only GeoJSON mirror — see the `location` field comment
    // above; API consumers get plain latitude/longitude instead.
    delete ret.location;
    return ret;
  },
});

module.exports = model('Technician', technicianSchema);
module.exports.RATE_UNITS = RATE_UNITS;
