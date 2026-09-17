'use strict';

require('dotenv').config();

const { createNotificationsWorker } = require('./workers/notifications.worker');
const { connection } = require('./config/queue');
const { mongoose, connectMongo } = require('./config/mongoose');

// Run with: `npm run notifications-worker` (or `:dev` for autoreload).
// Deliberately a separate process from src/server.js and
// src/matching-worker.js — SMS/email delivery has its own latency and
// failure profile and should scale/restart independently of both. Also
// deployed separately from the API in production — see the note in
// src/matching-worker.js on why this can't run on Vercel.
//
// `notifications.worker.js` reads Seeker/SavedSearch documents via
// services/*.service.js, so the Mongo connection must be up before the
// worker starts consuming — same reasoning as matching-worker.js.
async function start() {
  await connectMongo();

  const worker = createNotificationsWorker();

  // eslint-disable-next-line no-console
  console.log('[notifications-worker] listening for NOTIFY_CANDIDATES tasks...');

  async function shutdown(signal) {
    // eslint-disable-next-line no-console
    console.log(`[notifications-worker] received ${signal}, shutting down gracefully...`);
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
  console.error('[notifications-worker] failed to start', err);
  process.exit(1);
});
