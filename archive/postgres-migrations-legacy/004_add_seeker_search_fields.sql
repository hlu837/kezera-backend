-- Adds the columns Candidate Search (Task 4B) filters against.
-- 002_add_seeker_profile_fields.sql covered availability_status/bio;
-- this migration adds the skills/location fields the employer-facing
-- search endpoint (`GET /api/v1/seekers/search`) needs.
-- Safe to run multiple times.

ALTER TABLE seekers
  ADD COLUMN IF NOT EXISTS skills JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS city   VARCHAR(255);

-- ── Indexes to support GET /api/v1/seekers/search ──────────────────

-- availability_status: every search starts with `WHERE availability_status = true`.
CREATE INDEX IF NOT EXISTS idx_seekers_availability_status ON seekers (availability_status);

-- city: simple equality/ILIKE filter, paired with availability in most queries.
CREATE INDEX IF NOT EXISTS idx_seekers_city ON seekers (city);

-- skills: GIN index to support `?|` (any-of) containment queries, mirroring
-- the same pattern used for jobs.skills_required in 003.
CREATE INDEX IF NOT EXISTS idx_seekers_skills_gin ON seekers USING GIN (skills);

-- Composite index for the hot path: available seekers in a given city.
CREATE INDEX IF NOT EXISTS idx_seekers_availability_city ON seekers (availability_status, city);
