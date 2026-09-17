# Migration Notes: Postgres → MongoDB (complete)

PostgreSQL has been fully removed from this app. Every module —
auth, seeker/employer profiles, jobs, matching, placements,
notifications, and inbound SMS — now reads/writes MongoDB via the
Mongoose models in `src/models/`.

## What changed in this pass

- Deleted `src/config/db.js` (the `pg` `Pool` + `withTransaction` helper).
- Removed the `pool` import/lifecycle calls from `src/server.js`,
  `src/matching-worker.js`, and `src/notifications-worker.js` — they no
  longer open or close a Postgres connection on boot/shutdown.
- Removed `DATABASE_URL` from `src/config/env.js`'s required vars and
  dropped the `databaseUrl` field from the exported config.
- Removed the `pg` dependency from `package.json`.
- Removed `DATABASE_URL` and `DB_POOL_MAX` from `.env.example`.
- Moved the old SQL migration files to
  `archive/postgres-migrations-legacy/` for historical reference — they
  are no longer run or referenced by the app.
- Moved the previous (now-historical) version of this file to
  `archive/MIGRATION_NOTES_HISTORICAL.md`. It documents the earlier
  hybrid state, back when only auth had been migrated — useful context
  if you're wondering why old comments in the codebase mention Postgres.

## Local dev setup for Mongo transactions

`services/auth.service.js#register` uses `session.withTransaction(...)`
to insert the `User` and its role profile atomically. **Mongoose
transactions require a replica set** — a standalone `mongod` will throw
at the first `startTransaction()` call. For local dev:

```bash
mongod --replSet rs0 --dbpath /path/to/data
# in a separate shell, once:
mongosh --eval "rs.initiate()"
```

Then point `MONGODB_URI` at it with `?replicaSet=rs0` (see `.env.example`).

## Response shape notes

- Within `user`/`profile` payloads, Mongoose's `toJSON` transform
  (configured per-model in `src/models/`) renames `_id` → `id` and drops
  `__v`. `createdAt`/`updatedAt` are camelCase (Mongoose's
  `timestamps: true` default), not the old `created_at`/`updated_at`.
- `passwordHash` never leaves `auth.service.js` — the schema marks it
  `select: false` *and* the `toJSON` transform deletes it as a second
  layer of defense.

## If you still have a live Postgres database

This change only touches the app's code — it doesn't delete any data.
If you have an existing Postgres instance with production data that
was never backfilled into MongoDB, don't decommission it until you've
verified every collection in Mongo has what you need. The archived SQL
files under `archive/postgres-migrations-legacy/` show the original
schema if you need to check field-for-field parity.
