'use strict';

const { Schema, model } = require('mongoose');

// Mirrors the frontend's `NotificationType` enum
// (kezerajobs-frontend-clean/lib/features/notifications/domain/notification_item.dart)
// 1:1 — add to both sides together.
const NOTIFICATION_TYPES = [
  'job_match',
  'job_alert',
  'interview_scheduled',
  'interview_rescheduled',
  'interview_cancelled',
  'new_message',
  'new_application',
  'verification_rejected',
  'account_status_changed',
  'roster_candidate_matched',
];

/**
 * NOTIF-01: a single row in a user's in-app notification feed (the bell
 * icon). Deliberately generic across roles — `userId` is whichever
 * account should see it (seeker, employer, agency, or admin), so there's
 * one collection and one set of endpoints shared by everyone, matching
 * how `notifications_repository.dart` (frontend) is written role-agnostic
 * despite currently only being wired up on the seeker side.
 *
 * This is separate from, and in addition to, the existing SMS/email
 * dispatch in `services/notifications.service.js` — that sends messages
 * to an external channel (phone/inbox) and keeps no record; this model
 * is the in-app, persisted, markable-as-read feed. The two are wired
 * together: whichever service call already triggers an SMS/email for an
 * event (new message, interview scheduled, etc.) also writes one of
 * these rows in the same breath — see `notification.service.js#create`
 * and its call sites.
 */
const notificationSchema = new Schema(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    type: {
      type: String,
      enum: NOTIFICATION_TYPES,
      required: true,
    },
    title: {
      type: String,
      required: true,
      trim: true,
      maxlength: 200,
    },
    body: {
      type: String,
      required: true,
      trim: true,
      maxlength: 1000,
    },
    // Deep-link payload whose shape varies by `type` (e.g. `{ jobId }`
    // for job_match/job_alert, `{ placementId }` for new_message and
    // the interview types, `{ placementId, applicationId }` for
    // new_application) — kept as a free-form object rather than one
    // column per possible id, mirroring how `AppNotification.data` is
    // read on the frontend (it only pulls the keys it needs for a given
    // `type`, never assumes the full shape).
    data: {
      type: Schema.Types.Mixed,
      default: {},
    },
    // null = unread. Set once the user marks it (individually or via
    // "mark all as read") — there is no separate "opening the feed
    // marks everything read" side effect like there is for placement
    // messages; notifications stay unread until explicitly acted on.
    readAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true },
);

// Feed pagination + unread-count queries both filter by userId and
// either sort by createdAt or filter by readAt, so both are covered by
// one compound index each rather than a full collection scan per user.
notificationSchema.index({ userId: 1, createdAt: -1 });
notificationSchema.index({ userId: 1, readAt: 1 });

notificationSchema.set('toJSON', {
  virtuals: true,
  transform: (_doc, ret) => {
    ret.id = ret._id.toString();
    delete ret._id;
    delete ret.__v;
    ret.userId = ret.userId.toString();
    ret.isRead = ret.readAt != null;
    return ret;
  },
});

module.exports = model('Notification', notificationSchema);
module.exports.NOTIFICATION_TYPES = NOTIFICATION_TYPES;
