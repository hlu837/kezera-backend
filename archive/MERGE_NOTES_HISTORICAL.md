# KeferaJobs — Merged Codebase Snapshot

This zip bundles the three repos into their current best-known-good state.
No new code was written — this is a consolidation of what you uploaded,
with one superseded backend branch dropped. Three folders:

- `backend/` — Express API
- `web-backoffice/` — Next.js Employer + Agency backoffice
- `mobile-app/` — Flutter Job Seeker app

## What changed from your uploads

**Backend: `kefera-jobs-agency-dispatch-ledger-task7.zip` used as-is.**
`kefera-jobs-mongo-migration-part2.zip` was **not** merged in — it was a
sibling branch that split off ~30 min before Task 7 (Agency Dispatch &
Ledger) landed, and every file it contains is either identical to or older
than task7's version. It has no Agency module at all (no
`agency.controller.js` / `agency.routes.js` / `agency.service.js` /
`agency.validator.js` / `AgencyFinancial.model.js`), and is missing the
`agencyId` field on `Seeker`, the `sentAt` field on `Placement`, and
`validateOptionalUploadedFiles` in the upload middleware. Task7 is a
strict superset, so it's the only backend included here.

**Web backoffice: used as-is, unchanged.**
Verified its `agencyApi.ts` calls (`/agencies/walk-in`, `/agencies/candidates`,
`/agencies/dispatch`, `/agencies/finance/ledger`, `/agencies/dashboard/stats`)
match `backend/src/routes/agency.routes.js` 1:1. No merge conflicts, nothing
to reconcile.

**Mobile app: used as-is, unchanged.**
Still auth-only (login/register/logout). It does not yet call any of the
backend's seeker profile endpoints (`GET/PATCH /seekers/me`, `PATCH
/seekers/me/availability`, `POST /seekers/upload`), even though the backend
already supports all three. That's a gap to close later — deliberately not
built here per your instruction.

## Known pre-existing issue carried over from the backend repo

Per `backend/MIGRATION_NOTES.md` (unedited, included as-is): only the auth
layer (`register`/`login` + `User`/`Seeker`/`Employer`/`Agency` models) has
been migrated to MongoDB. Every other module — seeker/employer profile
management, jobs, matching, placements, notifications, inbound SMS — still
reads/writes the old PostgreSQL tables. A user who registers today exists
in MongoDB only and won't be visible to any of those Postgres-backed
modules. This is called out in the backend repo itself as not yet safe for
a full cutover; nothing in this merge changes that status.

**Update:** PostgreSQL has since been fully removed from `backend/`. Every
module now reads/writes MongoDB — see `backend/MIGRATION_NOTES.md` for
what changed. The paragraph above describes the state at the time of this
merge and is kept for history.
