'use strict';

const { notificationsQueue } = require('../config/queue');

/** BullMQ job "names" this queue's worker knows how to process. */
const NOTIFY_CANDIDATES = 'NOTIFY_CANDIDATES';
const NOTIFY_JOB_ALERTS = 'NOTIFY_JOB_ALERTS';

/**
 * Enqueues a NOTIFY_CANDIDATES task for a completed matching run. The
 * worker (workers/notifications.worker.js) picks it up and calls
 * `notifications.service.dispatchCandidateAlerts(jobId, candidateList)`
 * to SMS each matched candidate and email the job poster a summary.
 *
 * Fire-and-forget from the caller's perspective, same contract as
 * `enqueueJobMatching` — this only guarantees Redis accepted the task,
 * not that every SMS/email has gone out.
 *
 * @param {string} jobId
 * @param {Array<{ seeker_id: string, user_id: string }>} candidateList - ranked candidates to notify
 * @returns {Promise<import('bullmq').Job>}
 */
async function enqueueCandidateAlerts(jobId, candidateList) {
  return notificationsQueue.add(
    NOTIFY_CANDIDATES,
    { job_id: jobId, candidates: candidateList },
    {
      // SMS/email providers are flaky external dependencies — worth a
      // few more attempts than the matching queue's DB-only retries.
      attempts: 5,
      backoff: { type: 'exponential', delay: 10000 },
      removeOnComplete: { age: 3600, count: 1000 },
      removeOnFail: { age: 86400 },
      // Deterministic jobId per job posting: re-running matching before
      // a previous notification batch finished dedupes instead of
      // double-texting the same candidates.
      jobId: `notify-candidates:${jobId}`,
    },
  );
}

/**
 * Enqueues a NOTIFY_JOB_ALERTS task for a newly-created/opened job
 * (JS-03 alert preferences). The worker
 * (workers/notifications.worker.js) picks it up and calls
 * `jobAlerts.service.checkAndNotifySavedSearches(jobId)`, which scans
 * every alerts-enabled SavedSearch for a match against this job and
 * emails the owning seeker.
 *
 * Kept as its own task name (not folded into NOTIFY_CANDIDATES) on the
 * same queue: same delivery infra (SMS/email are equally flaky either
 * way), but a completely different audience-selection query — "who
 * scored highest on this job" vs. "who explicitly asked to hear about
 * jobs like this" are unrelated lists that can overlap or not.
 *
 * @param {string} jobId
 * @returns {Promise<import('bullmq').Job>}
 */
async function enqueueJobAlerts(jobId) {
  return notificationsQueue.add(
    NOTIFY_JOB_ALERTS,
    { job_id: jobId },
    {
      attempts: 5,
      backoff: { type: 'exponential', delay: 10000 },
      removeOnComplete: { age: 3600, count: 1000 },
      removeOnFail: { age: 86400 },
      // Deterministic jobId per job posting: re-saving/re-queuing the
      // same job before a previous alert pass finished dedupes instead
      // of double-emailing matching seekers.
      jobId: `notify-job-alerts:${jobId}`,
    },
  );
}

/** EMP-02: interview lifecycle events (scheduled / rescheduled / cancelled). */
const NOTIFY_INTERVIEW_EVENT = 'NOTIFY_INTERVIEW_EVENT';
/** EMP-02: a new placement-thread message was sent. */
const NOTIFY_NEW_MESSAGE = 'NOTIFY_NEW_MESSAGE';
/** JS-05: a seeker applied directly to a job posting. */
const NOTIFY_NEW_APPLICATION = 'NOTIFY_NEW_APPLICATION';
/** SEEK-01: instant SMS to seekers whose chosen category matches a new job. */
const NOTIFY_CATEGORY_SMS = 'NOTIFY_CATEGORY_SMS';
/** An employer/agency's verification was rejected by admin. */
const NOTIFY_VERIFICATION_REJECTED = 'NOTIFY_VERIFICATION_REJECTED';
/** An employer/agency account was suspended or reactivated by admin. */
const NOTIFY_ACCOUNT_STATUS_CHANGED = 'NOTIFY_ACCOUNT_STATUS_CHANGED';

/**
 * Enqueues a NOTIFY_INTERVIEW_EVENT task. The worker
 * (workers/notifications.worker.js) picks it up and calls
 * `notifications.service.notifyInterviewEvent(interviewId, event)` to
 * SMS/email the candidate.
 *
 * Unlike enqueueCandidateAlerts/enqueueJobAlerts above, this
 * deliberately has NO deterministic `jobId` — those two dedupe
 * re-triggered recomputations of the same underlying data (re-running
 * matching for a job), but a schedule/reschedule/cancel are each a
 * distinct one-off event that must always send its own notification,
 * even if they happen to target the same interview within the same
 * hour.
 *
 * @param {string} interviewId
 * @param {'scheduled'|'rescheduled'|'cancelled'} event
 * @returns {Promise<import('bullmq').Job>}
 */
async function enqueueInterviewNotification(interviewId, event = 'scheduled') {
  return notificationsQueue.add(
    NOTIFY_INTERVIEW_EVENT,
    { interview_id: interviewId, event },
    {
      attempts: 5,
      backoff: { type: 'exponential', delay: 10000 },
      removeOnComplete: { age: 3600, count: 1000 },
      removeOnFail: { age: 86400 },
    },
  );
}

/**
 * Enqueues a NOTIFY_NEW_MESSAGE task. The worker picks it up and calls
 * `notifications.service.notifyNewMessage(messageId)` to SMS/email
 * whichever placement participant did NOT send the message (a
 * "you have a new message, log in to view it" nudge — the message body
 * itself is never sent over SMS/email, only referenced).
 *
 * @param {string} messageId
 * @returns {Promise<import('bullmq').Job>}
 */
