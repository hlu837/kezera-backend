'use strict';

const { Worker } = require('bullmq');
const { connection, NOTIFICATIONS_QUEUE_NAME } = require('../config/queue');
const {
  NOTIFY_CANDIDATES, NOTIFY_JOB_ALERTS, NOTIFY_INTERVIEW_EVENT, NOTIFY_NEW_MESSAGE,
  NOTIFY_NEW_APPLICATION, NOTIFY_CATEGORY_SMS, NOTIFY_VERIFICATION_REJECTED,
  NOTIFY_ACCOUNT_STATUS_CHANGED,
} = require('../queues/notifications.queue');
const notificationsService = require('../services/notifications.service');
const jobAlertsService = require('../services/jobAlerts.service');

/**
 * Handles a NOTIFY_CANDIDATES task: SMS's every candidate in the
 * payload and emails the job poster a summary.
 * @param {import('bullmq').Job} bullJob
 */
async function handleNotifyCandidates(bullJob) {
  const { job_id: jobId, candidates } = bullJob.data || {};
  if (!jobId) {
    throw new Error('NOTIFY_CANDIDATES task payload is missing required "job_id"');
  }

  const result = await notificationsService.dispatchCandidateAlerts(jobId, candidates || []);

  // eslint-disable-next-line no-console
  console.log(
    `[notifications-worker] job_id=${jobId} sms=${result.smsSent}/${result.smsAttempted} `
    + `poster_email_sent=${result.posterEmailSent} roster_agencies_notified=${result.rosterAgenciesNotified}`,
  );

  return result;
}

/**
 * Handles a NOTIFY_JOB_ALERTS task (JS-03 alert preferences): checks
 * the newly-created job against every alerts-enabled saved search and
 * emails matching seekers.
 * @param {import('bullmq').Job} bullJob
 */
async function handleNotifyJobAlerts(bullJob) {
  const { job_id: jobId } = bullJob.data || {};
  if (!jobId) {
    throw new Error('NOTIFY_JOB_ALERTS task payload is missing required "job_id"');
  }

  const result = await jobAlertsService.checkAndNotifySavedSearches(jobId);

  // eslint-disable-next-line no-console
  console.log(
    `[notifications-worker] job_id=${jobId} matched_saved_searches=${result.matchedSavedSearches} `
    + `seekers_notified=${result.seekersNotified}`,
  );

  return result;
}

/**
 * EMP-02: handles a NOTIFY_INTERVIEW_EVENT task: SMS's + emails the
 * candidate about an interview being scheduled/rescheduled/cancelled.
 * @param {import('bullmq').Job} bullJob
 */
async function handleNotifyInterviewEvent(bullJob) {
  const { interview_id: interviewId, event } = bullJob.data || {};
  if (!interviewId) {
    throw new Error('NOTIFY_INTERVIEW_EVENT task payload is missing required "interview_id"');
  }

  const result = await notificationsService.notifyInterviewEvent(interviewId, event);

  // eslint-disable-next-line no-console
  console.log(
    `[notifications-worker] interview_id=${interviewId} event=${event} `
    + `sms_sent=${result.smsSent} email_sent=${result.emailSent}`,
  );

  return result;
}

/**
 * EMP-02: handles a NOTIFY_NEW_MESSAGE task: SMS's + emails whichever
 * placement participant didn't send the message.
 * @param {import('bullmq').Job} bullJob
 */
async function handleNotifyNewMessage(bullJob) {
  const { message_id: messageId } = bullJob.data || {};
  if (!messageId) {
    throw new Error('NOTIFY_NEW_MESSAGE task payload is missing required "message_id"');
  }

  const result = await notificationsService.notifyNewMessage(messageId);

  // eslint-disable-next-line no-console
  console.log(
    `[notifications-worker] message_id=${messageId} `
    + `sms_sent=${result.smsSent} email_sent=${result.emailSent}`,
  );

  return result;
}

/**
 * JS-05: handles a NOTIFY_NEW_APPLICATION task: SMS's + emails the
 * job's poster that a seeker applied directly.
 * @param {import('bullmq').Job} bullJob
 */
async function handleNotifyNewApplication(bullJob) {
  const { application_id: applicationId } = bullJob.data || {};
  if (!applicationId) {
    throw new Error('NOTIFY_NEW_APPLICATION task payload is missing required "application_id"');
  }

  const result = await notificationsService.notifyNewApplication(applicationId);

  // eslint-disable-next-line no-console
  console.log(
    `[notifications-worker] application_id=${applicationId} `
    + `sms_sent=${result.smsSent} email_sent=${result.emailSent}`,
  );

  return result;
}

/**
 * SEEK-01: handles a NOTIFY_CATEGORY_SMS task: texts every seeker whose
 * chosen category preferences match the newly-created job's category.
 * @param {import('bullmq').Job} bullJob
 */
