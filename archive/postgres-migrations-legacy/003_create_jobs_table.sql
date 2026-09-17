-- Task 4 (part 1): Jobs schema + Employer Profile Management support.
-- Creates the enums/table the Jobs module depends on, and defensively
-- ensures the employer-profile columns exist on `employers` in case
-- 001_create_foundational_entities.sql shipped without them.
-- Written to be safe to run multiple times.

-- ── ENUM types ──────────────────────────────────────────────────────
-- Postgres has no native `CREATE TYPE IF NOT EXISTS`, so guard manually.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'job_creator_type') THEN
    CREATE TYPE job_creator_type AS ENUM ('employer', 'agency');
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'job_type') THEN
    CREATE TYPE job_type AS ENUM ('Full-Time', 'Contract', 'Daily');
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'job_status') THEN
    CREATE TYPE job_status AS ENUM ('open', 'closed', 'draft');
  END IF;
END$$;

-- ── jobs table ──────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS jobs (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  creator_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  creator_type      job_creator_type NOT NULL,
  title             VARCHAR(255) NOT NULL,
  description       TEXT NOT NULL,
  location          VARCHAR(255) NOT NULL,
  salary_range      VARCHAR(100),
  job_type          job_type NOT NULL,
  skills_required   JSONB NOT NULL DEFAULT '[]'::jsonb,
  status            job_status NOT NULL DEFAULT 'draft',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- `gen_random_uuid()` lives in pgcrypto — make sure it's available.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ── Indexes ─────────────────────────────────────────────────────────
-- creator_id: "my jobs" listing for an employer/agency dashboard.
CREATE INDEX IF NOT EXISTS idx_jobs_creator_id ON jobs (creator_id);

-- status: public job board filters almost always start with status = 'open'.
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs (status);

-- job_type: common filter alongside status.
CREATE INDEX IF NOT EXISTS idx_jobs_job_type ON jobs (job_type);

-- created_at DESC: newest-first is the default sort on any job board.
CREATE INDEX IF NOT EXISTS idx_jobs_created_at ON jobs (created_at DESC);

-- Composite index for the most common query shape: open jobs, newest first.
CREATE INDEX IF NOT EXISTS idx_jobs_status_created_at ON jobs (status, created_at DESC);

-- GIN index to support containment queries against skills_required
-- (e.g. `WHERE skills_required @> '["plumbing"]'`).
CREATE INDEX IF NOT EXISTS idx_jobs_skills_required_gin ON jobs USING GIN (skills_required);

-- ── Employer profile columns (defensive) ───────────────────────────
-- Employer Profile Management (Task 4, part 2) reads/writes these
-- columns on `employers`. Add them if 001 didn't already.
ALTER TABLE employers
  ADD COLUMN IF NOT EXISTS company_name      VARCHAR(255),
  ADD COLUMN IF NOT EXISTS logo_url          TEXT,
  ADD COLUMN IF NOT EXISTS backoffice_phone  VARCHAR(30),
  ADD COLUMN IF NOT EXISTS promo_details     TEXT,
  ADD COLUMN IF NOT EXISTS updated_at        TIMESTAMPTZ NOT NULL DEFAULT now();
