'use strict';

require('dotenv').config({ override: true });

const { mongoose, connectMongo } = require('../src/config/mongoose');
const { Seeker, Technician } = require('../src/models');

/**
 * Phase 3 of the Expert/Technician split (see Technician.model.js's
 * top-of-file note for the full background): backfills a `Technician`
 * document for every existing `Seeker` that has `tradeCategory` set,
 * copying over the fields that used to live on `Seeker` for exactly
 * this purpose (fullName, city, latitude/longitude, availabilityStatus)
 * into their new dedicated home.
 *
 * Deliberately additive and re-runnable:
 *   - `Seeker.tradeCategory`/lat/lng are left untouched here. Nothing
 *     reads from `Technician` yet (that's Phase 4), so there's no
 *     window where a half-migrated Seeker "disappears" from anywhere.
 *     Clearing the old fields off `Seeker` is Phase 6, once the
 *     frontend has fully cut over.
 *   - Safe to run more than once: an existing `Technician` for a given
 *     `userId` is left alone rather than duplicated or overwritten, so
 *     a technician who has already edited their new profile (via
 *     PATCH /technicians/me, Phase 2) never has that edit clobbered by
 *     a re-run of this script.
 *
 * Usage: npm run migrate:technicians
 *   --dry-run   Log what would be created without writing anything.
 */
async function migrateTechnicians({ dryRun = false } = {}) {
  const candidates = await Seeker.find({ tradeCategory: { $ne: null } }).select(
    'userId fullName tradeCategory city latitude longitude availabilityStatus',
  );

  console.log(`[migrate:technicians] found ${candidates.length} Seeker(s) with tradeCategory set`);

  let created = 0;
  let skipped = 0;

  for (const seeker of candidates) {
    const already = await Technician.findOne({ userId: seeker.userId }).select('_id');
    if (already) {
      skipped += 1;
      console.log(`[migrate:technicians] skip (already exists): userId=${seeker.userId}`);
      continue;
    }

    const doc = {
      userId: seeker.userId,
      fullName: seeker.fullName,
      tradeCategory: seeker.tradeCategory,
      city: seeker.city || null,
      availabilityStatus: seeker.availabilityStatus,
    };

    // Only carry over coordinates (and the GeoJSON mirror they need
    // for `2dsphere`) when the seeker actually had both — same
    // "lat without lng isn't a usable point" rule as
    // seeker.service.js#updateLocation / technician.service.js#updateLocation.
    if (seeker.latitude != null && seeker.longitude != null) {
      doc.latitude = seeker.latitude;
      doc.longitude = seeker.longitude;
      doc.location = { type: 'Point', coordinates: [seeker.longitude, seeker.latitude] };
    }

    if (dryRun) {
      console.log(`[migrate:technicians] would create: ${JSON.stringify(doc)}`);
    } else {
      await Technician.create(doc);
      console.log(`[migrate:technicians] created: userId=${seeker.userId}, trade=${seeker.tradeCategory}`);
    }
    created += 1;
  }

  console.log(
    `\n[migrate:technicians] done. ${dryRun ? 'would create' : 'created'}: ${created}, skipped (already existed): ${skipped}`,
  );
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');

  await connectMongo();
  await migrateTechnicians({ dryRun });
  await mongoose.connection.close();
}

// Guarded so `require`ing this file (e.g. from a test, or a future
// script that wants to call migrateTechnicians() directly) never
// triggers a real run as a side effect — only running this file
// directly (`node scripts/migrate-technicians.js`) does.
if (require.main === module) {
  main().catch((err) => {
    console.error('[migrate:technicians] failed:', err);
    process.exit(1);
  });
}

module.exports = { migrateTechnicians };
