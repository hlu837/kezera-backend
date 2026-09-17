'use strict';

const { Worker } = require('bullmq');
const { connection, MATCHING_QUEUE_NAME } = require('../config/queue');
const { JOB_MATCHING } = require('../queues/matching.queue');
const { enqueueCandidateAlerts } = require('../queues/notifications.queue');
const matchingService = require('../services/matching.service');
const placementsService = require('../services/placements.service');

/**
 * Processes a single BullMQ job pulled off the `matching` queue.
 *
 * Computes the ranked candidate shortlist for `job_id`, then persists
 * the top-ranked candidates into `placements` (status 'matched') so
 * GET /api/v1/jobs/:id/suggested-seekers has something to serve.
 * Finally hands the shortlist off to the `notifications` queue
 * (workers/notifications.worker.js), which SMS's each candidate and
 * emails the job poster a summary — kept as a separate queue/worker
 * rather than inline here so a flaky SMS/email provider can never slow
 * down or fail a matching run.
 *
 * @param {import('bullmq').Job} bullJob
 */
async function processMatchingJob(bullJob) {
  if (bullJob.name !== JOB_MATCHING) {
    // Guards against the queue ever being reused for an unrelated task
    // name without an explicit handler for it.
    throw new Error(`Unsupported task name for "${MATCHING_QUEUE_NAME}" queue: ${bullJob.name}`);
  }

  const { job_id: jobId, topN } = bullJob.data || {};
  if (!jobId) {
    throw new Error('JOB_MATCHING task payload is missing required "job_id"');
  }

  const result = await matchingService.matchCandidatesForJob(jobId, { topN });

  // eslint-disable-next-line no-console
  console.log(
    `[matching-worker] job_id=${jobId} evaluated=${result.evaluatedCount} `
    + `shortlisted=${result.candidates.length}`,
  );

  // Agencies own the placement when they're the ones who posted the
  // job; a directly-posted employer job has no agency in the loop.
  const agencyId = result.job.creatorType === 'agency' ? result.job.creatorId : null;

  const placementsWritten = await placementsService.saveMatchedPlacements(
    jobId,
    agencyId,
    result.candidates,
  );

  // eslint-disable-next-line no-console
  console.log(`[matching-worker] job_id=${jobId} placements written/updated=${placementsWritten}`);

  if (result.candidates.length > 0) {
    await enqueueCandidateAlerts(jobId, result.candidates);
  }

  // Stored by BullMQ as this job's `returnvalue` in addition to now
  // being durably persisted in `placements`.
  return result;
}

/**
 * Builds (but does not start listening beyond construction) the BullMQ
 * Worker for the matching queue. Call from a dedicated worker process
 * entrypoint (see src/matching-worker.js), not from the HTTP API process.
 *
 * @returns {import('bullmq').Worker}
 */
function createMatchingWorker() {
  const worker = new Worker(MATCHING_QUEUE_NAME, processMatchingJob, {
    connection,
    concurrency: parseInt(process.env.MATCHING_WORKER_CONCURRENCY || '5', 10),
  });

  worker.on('completed', (bullJob) => {
    // eslint-disable-next-line no-console
    console.log(`[matching-worker] completed ${bullJob.id} (${bullJob.name})`);
  });

  worker.on('failed', (bullJob, err) => {
    // eslint-disable-next-line no-console
    console.error(`[matching-worker] job ${bullJob?.id} failed:`, err.message);
  });

  return worker;
}

module.exports = { createMatchingWorker, processMatchingJob };
