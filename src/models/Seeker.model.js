'use strict';

const { Schema, model } = require('mongoose');
const { JOB_CATEGORY_KEYS } = require('../utils/jobCategories.taxonomy');
const { EXPERIENCE_LEVEL_KEYS } = require('../utils/experienceLevels.taxonomy');

const seekerSchema = new Schema(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      unique: true, // one seeker profile per user, mirrors the old UNIQUE user_id column
    },
    fullName: {
      type: String,
      required: true,
      trim: true,
    },
    cvUrl: {
      type: String,
      trim: true,
      default: null,
    },
    photoUrl: {
      type: String,
      trim: true,
      default: null,
    },
    availabilityStatus: {
      type: Boolean,
      default: true,
      // Every candidate search starts with `availability_status = true`
      // (see seeker.service.js#searchSeekers and matching.service.js's
      // candidate pool query) — index it directly rather than only as
      // part of the compound index below, since some queries filter on
      // it alone.
      index: true,
    },
    // Migration 002_add_seeker_profile_fields.sql, now native fields.
    bio: {
      type: String,
      trim: true,
      default: null,
    },
    // Migration 004_add_seeker_search_fields.sql, now native fields.
    skills: {
      type: [String],
      default: [],
    },
    city: {
      type: String,
      trim: true,
      default: null,
    },
    // Task 7A (Agency Backoffice): set when this profile was created by
    // an agency desk worker on behalf of a walk-in candidate, rather than
    // self-registered by the seeker (see services/agency.service.js
    // #registerWalkIn). `null` for every ordinary self-registered seeker.
    // Deliberately NOT `required` — self-service registration
    // (auth.service.js's PROFILE_CREATORS.seeker) never sets it, and a
    // seeker can exist with no agency affiliation at all.
    agencyId: {
      type: Schema.Types.ObjectId,
      ref: 'Agency',
      default: null,
      // Backs GET /api/v1/agencies/candidates (agency.service.js
      // #listCandidates), which looks up "every seeker belonging to this
      // agency" — a plain equality filter, so a single-field index is
      // enough (no need to fold into the availabilityStatus/city compound
      // index above, which serves a different, availability-first query).
      index: true,
    },
    // SEEK-01: Category & Preference Setup screen, shown right after a
    // seeker signs up. Closed enum (see JOB_CATEGORY_KEYS) rather than
    // free text like `skills` — this drives instant SMS job alerts by
    // category (services/sms.service.js), which needs a fixed set to
    // match against, not arbitrary strings.
    preferredCategories: {
      type: [{ type: String, enum: JOB_CATEGORY_KEYS }],
      default: [],
      // Backs "which seekers want alerts for category X" lookups from
      // the notification pipeline once a job in that category opens up.
      index: true,
    },
    // Whether the seeker allowed location access on the onboarding
    // screen's "Enable location to find jobs near you" banner. Purely a
    // consent flag — no coordinates are captured/stored server-side;
    // the mobile app resolves "jobs near you" client-side against
    // `city`/job `location` once granted.
    locationOptIn: {
      type: Boolean,
      default: false,
    },
    // Stamped the first time the seeker saves category preferences —
    // lets the app tell "has completed onboarding" apart from "has no
    // preferences yet" without a separate boolean to keep in sync.
    onboardingCompletedAt: {
      type: Date,
      default: null,
    },
    // SEEK-xx: "Boost my profile" — a seeker can pay a flat fee (see
    // PLAN_PRICES/BOOST_PRICE in payment.routes.js) via Chapa to be
    // surfaced ahead of non-boosted seekers in employer/agency candidate
    // search (see seeker.service.js#searchSeekers) for a fixed window.
    // `null` (never boosted) and "boosted but expired" are both simply
    // "not currently boosted" — there's no separate active/expired flag
    // to keep in sync, `boostedUntil` compared against `now` is the only
    // source of truth (same pattern as `onboardingCompletedAt` above).
    boostedUntil: {
      type: Date,
      default: null,
      // Indexed on its own (not just as part of a compound index) since
      // searchSeekers' sort needs "is this in the future" evaluated
      // per-document at query time, not looked up via equality.
      index: true,
    },
    // CV-03: CV builder — structured data behind the in-app "Build your
    // CV" wizard (cv_builder_screen.dart), kept independently of `cvUrl`
    // so a seeker can resume editing after "Save & exit" without having
    // to re-parse a previously generated PDF. `experience`/`education`
    // are plain embedded arrays (no `_id`) — the wizard always replaces
    // the whole list on save rather than patching a single entry, so a
    // per-item id would only be dead weight on the wire.
    experience: {
      type: [
        new Schema(
          {
            title: { type: String, required: true, trim: true },
            company: { type: String, required: true, trim: true },
            location: { type: String, trim: true, default: null },
            startDate: { type: String, trim: true, default: null },
            endDate: { type: String, trim: true, default: null },
            current: { type: Boolean, default: false },
            description: { type: String, trim: true, default: null },
          },
          { _id: false },
        ),
      ],
      default: [],
    },
    education: {
      type: [
        new Schema(
          {
            school: { type: String, required: true, trim: true },
            degree: { type: String, required: true, trim: true },
            fieldOfStudy: { type: String, trim: true, default: null },
            startDate: { type: String, trim: true, default: null },
            endDate: { type: String, trim: true, default: null },
            current: { type: Boolean, default: false },
            // Optional — most Ethiopian institutions grade on a 4.0 scale,
            // but this is left as a plain bounded number rather than an
            // enum so a seeker can enter e.g. a percentage-derived GPA too.
            // `null` (the default) means "not provided" and is excluded
            // from every GPA-based aggregate/ranking (see
            // utils/gpa.util.js#getHighestGpa and
            // applicationSummary.service.js) rather than treated as 0.
            gpa: {
              type: Number,
              min: 0,
              max: 4,
              default: null,
            },
          },
          { _id: false },
        ),
      ],
      default: [],
    },
    languages: {
      type: [
        new Schema(
          {
            name: { type: String, required: true, trim: true },
            level: {
              type: String,
              enum: ['Basic', 'Conversational', 'Fluent', 'Native'],
              default: 'Conversational',
            },
          },
          { _id: false },
        ),
      ],
      default: [],
    },
    // Which of the 3 CV builder templates the seeker's CV was last
    // generated with — mirrors `CvTemplate` in
    // kezerajobs-frontend-clean/lib/features/seeker/domain/seeker.dart.
    cvTemplate: {
      type: String,
      enum: ['classic', 'modern', 'minimal'],
      default: 'classic',
    },
    // Seniority band shown on the employer/agency "Find candidates"
    // filter (see seeker.service.js#searchSeekers). Closed enum (see
    // EXPERIENCE_LEVEL_KEYS) rather than free-text years — `null` means
    // the seeker hasn't set one yet, and is simply excluded whenever a
    // caller filters by experienceLevel.
    experienceLevel: {
      type: String,
      enum: EXPERIENCE_LEVEL_KEYS,
      default: null,
      index: true,
    },
  },
  {
    timestamps: true,
  },
);

