# Deployment guide — Backend (Vercel)

This folder (`backend-clean/`) is a standalone Node/Express API. The
simplest setup is to push it to its own Git repository and import
*that* into Vercel — `vercel.json` and `api/index.js` already assume
they sit at the repo root, so no "Root Directory" setting is needed
in that case.

(If you'd rather keep this and `kezerajobs-frontend-clean/` in one
monorepo instead, that also works — just set the Vercel project's
**Root Directory** to `backend-clean` in Settings → General.)

---

## ⚠️ Before anything else: rotate your credentials

`.env` in this folder has **live secrets in plaintext** — a MongoDB
connection string (with password), AWS access keys, a JWT signing
secret, Chapa payment keys, and whatever else you've filled in. It is
now covered by `.gitignore` (added in this pass — there was no
`.gitignore` here before, so nothing stopped it from being committed),
but the values themselves have already been sitting unprotected in
this project folder. If this zip or an earlier copy of it ever went
anywhere outside your own machine — another tool, a shared drive,
another chat — treat those values as compromised and rotate them:

- **MongoDB**: change the database user's password (or delete/recreate
  the user), then update `MONGODB_URI`.
- **AWS**: deactivate that IAM access key pair and issue a new one.
- **JWT_SECRET**: generate a new long random value (this invalidates
  all existing login sessions — expected and fine).
- **Chapa**: rotate the secret key from the Chapa dashboard.
- Any of `TWILIO_*`, `AT_*`, `SENDGRID_API_KEY`, `ANTHROPIC_API_KEY` you
  filled in — rotate from each provider's dashboard.

`.env.example` is the checked-in template with no real values — copy
it to `.env` for local dev only; `.env` itself should never be
committed (it's gitignored now).

---

## 1. Create the Vercel project

- Import the repo into Vercel (see the Root Directory note above if
  it's a monorepo).
- Framework preset: **Other** — this is a plain Node/Express app, not
  Next.js.
- Build command / output directory: leave both blank. `vercel.json`
  already routes everything to `api/index.js`; there's nothing to
  build.
- Node.js version: Vercel should pick this up from `"engines": {
  "node": "20.x" }` in `package.json` automatically — worth
  double-checking under Settings → General → Node.js Version if
  anything looks off after the first deploy.

## 2. Set environment variables

In the project's Settings → Environment Variables, add every key from
`.env.example` with real values. The app won't boot at all without
these (see `src/config/env.js`'s `REQUIRED_VARS` — a missing one
throws at cold start, so every request 500s until it's set):

- `MONGODB_URI` — must point at a **MongoDB Atlas** cluster (or
  another reachable replica set, not a local `mongod`). Mongoose
  transactions (`services/auth.service.js#register`) require a replica
  set, which Atlas gives you by default.
- `JWT_SECRET`, `JWT_EXPIRES_IN`, `JWT_ISSUER`
- `AWS_REGION`, `AWS_S3_BUCKET`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`

Not boot-required, but needed for the features that use them:

- `BCRYPT_SALT_ROUNDS`, `MAX_UPLOAD_SIZE_MB`
- `REDIS_URL` — see the Upstash note below; without it, job creation
  still enqueues matching tasks but nothing ever processes them
- `PUBLIC_BASE_URL` — the exact `https://your-project.vercel.app`
  origin, used to verify Twilio's inbound webhook signature
- `SMS_PROVIDER` plus whichever of `TWILIO_*` / `AT_*` you use — the
  inbound SMS webhook route runs on the API itself, so it needs these
  even though outbound sending happens in a separate worker
- `SENDGRID_API_KEY`, `NOTIFICATIONS_FROM_EMAIL`, `NOTIFICATIONS_FROM_NAME`
- `CHAPA_SECRET_KEY`, `CHAPA_PUBLIC_KEY`, `CHAPA_WEBHOOK_SECRET`,
  `CHAPA_BASE_URL` — payments run in simulated mode without these,
  fine for testing, not for real transactions
- `ANTHROPIC_API_KEY` — powers the AI-assisted applicant summary
  (`GET /jobs/:id/applications/summary`); without it that endpoint
  still returns the structured stats, just with `aiAvailable: false`

MongoDB Atlas network access: either allow-list `0.0.0.0/0` (Vercel's
outbound IPs aren't static) or use the Vercel↔Atlas integration from
the Vercel marketplace, which handles this for you.

## 3. Redis — use a serverless-friendly provider

`ioredis`/BullMQ need a real persistent TCP connection, which rules
out most "HTTP-only" serverless Redis products. **Upstash Redis**
works — it gives you a standard `rediss://` URL that `ioredis`
connects to directly. Create a database there and set `REDIS_URL` to
that connection string.

## 4. Deploy, then verify

Push to the branch Vercel is watching (or run `vercel --prod` from
this folder). Once it's live, hit
`https://your-project.vercel.app/health` — it should return
`{"status":"ok"}`.

## 5. ⚠️ The background workers do NOT run on Vercel

`src/matching-worker.js` and `src/notifications-worker.js` are
long-running BullMQ consumers — they sit in a loop pulling jobs off
Redis. Vercel serverless functions are stateless and short-lived and
cannot host these. If you deploy only the API to Vercel:

- Job creation still **enqueues** a `JOB_MATCHING` task (the route
  that does this doesn't need a worker running).
- Nothing ever **processes** that task — no suggested seekers, no
  candidate notifications — until a worker is running somewhere.

Deploy the two workers as persistent processes on a platform that
supports them — Railway, Render, Fly.io, or a small VPS all work.
Point them at the same `MONGODB_URI` and `REDIS_URL` as the Vercel API.
Start commands:

```bash
npm run worker                # src/matching-worker.js
npm run notifications-worker  # src/notifications-worker.js
```

Both establish their own MongoDB connection on startup already (see
the top of each file), so they don't need anything beyond the two env
vars above to run correctly.

## 6. One thing worth watching on first deploy: `bcrypt`

`bcrypt` (used for password hashing in `services/auth.service.js` and
`services/agency.service.js`) is a native module — it compiles a
binary as part of `npm install`. This generally works fine on Vercel's
build image, but it's a common enough source of "works locally, fails
on deploy" surprises with serverless platforms that it's worth
checking your first deploy's build logs closely if anything fails
around `npm install`. If it ever does cause trouble, the usual fix is
switching to the pure-JS `bcryptjs` package (drop-in compatible hash
format) — not done preemptively here since it's not a problem unless
it actually shows up.
