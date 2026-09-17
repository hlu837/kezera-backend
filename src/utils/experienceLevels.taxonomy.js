'use strict';

/**
 * Fixed set of seniority bands used to filter candidate search
 * (`GET /seekers/search` / `/seekers/public-search`) and, going forward,
 * to tag a seeker's own profile. A closed enum rather than free-text
 * years-of-experience — mirrors the `JOB_CATEGORY_KEYS` pattern in
 * `jobCategories.taxonomy.js`. The mobile app hardcodes the same `key`s
 * (with label) in `features/seeker/domain/experience_level.dart` —
 * change one, change both.
 */
const EXPERIENCE_LEVELS = [
  { key: 'entry', label: 'Entry Level (0–2 yrs)' },
  { key: 'mid', label: 'Mid Level (2–5 yrs)' },
  { key: 'senior', label: 'Senior Level (5+ yrs)' },
];

const EXPERIENCE_LEVEL_KEYS = EXPERIENCE_LEVELS.map((l) => l.key);

module.exports = { EXPERIENCE_LEVELS, EXPERIENCE_LEVEL_KEYS };
