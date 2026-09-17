'use strict';

const { Queue } = require('bullmq');
const IORedis = require('ioredis');
const env = require('./env');

/**
 * Single shared ioredis connection reused by every BullMQ Queue/Worker in
 * the process. BullMQ manages its own retry/backoff semantics on top of
 * this connection, so `maxRetriesPerRequest` must be `null` and the
 * built-in ready-check disabled — this is a hard BullMQ requirement, not
 * a style choice.
 */
const connection = new IORedis(env.redis.url, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
});

connection.on('error', (err) => {
  // eslint-disable-next-line no-console
  console.error('[redis] connection error', err);
});

const MATCHING_QUEUE_NAME = 'matching';
const NOTIFICATIONS_QUEUE_NAME = 'notifications';

/**
 * The queue producers (API request handlers, cron jobs, etc.) push
 * `JOB_MATCHING` tasks onto. Consumed by workers/matching.worker.js.
 */
const matchingQueue = new Queue(MATCHING_QUEUE_NAME, { connection });

/**
 * The queue matching.worker.js pushes `NOTIFY_CANDIDATES` tasks onto
 * once a matching run has produced a shortlist. Consumed by
 * workers/notifications.worker.js, which fans SMS/email out via
 * services/notifications.service.js. Kept as its own queue (own
 * concurrency, own retry policy) rather than piggybacking on the
 * matching queue, since notification delivery has very different
 * failure characteristics (flaky third-party SMS/email APIs) than the
 * in-process matching algorithm.
 */
const notificationsQueue = new Queue(NOTIFICATIONS_QUEUE_NAME, { connection });

module.exports = {
  connection,
  matchingQueue,
  MATCHING_QUEUE_NAME,
  notificationsQueue,
  NOTIFICATIONS_QUEUE_NAME,
};
