-- Task 5B: persists the matching worker's output so results survive
-- past a single BullMQ job's return value, and can be served back via
-- GET /api/v1/jobs/:id/suggested-seekers.
-- Safe to run multiple times.

-- ── ENUM type ───────────────────────────────────────────────────────

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'placement_status') THEN
    CREATE TYPE placement_status AS ENUM ('matched', 'sent', 'hired', 'rejected');
  END IF;
END$$;

-- ── placements table ────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS placements (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id      UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  seeker_id   UUID NOT NULL REFERENCES seekers(id) ON DELETE CASCADE,
  -- Set when the job was posted by an agency (jobs.creator_type =
  -- 'agency'), so that agency owns/handles this placement. NULL when
  -- the job was posted directly by an employer.
  agency_id   UUID REFERENCES agencies(id) ON DELETE SET NULL,
  status      placement_status NOT NULL DEFAULT 'matched',
  -- The matching algorithm's score (see matching.service.js#scoreCandidate)
  -- at the time this row was written. Not part of the original 4-column
  -- spec, but required to serve a *ranked* list back out without
  -- recomputing the match on every read; nullable so rows created by
  -- any future path that doesn't have a score can still be inserted.
  score       NUMERIC(5, 4),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- A seeker should only ever have one placement row per job. Re-running
-- the matching worker for the same job (e.g. after the posting is
-- edited) must upsert rather than accumulate duplicate 'matched' rows.
CREATE UNIQUE INDEX IF NOT EXISTS idx_placements_job_seeker_unique
  ON placements (job_id, seeker_id);

-- GET /api/v1/jobs/:id/suggested-seekers reads by job_id, ordered by score.
CREATE INDEX IF NOT EXISTS idx_placements_job_id_score
  ON placements (job_id, score DESC);

-- Occasionally useful the other direction (a seeker's placement history).
CREATE INDEX IF NOT EXISTS idx_placements_seeker_id ON placements (seeker_id);

-- Agency-facing "my placements" dashboards, when agency_id is set.
CREATE INDEX IF NOT EXISTS idx_placements_agency_id ON placements (agency_id)
  WHERE agency_id IS NOT NULL;

-- status: pipeline views ("show me everything not yet 'sent'", etc.)
CREATE INDEX IF NOT EXISTS idx_placements_status ON placements (status);
