# LeadFlow CRM — Backend API

REST API for LeadFlow CRM, a multi-tenant sales CRM. Built with Express 5, MongoDB/Mongoose and Zod, and designed to run as a serverless function on Vercel.

The web app lives in [`leadflow-frontend`](https://github.com/Ishwar70/leadflow-frontend).

## Highlights

- **Multi-tenancy** — every record carries a `workspaceId` that is always derived on the server from the signed-in user's active membership, never from the client.
- **RBAC** — owner, admin, manager, sales rep and viewer roles enforced server-side. Sales reps are automatically scoped to records they own.
- **Auth** — JWT in an httpOnly cookie, bcrypt password hashing, account lockout after repeated failures, rate limiting, password reset and invitations.
- **Lead-to-revenue workflow** — duplicate detection, CSV import/export (with formula-injection protection), transactional lead conversion, pipeline stage rules (won needs an amount, lost needs a reason), stage history and a shared activity timeline.
- **Website lead capture** — `POST /api/public/leads` with hashed API keys, idempotency keys, round-robin assignment and an automatic call task due in 2 hours.
- **Reminders** — Vercel Cron calls `/api/cron/reminders` daily and creates in-app notifications for tasks that are overdue or due within 24 hours.
- **Audit log** for sensitive actions, notifications, global search and live reporting (no hard-coded metrics).

## Project structure

```
api/index.ts          Vercel serverless entry (exports the Express app)
src/app.ts            Express app: security middleware, routing
src/config/env.ts     Zod-validated environment
src/lib/              permissions, errors, http helpers, audit, email, csv, metrics
src/middleware/       auth + workspace resolution, error handling
src/models/           Mongoose schemas and indexes
src/modules/          auth, workspaces, leads, contacts, companies, deals, tasks, activities, reports, system, public
src/seed/demo.ts      Fictional demo dataset
scripts/              seed + in-memory dev server
tests/                Vitest + Supertest (in-memory MongoDB replica set)
```

## Local development

Requires Node.js 20+.

```bash
npm install

# Option A — zero setup: in-memory MongoDB seeded with demo data (data resets on exit)
npm run dev:memory

# Option B — your own database
cp .env.example .env      # fill in MONGODB_URI and JWT_SECRET
npm run seed              # optional: load demo data
npm run dev               # http://localhost:4000
```

MongoDB must be a replica set (lead conversion uses transactions). Every MongoDB Atlas cluster, including the free tier, qualifies.

## Environment variables

| Variable | Required | Description |
| --- | --- | --- |
| `MONGODB_URI` | yes | MongoDB connection string |
| `JWT_SECRET` | yes | Long random string (16+ chars) for signing sessions |
| `FRONTEND_URL` | yes | Frontend origin(s), comma separated. The first is used in emailed links |
| `CRON_SECRET` | prod | Bearer secret that Vercel Cron sends to `/api/cron/reminders` |
| `DEMO_MODE` | no | `true` enables one-click demo logins |
| `RESEND_API_KEY` | no | Enables invitation, password-reset and welcome emails |
| `EMAIL_FROM` | no | Sender address for emails |

## Testing

```bash
npm test         # 41 API + unit tests against an in-memory replica set
npm run typecheck
```

## Deploying to Vercel

1. Create a free MongoDB Atlas cluster and allow network access from `0.0.0.0/0` (Vercel uses dynamic IPs).
2. Import this repo in Vercel (framework preset: Other). `vercel.json` routes every path to the Express app and registers the daily cron.
3. Set the environment variables above (`NODE_ENV=production` is set by Vercel).
4. Seed demo data once from your machine: `MONGODB_URI=... npm run seed`.
5. After deploying the frontend, set `FRONTEND_URL` to its URL and redeploy.

## Demo accounts

All demo data is fictional. Password for every account: `Demo@12345` — `owner@`, `admin@`, `manager@`, `salesrep@`, `rep2@` and `viewer@demo.leadflow.app`.

## API overview

All responses use `{ success, data, meta? }` or `{ success: false, error: { code, message, fieldErrors? } }`.

| Area | Endpoints |
| --- | --- |
| Auth | `POST /api/auth/register · login · demo · logout · forgot-password · reset-password`, `GET /api/auth/me` |
| Workspaces | `POST /api/workspaces`, `POST /api/workspaces/:id/switch`, `GET/PATCH /api/workspaces/current` |
| Team | `GET /api/members`, `PATCH /api/members/:userId`, `POST /api/members/:userId/deactivate · reactivate`, `/api/invitations` |
| Leads | CRUD, `/bulk`, `/import/preview`, `/import`, `/export`, `/check-duplicates`, `/:id/convert`, `/:id/archive · restore` |
| Contacts / Companies | CRUD with archive/restore and related records |
| Deals | CRUD, `/board`, `/:id/stage`, `/:id/won`, `/:id/lost`, `/:id/archive`; pipelines under `/api/pipelines` |
| Tasks | CRUD, `/counts`, `/:id/complete`, `/:id/reopen` |
| Other | `/api/activities`, `/api/reports/overview`, `/api/search`, `/api/notifications`, `/api/audit-logs`, `/api/api-keys` |
| Public | `POST /api/public/leads` (header `x-api-key`, optional `Idempotency-Key`) |
