'use strict';

const { matchingQueue } = require('../config/queue');
const env = require('../config/env');

/** BullMQ job "name" this queue's worker knows how to process. */
const JOB_MATCHING = 'JOB_MATCHING';

/**
 * Enqueues a JOB_MATCHING task for a given job posting. The worker
 * (workers/matching.worker.js) will pick it up, run the matching
 * algorithm, and produce a ranked candidate shortlist.
 *
 * Fire-and-forget from the caller's perspective: this only guarantees
 * the task was accepted by Redis, not that matching has finished.
 *
 * @param {string} jobId - jobs.id to compute matches for.
 * @param {{ topN?: number }} [options]
 * @returns {Promise<import('bullmq').Job>}
 */
async function enqueueJobMatching(jobId, options = {}) {
  const { topN = env.matching.defaultTopN } = options;

  return matchingQueue.add(
    JOB_MATCHING,
    { job_id: jobId, topN },
    {
      // Transient DB/Redis blips shouldn't lose a matching run.
      attempts: 3,
      backoff: { type: 'exponential', delay: 5000 },
      // Keep Redis tidy: bounded history of completed/failed jobs
      // instead of accumulating forever.
      removeOnComplete: { age: 3600, count: 1000 },
      removeOnFail: { age: 86400 },
      // Deterministic jobId per job posting: if the job is updated
      // again before the previous matching run finished, BullMQ
      // dedupes instead of piling up redundant runs for the same job.
      jobId: `job-matching:${jobId}`,
    },
  );
}

module.exports = { JOB_MATCHING, enqueueJobMatching };
