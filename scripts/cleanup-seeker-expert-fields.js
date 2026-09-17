'use strict';

require('dotenv').config({ override: true });

const { mongoose, connectMongo } = require('../src/config/mongoose');
const { Seeker } = require('../src/models');

/**
 * Phase 6 of the Expert/Technician split (see migrate-technicians.js's
 * top-of-file note and Technician.model.js for the full background):
 * `Seeker.model.js` no longer declares `tradeCategory`, `latitude`,
 * `longitude`, or `location` — but Mongoose removing a field from a
 * schema doesn't touch data already sitting in MongoDB. Any Seeker
 * document that had these set (which migrate-technicians.js has
 * already copied into a `Technician` doc, back in Phase 3) still has
 * them physically stored; this just clears that now-orphaned data and
 * drops the `location` 2dsphere index those fields needed, which
 * Mongoose's `autoIndex` never removes on its own since it only
 * creates indexes still declared in the schema, never drops ones that
 * aren't.
 *
 * Purely a hygiene pass — not required for the app to work correctly.
 * A Seeker document with leftover `tradeCategory`/lat/lng sitting in
 * Mongo is harmless: Mongoose only hydrates paths declared in the
 * schema, so that data is already invisible to every route/service in
 * this codebase. Run this whenever it's convenient after deploying
 * the Phase 6 code changes, not urgently before.
 *
 * Safe to run more than once: `$unset` on a field that's already gone
 * is a no-op, and dropping an index that's already gone is caught and
 * logged rather than treated as a failure.
 *
 * Usage: npm run cleanup:seeker-expert-fields
 *   --dry-run   Log what would change without writing anything.
 */
async function cleanupSeekerExpertFields({ dryRun = false } = {}) {
  const matchCount = await Seeker.countDocuments({
    $or: [
      { tradeCategory: { $ne: null } },
      { latitude: { $ne: null } },
      { longitude: { $ne: null } },
      { location: { $exists: true } },
    ],
  });

  console.log(`[cleanup:seeker-expert-fields] found ${matchCount} Seeker(s) with leftover Expert field data`);

  if (matchCount > 0) {
    if (dryRun) {
      console.log('[cleanup:seeker-expert-fields] would $unset tradeCategory/latitude/longitude/location on those documents');
    } else {
      const result = await Seeker.collection.updateMany(
        {
          $or: [
            { tradeCategory: { $ne: null } },
            { latitude: { $ne: null } },
            { longitude: { $ne: null } },
            { location: { $exists: true } },
          ],
        },
        { $unset: { tradeCategory: '', latitude: '', longitude: '', location: '' } },
      );
      console.log(`[cleanup:seeker-expert-fields] cleared fields on ${result.modifiedCount} document(s)`);
    }
  }

  // The index name Mongoose auto-generates for `{ location: '2dsphere' }`
  // is `location_2dsphere` — same convention as any other single-field
  // index. Dropping it is independent of the $unset above (an index can
  // exist on a collection with no matching documents left).
  if (dryRun) {
    console.log('[cleanup:seeker-expert-fields] would drop index: location_2dsphere');
  } else {
    try {
      await Seeker.collection.dropIndex('location_2dsphere');
      console.log('[cleanup:seeker-expert-fields] dropped index: location_2dsphere');
    } catch (err) {
      // Code 27 = IndexNotFound — already gone (e.g. a re-run, or a
      // fresh database that never had it). Anything else is a real
      // problem worth surfacing.
      if (err.codeName === 'IndexNotFound' || err.code === 27) {
        console.log('[cleanup:seeker-expert-fields] index location_2dsphere already absent, nothing to drop');
      } else {
        throw err;
      }
    }
  }

  console.log('\n[cleanup:seeker-expert-fields] done.');
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');

  await connectMongo();
  await cleanupSeekerExpertFields({ dryRun });
  await mongoose.connection.close();
}

// Guarded the same way as migrate-technicians.js — only running this
// file directly triggers a real run.
if (require.main === module) {
  main().catch((err) => {
    console.error('[cleanup:seeker-expert-fields] failed:', err);
    process.exit(1);
  });
}

module.exports = { cleanupSeekerExpertFields };
