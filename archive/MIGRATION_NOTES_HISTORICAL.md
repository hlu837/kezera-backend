# Migration Notes: Postgres → MongoDB (in progress)

## Scope of this change

This task migrated **only** the foundational schema + auth layer to MongoDB/Mongoose:

- `User`, `Seeker`, `Employer`, `Agency` Mongoose models (`src/models/`)
- `POST /api/v1/auth/register` and `POST /api/v1/auth/login` (`src/services/auth.service.js`)
- JWT issuance/verification and RBAC middleware are unchanged — they never touched the DB layer directly, so nothing there needed to change.

## What is still on PostgreSQL — read this before deploying

Every other module still reads/writes the **old SQL tables** (`users`, `seekers`, `employers`, `agencies`, `jobs`, `placements`) via `pg`/`src/config/db.js`, and has **not** been repointed at Mongo:

| Module | File(s) | Still queries Postgres `users`/`seekers`/`employers`/`agencies`? |
|---|---|---|
| Seeker profile mgmt | `services/seeker.service.js` | Yes |
| Employer profile mgmt | `services/employer.service.js` | Yes |
| Jobs | `services/jobs.service.js` | Yes (`jobs.creator_id → users.id`) |
| Matching engine | `services/matching.service.js`, `workers/matching.worker.js` | Yes (`seekers` pool query) |
| Placements | `services/placements.service.js` | Yes |
| Notifications (SMS/email dispatch) | `services/notifications.service.js` | **Yes — looks up employer/agency email and candidate phone numbers via the old `users`/`employers`/`agencies` tables** |
| Inbound SMS webhook | `services/smsInbound.service.js` | **Yes — matches the inbound sender's phone against Postgres `seekers`/`users`** |

### The practical consequence

A user who registers **after** this change is created in **MongoDB only**. None of the modules in the table above know how to find them, because they all query Postgres. Concretely, today:

- A newly-registered seeker will not show up as a matching candidate (`matching.service.js` reads Postgres `seekers`).
- A newly-registered employer/agency's job postings will fail (`jobs.service.js` does `creator_id UUID REFERENCES users(id)` against Postgres).
- The SMS notification dispatcher and inbound webhook handler will not find newly-registered users' phone numbers.

This is expected for this task's scope, not a bug — but it means **this is not yet safe to run as a full cutover**. The two realistic paths from here:

1. **Migrate the rest incrementally** (recommended, matches how this project has been built task-by-task): repoint `seeker.service.js`, `employer.service.js`, `jobs.service.js`, `matching.service.js`, `placements.service.js`, `notifications.service.js`, and `smsInbound.service.js` at the new Mongoose models in the same follow-up style as this task, one module at a time, keeping Postgres and Mongo both live until the last one lands.
2. **One-time backfill + full cutover**: write a one-off script to copy existing rows from Postgres `users`/`seekers`/`employers`/`agencies` into the new Mongo collections (preserving `_id` mapping via a lookup table, since Postgres UUIDs and Mongo ObjectIds aren't interchangeable), then migrate every remaining module in one pass and decommission the Postgres tables together.

Either way, don't remove `pg`/`DATABASE_URL` from the app yet — `src/config/env.js` still requires it, deliberately, because the modules above still need it.

## Local dev setup for Mongo transactions

`services/auth.service.js#register` uses `session.withTransaction(...)` to insert the `User` and its role profile atomically, mirroring the old Postgres `withTransaction` helper. **Mongoose transactions require a replica set** — a standalone `mongod` will throw at the first `startTransaction()` call. For local dev:

```bash
mongod --replSet rs0 --dbpath /path/to/data
# in a separate shell, once:
mongosh --eval "rs.initiate()"
```

Then point `MONGODB_URI` at it with `?replicaSet=rs0` (see `.env.example`).

## Response shape notes

- `register`/`login` responses keep the same top-level shape (`{ status, data: { user, profile, token } }`) and the request body still accepts the same snake_case fields (`full_name`, `cv_url`, etc.) — `auth.validator.js` didn't need to change.
- Within `user`/`profile`, Mongoose's `toJSON` transform (configured per-model in `src/models/`) renames `_id` → `id` and drops `__v`, so the object shape looks close to the old Postgres row shape (`id`, `phone`, `email`, `role`, `createdAt`), but note `createdAt`/`updatedAt` are camelCase now (Mongoose's `timestamps: true` default), not `created_at`.
- `passwordHash` never leaves `auth.service.js` — the schema marks it `select: false` *and* the `toJSON` transform deletes it as a second layer of defense, an upgrade over the old code's manual `delete user.password_hash`.
