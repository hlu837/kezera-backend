'use strict';

require('dotenv').config();

const { createMatchingWorker } = require('./workers/matching.worker');
const { connection } = require('./config/queue');
const { mongoose, connectMongo } = require('./config/mongoose');

// Run with: `npm run worker` (or `npm run worker:dev` for autoreload).
// Deliberately a separate process from src/server.js — the HTTP API and
// the background worker scale independently. It's also deployed
// separately from the API in production: this is a long-running BullMQ
// consumer, which Vercel's serverless functions cannot host (see
// DEPLOYMENT.md) — run it on Railway/Render/Fly.io/a VPS instead.
//
// `matching.worker.js` reads/writes Placement/Job/Seeker documents via
// services/*.service.js, so — same as src/server.js — the Mongo
// connection must be established before the worker starts pulling jobs
// off the queue, not left to lazily happen on first query.
async function start() {
  await connectMongo();

  const worker = createMatchingWorker();

  // eslint-disable-next-line no-console
  console.log('[matching-worker] listening for JOB_MATCHING tasks...');

  async function shutdown(signal) {
    // eslint-disable-next-line no-console
    console.log(`[matching-worker] received ${signal}, shutting down gracefully...`);
    // Waits for any in-flight job to finish before closing, rather than
    // killing it mid-run.
    await worker.close();
    await connection.quit();
    await mongoose.connection.close();
    process.exit(0);
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

start().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[matching-worker] failed to start', err);
  process.exit(1);
});