// Candidate search (`GET /api/v1/seekers/search`) and the matching
// engine's candidate pool query both filter on availability + skills
// membership, and search additionally filters/sorts on city + updatedAt.
// Mirrors the GIN/composite indexes from 004_add_seeker_search_fields.sql.
seekerSchema.index({ availabilityStatus: 1, city: 1 });
seekerSchema.index({ skills: 1 });
seekerSchema.index({ updatedAt: -1 });

seekerSchema.set('toJSON', {
  virtuals: true,
  transform: (_doc, ret) => {
    ret.id = ret._id.toString();
    delete ret._id;
    delete ret.__v;
    // Stringify explicitly so downstream code can key/compare against
    // it as a plain string (e.g. notifications.service.js building a
    // Map keyed by user id) rather than a live ObjectId instance.
    if (ret.userId) {
      ret.userId = ret.userId.toString();
    }
    if (ret.agencyId) {
      ret.agencyId = ret.agencyId.toString();
    }
    // Computed rather than stored — see the `boostedUntil` field comment
    // above for why "boosted" is always derived from a timestamp
    // comparison rather than a separate flag.
    ret.isBoosted = Boolean(ret.boostedUntil) && new Date(ret.boostedUntil) > new Date();
    return ret;
  },
});

module.exports = model('Seeker', seekerSchema);
