'use strict';

/**
 * A seeker can have multiple `education` entries (see Seeker.model.js),
 * each with its own optional `gpa`. There's no single "the seeker's
 * GPA" field — for ranking/display purposes we take the highest GPA
 * across their entries (their best-documented result), since that's
 * the number a candidate would want surfaced and is stable regardless
 * of how many degrees they've listed.
 *
 * @param {{ education?: Array<{ gpa?: number|null }> }} seeker - a
 *   Seeker.toJSON()-shaped object (or the raw subdocument array).
 * @returns {number|null} highest gpa found, or null if none of the
 *   seeker's education entries have one set.
 */
function getHighestGpa(seeker) {
  const entries = seeker?.education || [];
  const values = entries
    .map((e) => e?.gpa)
    .filter((g) => typeof g === 'number' && !Number.isNaN(g));
  if (values.length === 0) return null;
  return Math.max(...values);
}

module.exports = { getHighestGpa };
