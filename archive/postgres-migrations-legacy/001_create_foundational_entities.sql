-- Migration 001: Foundational entities.
-- Creates the base schema every later migration (002-005) and every
-- service in this app assumes already exists: the shared `users` table
-- plus the three role-specific profile tables (`seekers`, `employers`,
-- `agencies`) it fans out to.
-- Written to be safe to run multiple times.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ── ENUM types ──────────────────────────────────────────────────────

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'user_role') THEN
    -- 'admin' is included because rbac.middleware.js and
    -- example-protected.routes.js both guard an admin-only route, even
    -- though POST /api/v1/auth/register (auth.validator.js) only ever
    -- issues 'seeker' | 'employer' | 'agency' — admin accounts are
    -- expected to be provisioned directly, not self-registered.
    CREATE TYPE user_role AS ENUM ('seeker', 'employer', 'agency', 'admin');
  END IF;
END$$;

-- ── users ───────────────────────────────────────────────────────────
-- Shared identity/auth table for every role. auth.service.js inserts
-- here first, then fans out to the matching profile table below in the
-- same transaction.

CREATE TABLE IF NOT EXISTS users (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phone          VARCHAR(30) UNIQUE,
  email          VARCHAR(255) UNIQUE,
  password_hash  TEXT NOT NULL,
  role           user_role NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- login() looks up by phone OR email — both need to resolve fast.
CREATE INDEX IF NOT EXISTS idx_users_phone ON users (phone);
CREATE INDEX IF NOT EXISTS idx_users_email ON users (email);

-- A user must be reachable by at least one of phone/email to ever log in.
ALTER TABLE users
  DROP CONSTRAINT IF EXISTS users_phone_or_email_present;
ALTER TABLE users
  ADD CONSTRAINT users_phone_or_email_present
  CHECK (phone IS NOT NULL OR email IS NOT NULL);

-- ── seekers ─────────────────────────────────────────────────────────
-- Base columns only; 002 adds bio/availability_status/updated_at and
-- 004 adds skills/city, both defensively (IF NOT EXISTS), so this stays
-- minimal and lets those migrations own their own columns.

CREATE TABLE IF NOT EXISTS seekers (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  full_name   VARCHAR(255) NOT NULL,
  cv_url      TEXT,
  photo_url   TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_seekers_user_id ON seekers (user_id);

-- ── employers ───────────────────────────────────────────────────────
-- Base columns only; 003 adds company_name/logo_url/backoffice_phone/
-- promo_details/updated_at defensively. Included here too (matching
-- 003's IF NOT EXISTS additions) so a fresh DB gets the full shape from
-- a single migration run without relying on 003 for correctness.

CREATE TABLE IF NOT EXISTS employers (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  company_name      VARCHAR(255),
  logo_url          TEXT,
  backoffice_phone  VARCHAR(30),
  promo_details     TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_employers_user_id ON employers (user_id);

-- ── agencies ────────────────────────────────────────────────────────
-- auth.service.js's agency PROFILE_INSERTER writes agency_name and
-- operational_city and reads back ledger_balance, so all three need to
-- exist from the start (ledger_balance defaults to 0, not NULL, since
-- it's a running balance used in payout/withdrawal logic elsewhere).

CREATE TABLE IF NOT EXISTS agencies (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  agency_name       VARCHAR(255) NOT NULL,
  operational_city  VARCHAR(255),
  ledger_balance     NUMERIC(12, 2) NOT NULL DEFAULT 0,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_agencies_user_id ON agencies (user_id);
