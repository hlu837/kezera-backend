-- Adds columns the Job Seeker Profile module depends on, if migration
-- 001_create_foundational_entities.sql didn't already create them.
-- Safe to run multiple times.

ALTER TABLE seekers
  ADD COLUMN IF NOT EXISTS bio TEXT,
  ADD COLUMN IF NOT EXISTS availability_status BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
