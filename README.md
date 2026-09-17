# KeferaJobs — Authentication Module

Multi-role authentication for the KeferaJobs platform (seekers, employers, agencies, admins), built on Express + MongoDB (Mongoose).

## Setup

```bash
npm install
cp .env.example .env   # then fill in real values
npm run dev             # or: npm start
```

`MONGODB_URI` must point at a replica set — Mongoose transactions
(`services/auth.service.js#register`) require one even in local dev:

```bash
mongod --replSet rs0 --dbpath /path/to/data
# in a separate shell, once:
mongosh --eval "rs.initiate()"
```

## Vercel deployment

Create a Vercel project from this repository and set its **Root Directory**
to `backend-clean`. Vercel will use `api/index.js` as the serverless entry point;
no build command is required. Add the variables from `.env.example` in the
Vercel project settings, especially `MONGODB_URI` and `JWT_SECRET`.

After deployment, the API endpoints are available under:
`https://<your-vercel-domain>/api/v1`.

Set the Flutter build-time API URL to that address, for example:

```bash
flutter build web --dart-define=API_BASE_URL=https://<your-vercel-domain>/api/v1
```

> ⚠️ **`src/matching-worker.js` and `src/notifications-worker.js` do not
> run on Vercel** — they're long-running BullMQ consumers, and Vercel's
> serverless functions are stateless/short-lived. Deploy them separately
> (Railway, Render, Fly.io, a VPS — anything that runs a persistent Node
> process) pointed at the same `MONGODB_URI` and `REDIS_URL`. Without a
> worker running somewhere, job creation still enqueues matching tasks,
> but nothing ever processes them.
>
> See `DEPLOYMENT.md` in this folder for the full checklist (env vars,
> Redis provider choice, credential rotation). `kezerajobs-frontend-clean/DEPLOYMENT.md`
> covers the Flutter/Codemagic side.


> Legacy SQL migration files from this project's earlier Postgres-backed
> version are kept for reference under `archive/postgres-migrations-legacy/`.
> They are no longer used — every module now reads/writes MongoDB via the
> Mongoose models in `src/models/`.

## Endpoints

### `POST /api/v1/auth/register`

Registers a user and their role-specific profile in one DB transaction (rolls back fully on any failure, e.g. duplicate phone).

```json
{
  "role": "seeker",
  "phone": "+251911223344",
  "email": "seeker@example.com",
  "password": "a-strong-password",
  "full_name": "Abebe Bekele",
  "cv_url": "https://cdn.example.com/cv.pdf"
}
```

Role-specific required fields:
| role     | required fields |
|----------|------------------|
| seeker   | `full_name` |
| employer | `company_name` |
| agency   | `agency_name` |

Response `201`:
```json
{
  "status": "success",
  "data": {
    "user": { "id": "...", "phone": "...", "email": "...", "role": "seeker", "createdAt": "..." },
    "profile": { "id": "...", "userId": "...", "full_name": "...", "...": "..." },
    "token": "<jwt>"
  }
}
```

### `POST /api/v1/auth/login`

Accepts either `phone` or `email`, plus `password`.

```json
{ "phone": "+251911223344", "password": "a-strong-password" }
```

Response `200`:
```json
{
  "status": "success",
  "data": {
    "user": { "id": "...", "phone": "...", "email": "...", "role": "seeker", "createdAt": "..." },
    "token": "<jwt>"
  }
}
```

## Protecting routes in other modules

```js
const { authenticate } = require('./middleware/auth.middleware');
const { authorizeRoles } = require('./middleware/rbac.middleware');

router.post('/jobs', authenticate, authorizeRoles('employer', 'agency'), createJobHandler);
```

- `authenticate` verifies the `Authorization: Bearer <jwt>` header and attaches `req.user = { id, phone, role }`.
- `authorizeRoles(...roles)` must run after `authenticate` and returns `403` if `req.user.role` isn't in the allowed list.

See `src/routes/example-protected.routes.js` for a working example (`/api/v1/me`, `/api/v1/jobs`, `/api/v1/admin/dashboard`).

## Job Seeker Profile module

Adds seeker-only profile management and file uploads on top of the auth
module. All routes require `authenticate` + `authorizeRoles('seeker')`.

### `GET /api/v1/seekers/me`
Returns the logged-in seeker's full profile row.

### `PATCH /api/v1/seekers/me`
Partial update — send any of `full_name`, `bio`. At least one required.

### `PATCH /api/v1/seekers/me/availability`
```json
{ "availability_status": false }
```

### `POST /api/v1/seekers/upload`
`multipart/form-data` with one or both fields:
- `cv` — PDF or DOCX, max `MAX_UPLOAD_SIZE_MB` (default 5MB)
- `photo` — JPEG, PNG, or WEBP, max `MAX_UPLOAD_SIZE_MB`

Files are validated by extension, reported MIME type, **and** binary
signature (to catch spoofed content-types), then streamed to S3 under
`seekers/<userId>/<cv|photo>/<random>-<sanitized-name>.<ext>`. The
resulting URL(s) are saved to the `Seeker` document's `cvUrl` / `photoUrl` fields.

Requires `AWS_REGION`, `AWS_S3_BUCKET`, `AWS_ACCESS_KEY_ID`,
`AWS_SECRET_ACCESS_KEY` (see `.env.example`). For S3-compatible providers
(MinIO, Spaces, R2), also set `AWS_S3_ENDPOINT` and
`AWS_S3_FORCE_PATH_STYLE=true`.

`bio`, `availabilityStatus`, and Mongoose's built-in `updatedAt` timestamp
are already part of the `Seeker` schema (`src/models/Seeker.model.js`) — no
separate migration step needed.

## Security notes

- Passwords hashed with `bcrypt` (cost factor configurable via `BCRYPT_SALT_ROUNDS`, default 12).
- JWTs are signed with `JWT_SECRET` and include `sub` (user id), `phone`, `role`, plus standard `iat`/`exp`/`iss` claims.
- `/api/v1/auth/*` is rate-limited (20 req / 15 min / IP by default) to slow down brute-force and registration spam.
- MongoDB duplicate-key errors (duplicate phone/email) are translated into a clean `409 Conflict` rather than leaking a raw DB error.
- `helmet` and `cors` are applied globally; tighten the CORS policy for production.