async function enqueueNewMessageNotification(messageId) {
  return notificationsQueue.add(
    NOTIFY_NEW_MESSAGE,
    { message_id: messageId },
    {
      attempts: 5,
      backoff: { type: 'exponential', delay: 10000 },
      removeOnComplete: { age: 3600, count: 1000 },
      removeOnFail: { age: 86400 },
    },
  );
}

/**
 * Enqueues a NOTIFY_NEW_APPLICATION task. The worker picks it up and
 * calls `notifications.service.notifyNewApplication(applicationId)` to
 * SMS/email the job's poster that a seeker applied — mirrors
 * enqueueNewMessageNotification above (a one-off event notification,
 * not a recomputation to dedupe, hence no deterministic `jobId` here
 * either).
 *
 * @param {string} applicationId
 * @returns {Promise<import('bullmq').Job>}
 */
async function enqueueNewApplicationNotification(applicationId) {
  return notificationsQueue.add(
    NOTIFY_NEW_APPLICATION,
    { application_id: applicationId },
    {
      attempts: 5,
      backoff: { type: 'exponential', delay: 10000 },
      removeOnComplete: { age: 3600, count: 1000 },
      removeOnFail: { age: 86400 },
    },
  );
}

/**
 * Enqueues a NOTIFY_CATEGORY_SMS task for a newly-created/opened job
 * (SEEK-01 category preferences). The worker
 * (workers/notifications.worker.js) picks it up and calls
 * `jobAlerts.service.notifyPreferredCategorySeekers(jobId)`, which
 * texts every seeker whose onboarding `preferredCategories` includes
 * this job's category.
 *
 * Own task name for the same reason `enqueueJobAlerts` is separate
 * from `enqueueCandidateAlerts` above: same delivery infra, different
 * audience-selection query ("who picked this category at signup" vs.
 * "who saved a search matching this job" vs. "who scored highest by
 * the matching engine").
 *
 * @param {string} jobId
 * @returns {Promise<import('bullmq').Job>}
 */
async function enqueueCategorySmsAlerts(jobId) {
  return notificationsQueue.add(
    NOTIFY_CATEGORY_SMS,
    { job_id: jobId },
    {
      attempts: 5,
      backoff: { type: 'exponential', delay: 10000 },
      removeOnComplete: { age: 3600, count: 1000 },
      removeOnFail: { age: 86400 },
      // Deterministic jobId per posting, same dedupe reasoning as
      // enqueueJobAlerts — re-saving/re-queuing the same job before a
      // previous pass finished dedupes instead of double-texting.
      jobId: `notify-category-sms:${jobId}`,
    },
  );
}

/**
 * Enqueues a NOTIFY_VERIFICATION_REJECTED task. The worker picks it up
 * and calls `notifications.service.notifyVerificationRejected(userId,
 * reason, refund)` to SMS/email the rejected employer/agency's phone —
 * they're mid-onboarding at this point (no session to poll a status
 * screen from), so unlike most events here, a push notification isn't
 * a fallback path, it's the only way they find out without checking
 * back manually.
 *
 * `refund` is passed through rather than recomputed by the worker
 * because the refund attempt (admin.service.js#refundLatestSubscriptionPayment)
 * already ran synchronously inside the reject request — recomputing it
 * here would mean either re-deriving the same Payment lookup (racy: the
 * record may have since changed) or risking a second refund call.
 *
 * @param {string} userId
 * @param {string} reason
 * @param {{ status: string, amount?: number, currency?: string }} refund
 * @returns {Promise<import('bullmq').Job>}
 */
async function enqueueVerificationRejectedNotification(userId, reason, refund) {
  return notificationsQueue.add(
    NOTIFY_VERIFICATION_REJECTED,
    { user_id: userId, reason, refund },
    {
      attempts: 5,
      backoff: { type: 'exponential', delay: 10000 },
      removeOnComplete: { age: 3600, count: 1000 },
      removeOnFail: { age: 86400 },
    },
  );
}

/**
 * Enqueues a NOTIFY_ACCOUNT_STATUS_CHANGED task — SMS/email an
 * employer/agency when admin.service.js#setAccountStatus
 * suspends or reactivates their account (see
 * admin.controller.js#updateAccountStatusHandler). Same rationale as
 * enqueueVerificationRejectedNotification above: this is often the
 * only way the account finds out, since a suspended account can no
 * longer even use most of the app to notice on its own.
 *
 * @param {string} userId
 * @param {'active'|'suspended'} status
 * @param {string|null} reason
 * @returns {Promise<import('bullmq').Job>}
 */
async function enqueueAccountStatusChangedNotification(userId, status, reason) {
  return notificationsQueue.add(
    NOTIFY_ACCOUNT_STATUS_CHANGED,
    { user_id: userId, status, reason },
    {
      attempts: 5,
      backoff: { type: 'exponential', delay: 10000 },
      removeOnComplete: { age: 3600, count: 1000 },
      removeOnFail: { age: 86400 },
    },
  );
}

module.exports = {
  NOTIFY_CANDIDATES,
  enqueueCandidateAlerts,
  NOTIFY_JOB_ALERTS,
  enqueueJobAlerts,
  NOTIFY_INTERVIEW_EVENT,
  enqueueInterviewNotification,
  NOTIFY_NEW_MESSAGE,
  enqueueNewMessageNotification,
  NOTIFY_NEW_APPLICATION,
  enqueueNewApplicationNotification,
  NOTIFY_CATEGORY_SMS,
  enqueueCategorySmsAlerts,
  NOTIFY_VERIFICATION_REJECTED,
  enqueueVerificationRejectedNotification,
  NOTIFY_ACCOUNT_STATUS_CHANGED,
  enqueueAccountStatusChangedNotification,
};
