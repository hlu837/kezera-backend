'use strict';

/**
 * Fixed set of top-level job categories shown on the seeker onboarding
 * screen (SEEK-01: Category & Preference Setup) right after signup.
 *
 * Unlike SKILLS_TAXONOMY/CITIES_TAXONOMY (free-text seed lists), this is
 * a closed enum — Seeker.preferredCategories only ever stores one of
 * these `key` values, so both the mobile app's category grid and any
 * future SMS-alert-by-category matching stay in lockstep with the
 * backend. The mobile app hardcodes the same `key`s (with icon/label)
 * in `features/seeker/domain/job_category.dart` — change one, change
 * both.
 */
const JOB_CATEGORIES = [
  { key: 'tech_software', label: 'Tech & Software' },
  { key: 'hospitality_hotel', label: 'Hospitality & Hotel' },
  { key: 'construction_labor', label: 'Construction & Daily Labor' },
  { key: 'driver_delivery', label: 'Driver & Delivery' },
  { key: 'sales_marketing', label: 'Sales & Marketing' },
  { key: 'healthcare', label: 'Healthcare' },
  { key: 'other', label: 'Other Categories' },
];

const JOB_CATEGORY_KEYS = JOB_CATEGORIES.map((c) => c.key);

module.exports = { JOB_CATEGORIES, JOB_CATEGORY_KEYS };
