'use strict';

const { Schema, model } = require('mongoose');
const { JOB_CATEGORY_KEYS } = require('../utils/jobCategories.taxonomy');
const { EXPERIENCE_LEVEL_KEYS } = require('../utils/experienceLevels.taxonomy');

const JOB_CREATOR_TYPES = ['employer', 'agency'];
const JOB_TYPES = ['Full-Time', 'Contract', 'Daily'];
// 'removed' is admin-only (see admin.service.js#removeJobAsAdmin) — it
// is deliberately absent from jobs.validator.js's UPDATABLE_STATUSES,
// so an owner can never set or clear it themselves via PATCH /jobs/:id.
const JOB_STATUSES = ['open', 'closed', 'draft', 'removed'];

/**
 * Replaces the `jobs` table from 003_create_jobs_table.sql.
 * `creatorId` points at the posting account's User document (never a
 * Seeker/Employer/Agency profile id) — jobs.service.js always writes
 * `req.user.id` (the JWT subject, i.e. the User _id) here, mirroring
 * the old `creator_id UUID REFERENCES users(id)` column.
 */
const jobSchema = new Schema(
  {
    creatorId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      // "my jobs" dashboard listing (jobs.service.js#getMyJobs) queries
      // by creatorId alone, newest first.
      index: true,
    },
    creatorType: {
      type: String,
      enum: JOB_CREATOR_TYPES,
      required: true,
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
    location: {
      type: String,
      required: true,
      trim: true,
    },
    salaryRange: {
      type: String,
      trim: true,
      default: null,
    },
    jobType: {
      type: String,
      enum: JOB_TYPES,
      required: true,
    },
    // JS-04: lets the seeker job board filter by the same closed
    // taxonomy already used for Seeker.preferredCategories (SEEK-01) —
    // sharing one enum keeps "categories a seeker can be alerted for"
    // and "categories a job can be filtered by" in lockstep. Optional
    // (unlike jobType) so existing jobs posted before this field existed
    // don't fail validation; an uncategorized job just won't surface
    // under any category filter, same as it wouldn't have before.
    category: {
      type: String,
      enum: JOB_CATEGORY_KEYS,
      default: null,
      index: true,
    },
    skillsRequired: {
      type: [String],
      default: [],
    },
    // Seniority band the posting calls for — same closed enum as
    // Seeker.experienceLevel (EXPERIENCE_LEVEL_KEYS), so the seeker job
    // board can filter jobs by experience level the same way the
    // employer/agency candidate search filters seekers. Optional/null
    // for jobs posted before this field existed, or left unset — those
    // simply won't surface under any experience filter, same "opt-in"
    // convention as `category` above.
    experienceLevel: {
      type: String,
      enum: EXPERIENCE_LEVEL_KEYS,
      default: null,
      index: true,
    },
    status: {
      type: String,
      enum: JOB_STATUSES,
      default: 'draft',
      // The public job board's default filter is `status: 'open'`,
      // almost always combined with a newest-first sort — see the
      // compound index below (mirrors idx_jobs_status_created_at).
      index: true,
    },
    // Per-job opt-in, set when the job is posted (and editable
    // afterwards via PATCH /jobs/:id): whether this employer/agency
    // wants KeferaJobs to analyze and summarize applicants for this
    // specific job. Off by default — summarizing costs an AI call per
    // job view and shouldn't run for postings nobody asked to have
    // analyzed. See applicationSummary.service.js, the only reader of
    // this field.
    applicationSummaryEnabled: {
      type: Boolean,
      default: false,
    },
    // Set alongside status: 'removed' by admin.service.js#removeJobAsAdmin
    // (an admin taking a listing down for a policy violation, as
    // opposed to the poster's own 'closed'). Mirrors how
    // Ad.model.js#rejectionReason keeps the "why" visible to the owner
    // rather than a status flip alone. Null for every other status.
    removedReason: {
      type: String,
      trim: true,
      default: null,
    },
  },
  {
    timestamps: true,
  },
);

// Public job board's hot path: open jobs, newest first.
jobSchema.index({ status: 1, createdAt: -1 });

// Job board filtered by category (JS-04) — open jobs in one category,
// newest first.
jobSchema.index({ status: 1, category: 1, createdAt: -1 });

// Job board's "Company jobs" / "Agency jobs" toggle — open jobs from
// one creatorType, newest first.
jobSchema.index({ status: 1, creatorType: 1, createdAt: -1 });

// "Any of these skills" lookups (matching.service.js's candidate/job
// pairing), mirroring the GIN index on skills_required.
jobSchema.index({ skillsRequired: 1 });

// Job board filtered by experience level — open jobs at one seniority
// band, newest first. Mirrors the { status, category, createdAt } index
// above.
jobSchema.index({ status: 1, experienceLevel: 1, createdAt: -1 });

jobSchema.set('toJSON', {
  virtuals: true,
  transform: (_doc, ret) => {
    ret.id = ret._id.toString();
    delete ret._id;
    delete ret.__v;
    // Stringify explicitly rather than leaving a raw ObjectId instance:
    // callers like jobs.controller.js#getSuggestedSeekersHandler do a
    // strict `job.creatorId !== req.user.id` comparison against the
    // JWT's string subject, which would always be true (never equal)
    // against a live ObjectId object.
    if (ret.creatorId) {
      ret.creatorId = ret.creatorId.toString();
    }
    return ret;
  },
});

module.exports = model('Job', jobSchema);
module.exports.JOB_CREATOR_TYPES = JOB_CREATOR_TYPES;
module.exports.JOB_TYPES = JOB_TYPES;
module.exports.JOB_STATUSES = JOB_STATUSES;