async function handleNotifyCategorySms(bullJob) {
  const { job_id: jobId } = bullJob.data || {};
  if (!jobId) {
    throw new Error('NOTIFY_CATEGORY_SMS task payload is missing required "job_id"');
  }

  const result = await jobAlertsService.notifyPreferredCategorySeekers(jobId);

  // eslint-disable-next-line no-console
  console.log(
    `[notifications-worker] job_id=${jobId} matched_category_seekers=${result.matchedSeekers} `
    + `sms_sent=${result.smsSent}/${result.matchedSeekers}`,
  );

  return result;
}

/**
 * Handles a NOTIFY_VERIFICATION_REJECTED task: SMS's + emails the
 * rejected employer/agency's phone/email with the reason and, if a
 * subscription payment was refunded as part of the rejection, the
 * refund outcome.
 * @param {import('bullmq').Job} bullJob
 */
async function handleNotifyVerificationRejected(bullJob) {
  const { user_id: userId, reason, refund } = bullJob.data || {};
  if (!userId) {
    throw new Error('NOTIFY_VERIFICATION_REJECTED task payload is missing required "user_id"');
  }

  const result = await notificationsService.notifyVerificationRejected(userId, reason, refund);

  // eslint-disable-next-line no-console
  console.log(
    `[notifications-worker] user_id=${userId} refund_status=${refund?.status} `
    + `sms_sent=${result.smsSent} email_sent=${result.emailSent}`,
  );

  return result;
}

/**
 * Handles a NOTIFY_ACCOUNT_STATUS_CHANGED task: SMS's + emails an
 * employer/agency when admin suspends or reactivates their account.
 * @param {import('bullmq').Job} bullJob
 */
async function handleNotifyAccountStatusChanged(bullJob) {
  const { user_id: userId, status, reason } = bullJob.data || {};
  if (!userId || !status) {
    throw new Error('NOTIFY_ACCOUNT_STATUS_CHANGED task payload is missing required "user_id"/"status"');
  }

  const result = await notificationsService.notifyAccountStatusChanged(userId, status, reason);

  // eslint-disable-next-line no-console
  console.log(
    `[notifications-worker] user_id=${userId} account_status=${status} `
    + `sms_sent=${result.smsSent} email_sent=${result.emailSent}`,
  );

  return result;
}

/**
 * Processes a single BullMQ job pulled off the `notifications` queue.
 * Dispatches by task name to the appropriate handler — this queue
 * carries both post-matching candidate alerts (NOTIFY_CANDIDATES) and
 * saved-search alert-preference emails (NOTIFY_JOB_ALERTS), since both
 * are "notify someone about a job via an external provider" tasks with
 * the same delivery/retry characteristics.
 *
 * @param {import('bullmq').Job} bullJob
 */
async function processNotificationJob(bullJob) {
  switch (bullJob.name) {
    case NOTIFY_CANDIDATES:
      return handleNotifyCandidates(bullJob);
    case NOTIFY_JOB_ALERTS:
      return handleNotifyJobAlerts(bullJob);
    case NOTIFY_INTERVIEW_EVENT:
      return handleNotifyInterviewEvent(bullJob);
    case NOTIFY_NEW_MESSAGE:
      return handleNotifyNewMessage(bullJob);
    case NOTIFY_NEW_APPLICATION:
      return handleNotifyNewApplication(bullJob);
    case NOTIFY_CATEGORY_SMS:
      return handleNotifyCategorySms(bullJob);
    case NOTIFY_VERIFICATION_REJECTED:
      return handleNotifyVerificationRejected(bullJob);
    case NOTIFY_ACCOUNT_STATUS_CHANGED:
      return handleNotifyAccountStatusChanged(bullJob);
    default:
      throw new Error(
        `Unsupported task name for "${NOTIFICATIONS_QUEUE_NAME}" queue: ${bullJob.name}`,
      );
  }
}

/**
 * Builds (but does not start listening beyond construction) the BullMQ
 * Worker for the notifications queue. Call from a dedicated worker
 * process entrypoint (see src/notifications-worker.js), not from the
 * HTTP API process.
 *
 * @returns {import('bullmq').Worker}
 */
function createNotificationsWorker() {
  const worker = new Worker(NOTIFICATIONS_QUEUE_NAME, processNotificationJob, {
    connection,
    concurrency: parseInt(process.env.NOTIFICATIONS_WORKER_CONCURRENCY || '5', 10),
  });

  worker.on('completed', (bullJob) => {
    // eslint-disable-next-line no-console
    console.log(`[notifications-worker] completed ${bullJob.id} (${bullJob.name})`);
  });

  worker.on('failed', (bullJob, err) => {
    // eslint-disable-next-line no-console
    console.error(`[notifications-worker] job ${bullJob?.id} failed:`, err.message);
  });

  return worker;
}

module.exports = { createNotificationsWorker, processNotificationJob };
