'use strict';

const { Schema, model } = require('mongoose');
const { EXPERIENCE_LEVEL_KEYS } = require('../utils/experienceLevels.taxonomy');

/**
 * A seeker's saved job-search criteria (JS-03), optionally with alerting
 * turned on. Mirrors the shape of GET /api/v1/jobs' own filters
 * (keyword/location/jobType/experienceLevel) so "save this search" is
 * always a 1:1 snapshot of whatever query the seeker just ran on the
 * job board.
 *
 * `alertsEnabled` seekers get emailed (see services/jobAlerts.service.js)
 * whenever a newly-created job matches this saved criteria — fired from
 * the same place jobs.service.js#createJob already kicks off matching,
 * via the `notifications` BullMQ queue's NOTIFY_JOB_ALERTS task.
 */
const savedSearchSchema = new Schema(
  {
    seekerId: {
      type: Schema.Types.ObjectId,
      ref: 'Seeker',
      required: true,
      // "my saved searches" listing queries by seekerId alone, newest first.
      index: true,
    },
    // Optional human label ("Addis welding jobs") so a seeker with
    // several saved searches can tell them apart at a glance. Falls
    // back to a generated summary client-side if left blank.
    name: {
      type: String,
      trim: true,
      default: null,
    },
    keyword: {
      type: String,
      trim: true,
      default: null,
    },
    location: {
      type: String,
      trim: true,
      default: null,
    },
    jobType: {
      type: String,
      enum: ['Full-Time', 'Contract', 'Daily', null],
      default: null,
    },
    experienceLevel: {
      type: String,
      enum: EXPERIENCE_LEVEL_KEYS,
      default: null,
    },
    // Alert preference toggle — a saved search can exist purely as a
    // shortcut (alerts off) or actively notify the seeker of new
    // matches (alerts on). Default on: saving a search is usually an
    // implicit "tell me when more of these show up".
    alertsEnabled: {
      type: Boolean,
      default: true,
      index: true,
    },
    // Last time this saved search successfully matched+alerted on a
    // newly-created job. Purely informational (surfaced back to the
    // seeker as "last alert: ..."), not used for de-duplication —
    // de-dup for a single job is handled by NOTIFY_JOB_ALERTS' BullMQ
    // jobId, and there's no need to avoid re-alerting on a *different*
    // later job just because one already fired recently.
    lastAlertedAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
  },
);

// "My saved searches" listing (savedSearch.service.js#listSavedSearches).
savedSearchSchema.index({ seekerId: 1, createdAt: -1 });

// jobAlerts.service.js's "which saved searches might this new job
// match" scan starts from every alerts-enabled saved search.
savedSearchSchema.index({ alertsEnabled: 1 });

savedSearchSchema.set('toJSON', {
  virtuals: true,
  transform: (_doc, ret) => {
    ret.id = ret._id.toString();
    delete ret._id;
    delete ret.__v;
    if (ret.seekerId) {
      ret.seekerId = ret.seekerId.toString();
    }
    return ret;
  },
});

module.exports = model('SavedSearch', savedSearchSchema);
