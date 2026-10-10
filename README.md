# Inspection AI 5.0 — multi-tenant SaaS

AI visual inspections for any industry. Inspectors photograph or live-scan equipment, the AI checks every point of the
checklist (and double-checks every OK), and the result is **Green / Yellow / Red**. Sold to many client companies from
one installation, each with its own users, data, branding and AI keys.

| URL | Who |
|---|---|
| `/` | **Field app** (phone, installable PWA) for inspectors, managers, admins |
| `/console` | **Console**: your platform team + each client's admins / managers / auditors. Also the **Admin tab inside the app** |
| `/report?id=…` | Printable, branded PDF report of a saved inspection |

## Quick start (your laptop, no database, no AI key)
```bash
npm install
AI_MOCK=1 SUPERADMIN_EMAIL=you@test.com SUPERADMIN_PASSWORD=Test12345 npm start
```
Open http://localhost:3000/console, sign in, click **Create demo client**. `AI_MOCK=1` gives fake AI answers so you can
demo everything; never use it for real customers. Run the API test: `node tests/smoke.mjs http://localhost:3000`.

## One app for everyone
Install the app once (Settings › Download the app). Inspectors see Home, Inspect, History, Settings.
Admins, managers, auditors and your platform team also get an **Admin** tab that opens the full Console inside the
same app window: every option of the desktop, laid out for phones (bottom bar, tables as cards, full-screen forms).
The Console's bottom bar has an **Inspect** button to jump back to inspecting.

## Who can do what
**Your team (platform)**
- **Super admin**: clients, plans, limits, industries and template library, platform AI keys, team, audit, delete clients.
- **Support**: open any client account read-only to help them; see usage.

**Inside each client company**
- **Admin**: users and roles, sites, AI keys, branding, workflow, webhooks, audit log, plus everything below.
- **Manager**: approves / rejects inspections, manages inspection types, assets, schedules, corrective actions.
- **Inspector**: runs inspections, closes the actions assigned to them. Sees only their own inspections (setting).
- **Viewer / auditor**: read-only inspections, actions and reports.
Users can be limited to certain sites.

## Adding inspection types and industries
| What | Who | Where |
|---|---|---|
| New **industry** (e.g. Solar, Pharma, Mining) | You (super admin) | Console › Industries and library › New industry |
| New **library template** in any industry | You | Console › Industries and library › New library template |
| Turn a client's good template into a library template | You | Same page › "Templates suggested by clients" › Add to library |
| Client's **own inspection type** | Client admin / manager | Console › Inspection types › Create new (or ✨ Suggest with AI), or phone: Settings › Create inspection type |
| Copy templates from the library | Client | Console › Template library › tick › Add selected |
| Move a template between companies | Client | Inspection type › Export JSON → other account › Import JSON |
| Suggest a template for the shared library | Client | Inspection type › Suggest for library |

A client can also type **any industry / category** on their own templates, so they are never blocked waiting for you.
When you create a client and tick industries, all active templates of those industries are copied into their account.
Built-in: 11 industries, 30 templates (construction, fire safety, electrical, manufacturing incl. spare-part kit check,
automotive, warehousing, facilities, oil & gas, IT, healthcare, hospitality / food / retail).

Each inspection type has: views (photo angles) with checks, critical checks (`!`), "must be true" rules (`::`),
checks for any view, **custom fields** (text, number, date, choice, yes/no; optional required), **AI instructions**
(domain knowledge, standards), **reference photos** ("what good looks like"), recurrence in days, safety wording.

