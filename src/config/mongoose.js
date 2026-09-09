'use strict';

const mongoose = require('mongoose');
const env = require('./env');

mongoose.set('strictQuery', true);

mongoose.connection.on('error', (err) => {
  // Mirrors config/db.js's pool.on('error', ...) — errors on an
  // established connection should never crash the process silently.
  // eslint-disable-next-line no-console
  console.error('[mongo] connection error', err);
});

/**
 * Opens the Mongoose connection. Call once at process startup (see
 * src/server.js); safe to call again if already connected.
 *
 * @returns {Promise<import('mongoose').Connection>}
 */
async function connectMongo() {
  if (mongoose.connection.readyState === 1) {
    return mongoose.connection;
  }

  await mongoose.connect(env.mongo.uri, {
    // Serverless-friendly tuning: `api/index.js` caches this connection
    // across warm invocations of the same function instance (see its
    // module-scoped `mongoConnection`), but many concurrent cold starts
    // can still each open a connection — keep the per-instance pool
    // small so a burst of cold starts doesn't exhaust Atlas's total
    // connection limit.
    maxPoolSize: 5,
    // Fail fast instead of hanging the whole function invocation (and
    // burning execution time/cost) if Atlas is unreachable.
    serverSelectionTimeoutMS: 8000,
    // Never silently queue operations while disconnected — surface the
    // error immediately so a caller sees a real 5xx instead of a
    // request that hangs until the function times out.
    bufferCommands: false,
  });

  // eslint-disable-next-line no-console
  console.log(`[mongo] connected to ${mongoose.connection.name}`);

  return mongoose.connection;
}

module.exports = { mongoose, connectMongo };
