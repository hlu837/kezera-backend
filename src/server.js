'use strict';

require('dotenv').config({ override: true });

const app = require('./app');
const env = require('./config/env');
const { mongoose, connectMongo } = require('./config/mongoose');

async function start() {
  // The whole app is backed by MongoDB now — establish the connection
  // before accepting traffic so a request doesn't 500 because we raced
  // connection setup.
  await connectMongo();

  const server = app.listen(env.port, () => {
    // eslint-disable-next-line no-console
    console.log(`[keferajobs-auth] listening on port ${env.port}`);
  });

  async function shutdown(signal) {
    // eslint-disable-next-line no-console
    console.log(`[keferajobs-auth] received ${signal}, shutting down gracefully...`);
    server.close(async () => {
      await mongoose.connection.close();
      process.exit(0);
    });
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

start().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[keferajobs-auth] failed to start', err);
  process.exit(1);
});