## AI: bring your own key
Console › AI models: add **Google Gemini, OpenAI, Anthropic Claude** or **Azure OpenAI** keys, test them, choose the
default. Keys are encrypted (AES-256-GCM) and only a hint like `AIza…7890` is ever shown again.
- **Second check by another provider** (e.g. Gemini checks, Claude double-checks) catches more AI mistakes.
- Minimum confidence, double-check on/off, language of AI notes (Hindi, Marathi, …).
- Order used: client's chosen key › client's default key › your platform keys (only if the plan includes platform AI)
  › env keys (`AZURE_OPENAI_*`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`) › demo AI (if `AI_MOCK=1`).
- Every AI call is metered per client (calls, tokens, provider) and limited by plan.
- Model names are editable; the suggestions in the form are only defaults. Check each provider's current model list.

## Features
- Photo-by-photo and live scan (your v4 engine), strict rules, majority voting, skeptical second check
- Saved to the company account with photos; history, search, filters, CSV export (one row per check)
- **Asset register**: auto-created on first inspection, CSV import, last result, next due date, **QR labels**
  (scan with the phone camera: opens `/?asset=CODE` and starts that asset's inspection)
- **Schedules** (daily / weekly / monthly…) and a **due / overdue** list on the inspector's home screen
- **Corrective actions** created automatically from failed checks, assigned with due dates, closed on the phone
  with note + photo, verified by managers
- **Manager review**: approve / reject with comment (optional workflow)
- **Dashboard**: pass rate, trend, by type / site / inspector, most failed checks, overdue items
- **Branding** per client: logo, colour, app name, report footer
- **Webhooks** (inspection.created, inspection.reviewed, action.created) signed with HMAC-SHA256
- **Plans and limits**: users, sites, inspections / month, AI calls / month, platform AI; per-client overrides; trials
- **Audit log** for every change (client and platform); support access is logged
- Security: scrypt passwords, signed sessions that are revoked on password change / role change / suspension,
  forced password change on first sign-in, login rate limiting, strict tenant isolation on every query

## Deploy (Render + free PostgreSQL)
1. Create a PostgreSQL database (Neon or Supabase free tier, or Render Postgres). Copy its connection string.
2. Push this folder to GitHub. On Render: New › Blueprint (uses `render.yaml`) or New › Web Service
   (build `npm install`, start `npm start`, Node 22).
3. Environment variables: `DATABASE_URL`, `SESSION_SECRET`, `ENCRYPTION_KEY` (random, **never change it later**:
   stored customer keys could no longer be read), `SUPERADMIN_EMAIL`, `SUPERADMIN_PASSWORD`, `NODE_ENV=production`.
4. Open `/api/health` → `"ok": true, "version": "5.0.0"`. Sign in at `/console`.
Render's free web plan sleeps after inactivity; use a paid instance for paying clients.
Also included: `Dockerfile` (any VPS / Railway / Fly) and `vercel.json` (Vercel needs `DATABASE_URL`; its request size
limit of about 4.5 MB means fewer / smaller photos per inspection).

Without `DATABASE_URL` the app uses a local SQLite file (`./data`) — fine for testing, **not** for customers.

## Project structure
```
server.js                  start the server
api/index.js               Vercel entry
src/app.js                 routing, auth, static files
src/db/                    PostgreSQL / SQLite layer, schema migrations
src/security.js            passwords, sessions, key encryption, rate limits
src/rbac.js                roles and permissions
src/auth.js                who is calling, tenant context, audit log
src/ai/providers.js        Gemini, OpenAI, Anthropic, Azure adapters (structured JSON)
src/ai/resolve.js          which key each client uses, quotas, metering
src/ai/mock.js             demo AI
src/inspection/            inspection engine (evaluate, live, verify, suggest) and check rules
src/library.js             built-in industries and templates (loaded into the DB on first start)
src/library-db.js          editable library in the database
src/routes/                API: auth, platform, tenant admin, templates, assets, inspections, AI
public/                    field app (index.html, app.js, live.js), console, report
tests/smoke.mjs            end-to-end API test (run against a server started with AI_MOCK=1)
```

## Good next steps
- Store photos in S3 / Cloudflare R2 instead of the database once volume grows
- Email / WhatsApp alerts for red results and overdue actions
- Online payments (Razorpay / Stripe) linked to plans
- SSO (Google / Microsoft) for larger clients
- Offline queue so inspections taken without signal upload later
- Native app wrapper (Capacitor) for the Play Store / App Store
