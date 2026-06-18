# NEET CTK IGNITION — PostgreSQL Edition

Migrated from SQLite (`better-sqlite3`) to PostgreSQL (`pg`), ready to deploy
on **Render** or **Railway** with zero manual database setup.

---

## What changed from the original

| Area | Before | After |
|---|---|---|
| Database driver | `better-sqlite3` (sync, file-based) | `pg` (async, PostgreSQL) |
| Node requirement | ≥22.5 (used built-in `node:sqlite`) | ≥18.0 |
| All DB queries | Synchronous | Async/await |
| Schema init | Inline sync exec at module load | `initSchema()` called before `app.listen` |
| `data.sqlite` file | Required in repo | Removed — DB lives on the platform |
| `$N` placeholders | `?` (SQLite) | `$1, $2, …` (PostgreSQL) |
| Upserts | `INSERT OR REPLACE` / `INSERT OR IGNORE` | `ON CONFLICT … DO UPDATE` |
| Hardcoded `profLectures` (frontend) | 3 Rick-roll embeds in `app.js` | Fetched live from `/api/approved-lectures` |
| Quiz questions | 6 questions | 12 questions (4 per subject) |
| Seed lectures | Rick-roll placeholder URLs | Real YouTube embed URLs |

Nothing in the frontend HTML or CSS was changed.

---

## Deploy on Render (recommended for free tier)

1. Push this repo to GitHub.
2. Go to [render.com](https://render.com) → **New** → **Blueprint**.
3. Point it at your repo — Render will read `render.yaml` and create:
   - A **Web Service** running `backend/server.js`
   - A **PostgreSQL** database
4. `DATABASE_URL` is injected automatically. Deploy.

### Manual setup (without Blueprint)

1. Create a **PostgreSQL** database on Render → copy the *Internal Connection String*.
2. Create a **Web Service**:
   - Root dir: `backend`
   - Build: `npm install`
   - Start: `npm start`
   - Env var: `DATABASE_URL` = (paste connection string)

---

## Deploy on Railway

1. Push this repo to GitHub.
2. New project → **Deploy from GitHub repo**.
3. Add a **PostgreSQL** plugin → Railway injects `DATABASE_URL` automatically.
4. `railway.toml` handles build + start commands.

---

## Local development

```bash
# Requires a local PostgreSQL instance
createdb neetctk

cd backend
DATABASE_URL=postgresql://localhost/neetctk npm run dev
```

---

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `DATABASE_URL` | ✅ | Full PostgreSQL connection string |
| `PORT` | optional | HTTP port (default 4000) |
| `JWT_SECRET` | recommended | Secret used to sign login sessions. Set a long random string in production. |
| `JWT_EXPIRES_IN` | optional | Session lifetime (default `7d`) |
| `DEFAULT_ADMIN_EMAIL` / `DEFAULT_ADMIN_PASSWORD` | optional | Credentials for the auto-seeded first Admin account (default `admin@neetctk.com` / `ctk-admin-2026`). Change these in production. |
| `ADMIN_SIGNUP_CODE` | optional | Invite code required to self-register as Admin (default `ctk-admin-invite`) |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` / `SMTP_FROM` | optional | Real email delivery for OTPs. If unset, OTPs are printed to the server console (dev mode). |
| `HF_TOKEN` | optional | Free Hugging Face Inference API token, used to generate AI study recommendations in the Mistake Analysis Engine. Get one free at https://huggingface.co/settings/tokens. If unset, a rule-based recommender (driven by the student's real mistake data) is used instead. |
| `HF_MODEL` | optional | Hugging Face model id (default `mistralai/Mistral-7B-Instruct-v0.3`) |

See `.env.example` for a ready-to-copy template.

---

## v2.1 — Authentication, Onboarding, Cutoff AI & Test Management

This release is **additive only** — no existing routes, tables, or pages were removed.

### New: Authentication system
- Register (Student / Faculty / Admin) with full name, email, password, confirm password.
- Email OTP verification (6-digit, 10-minute expiry) before login is allowed.
- Login with email + password, JWT session tokens (`Authorization: Bearer <token>`).
- Forgot password → OTP → reset password flow.
- Passwords hashed with bcrypt; simple DB-backed rate limiting on login/OTP/reset.
- A default Admin account is seeded automatically on first run (see env vars above).

### New: Student onboarding
- After first login, students answer: target exam (NEET/JEE), target institution
  (AIIMS / Government / Private Medical College), reservation category, state,
  current class, expected exam date, daily study hours, and preparation level.
- This data extends the existing `students` table (new columns added via
  `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`, so existing rows are untouched).

### New: AI-based cutoff & rank prediction
- `db.js` ships a small **historical NEET cutoff dataset (2021–2024)** by
  category and institution tier, plus state-quota adjustment factors.
- A linear-regression model is trained on this data at request time and
  extrapolated to the student's target exam year — **no hardcoded
  per-student cutoffs**.
- Returns Safe / Target / Stretch scores, an estimated rank band, and (when
  the student has attempt history) an admission probability.
- Endpoint: `GET /api/cutoff-prediction/:email` (auth required). Shown on
  the Guidance dashboard.

### New: Test Management System (Faculty)
- Faculty can create tests (MCQ or fill-in-the-blank), with subject,
  chapter, difficulty, time limit, negative marking, randomization, and
  optional scheduled release time.
- Students see published tests on the Practice page, attempt them, and get
  instant auto-grading.

### New: Mistake Analysis Engine
- Every incorrect/unattempted answer is logged with subject, topic, and
  mistake type (conceptual / memory / unattempted).
- `GET /api/student/mistake-analysis` returns a per-topic breakdown plus
  recommendations. Recommendations use a **free Hugging Face model** (if
  `HF_TOKEN` is set) to phrase tips from the student's real mistake data, or
  fall back to a deterministic rule-based recommender — never hardcoded
  per-student text.

### New: Lecturer Analytics Dashboard
- `GET /api/faculty/analytics` surfaces weak topics across a faculty
  member's tests ("N students are weak in X"), per-test averages, and
  recent student attempts.

### Database
- New tables: `users`, `auth_attempts`, `faculty`, `tests`,
  `test_questions`, `test_attempts`, `mistakes`.
- `students` table gains: `target_institution`, `state`, `current_class`,
  `daily_study_hours`, `prep_level`, `target_exam`.
- All changes are idempotent (`CREATE TABLE IF NOT EXISTS` /
  `ADD COLUMN IF NOT EXISTS`) — safe to run against the existing database.

---

## v2.2 — Live (real, non-static) cutoff data & faculty study materials

This release is also **additive only**.

### Upgraded: cutoff prediction now uses REAL, refreshable web data
Previously the regression trained only on a fixed table baked into the
code. It now works like this:

1. **`backend/research.js`** runs a free web search (DuckDuckGo, no API
   key) for the upcoming NEET exam year's cutoff trends, then sends the
   search snippets to the same free Hugging Face model already used for
   mistake recommendations, asking it to extract a structured
   `{category, aiims, govt, private}` JSON array.
2. Extracted numbers are sanity-checked (must be 100–720, and AIIMS-tier ≥
   Govt-tier ≥ Private-tier) before being trusted.
3. Validated results are cached in a new `cutoff_cache` table with a
   timestamp, **replacing** the static numbers for that year/category.
4. `predictCutoff()` always reads from this cache first; the original
   static 2021–2024 table is now only a *fallback* used to fill gaps when
   live data hasn't been fetched yet (e.g. immediately after first
   deploy, or if outbound web/AI access is unavailable in some
   environment).
5. The cache auto-refreshes in the background (on server start, then
   every 24h, but it only does real work when data is missing or >30 days
   old). Admins can also force an immediate refresh.
6. The Guidance page now shows a **"🌐 Live web data" / "📊 Baseline
   estimate"** badge so it's transparent which source produced a given
   student's numbers.

New endpoints:
- `GET /api/admin/cutoff-cache` — view what's currently cached (admin JWT required)
- `POST /api/admin/cutoff-cache/refresh` — force a fresh web search + AI extraction for a given year (admin JWT required)

Note: this needs `HF_TOKEN` set (already configured in this project's
`.env`) for the AI-extraction step, and outbound internet access to
`html.duckduckgo.com` from wherever the backend is hosted. If either is
unavailable, the system safely falls back to the static baseline rather
than failing.

### New: Faculty study materials (files + links)
- Faculty can upload **PDF, PPT/PPTX, DOC/DOCX, or images** (20 MB cap) or
  share a link (e.g. YouTube), tagged by subject/chapter, with an optional
  description.
- Files are stored as `bytea` directly in PostgreSQL (not the local
  filesystem), so they aren't lost on redeploys on free hosting tiers with
  an ephemeral disk.
- Published immediately — visible to every student on the Practice page,
  downloadable via `GET /api/materials/:id/download`.
- Faculty can see and remove their own uploads from the Lecturer Hub.

New table: `materials`. New endpoints: `POST /api/faculty/materials/upload`,
`POST /api/faculty/materials/link`, `GET /api/faculty/materials`,
`DELETE /api/faculty/materials/:id`, `GET /api/materials`,
`GET /api/materials/:id/download`.

New dependency: `multer` (multipart form handling).


## v2.3 — Physics Student Module

This release is also **additive only** — every Biology/Chemistry/general-Physics
flow from v2.1/v2.2 keeps working exactly as before. It layers a dedicated,
Physics-curated student experience on top of the existing platform, per the
Physics Student Module requirements spec: entry-level diagnostics, Term-organised
materials, lecture/material progress tracking, topic-wise analytics, and
personalised recommendations — plus an optional per-student test assignment
mechanism for the existing Test Management System.

### New: Physics Entry-Level Assessments
- 3 fixed diagnostics — **Test 1 is mandatory**, Tests 2 & 3 are optional —
  each seeded with 10 dummy MCQs (per the spec's "for development purposes"
  note) spanning the 13 canonical Physics topics (Units & Dimensions through
  Modern Physics).
- Submitting a test grades it, computes a topic-wise breakdown, and classifies
  the student as **Beginner / Intermediate / Advanced** (≥75% Advanced, ≥45%
  Intermediate, else Beginner — tune via `classifyPhysicsProficiency()` in
  `db.js` if your faculty want different thresholds).
- Every incorrect/unattempted entry-test answer is also logged into the
  existing `mistakes` table, so it automatically shows up in the student's
  general Mistake Analysis view and the faculty Lecturer Analytics Dashboard
  too — no separate reporting pipeline needed.

### New: Term-organised Physics materials (the three-stage learning model)
- Every Physics topic is organised into **Term 1 (Conceptual Understanding)**,
  **Term 2 (Definitions & Formulae)**, and **Term 3 (Advanced Applications)**,
  matching the spec's three-stage model.
- Seeded with starter content (a short, accurate explanation/derivation set
  per topic/term) so the structure works end-to-end immediately; faculty can
  add further file/link materials per topic/term from the existing Lecturer
  Hub upload form, which now has an optional **Term** dropdown (only shown
  for the Physics subject).
- The pre-existing `materials` table gained a nullable `term` column and a
  `'note'` `material_type` (for the seeded text content) — fully backward
  compatible; Biology/Chemistry materials are unaffected (`term` stays NULL).

### New: Granular progress tracking
- **Lectures:** percentage watched + resume position, tracked per student per
  lecture (new `lecture_progress` table). The Physics page's lecture cards
  include a simple slider + "Save" control; a lecture auto-marks complete at
  ≥95% watched.
- **Materials:** viewed / downloaded / completed flags per student per
  material (new `material_progress` table). Downloading a file via the
  existing `GET /api/materials/:id/download` endpoint now also marks it
  viewed+downloaded automatically.

### New: Topic-wise Physics analytics & personalised recommendations
- Strength/weakness classification (≥70% accuracy with ≥2 attempts = strong,
  <50% = weak) computed from the student's own entry-test history, plus a
  separate mistake-frequency breakdown pulled from the shared `mistakes`
  table.
- Recommendations follow the spec's exact format — *"Your accuracy in X is
  Y%. Recommended: review Term 1 materials, revise the Term 2 formula sheet,
  watch the related lecture, attempt a fresh practice test."*

### New: Physics Student Dashboard
A single summary view (current proficiency level, lectures/materials
completed vs. total, tests attempted, average score, strong/weak topics) —
exactly the shape described in the spec — available via
`GET /api/physics/dashboard` and rendered on the new **Physics** tab.

### New: optional per-student/group test assignment
- Faculty creating a test (existing "Schedule a test" form) can now optionally
  list specific student emails to assign it to. **Leave it blank and nothing
  changes** — the test stays visible to every student, identical to prior
  behaviour. New table: `test_assignments` (a test with zero assignment rows
  is treated as "open to everyone").
- New endpoint `POST /api/faculty/tests/:id/assign` to assign an existing test
  after the fact.
- New endpoint `GET /api/student/tests/history` — full test history with an
  improvement trend and a same-tests cohort-average comparison (Section 4.4
  of the spec).

### Bug fix (pre-existing, found while building this)
`GET /api/student/:email` (fetch a student's own profile) was registered
*before* `GET /api/student/tests` and `GET /api/student/mistake-analysis` in
`server.js`. Since Express matches routes in registration order and both of
those are single-segment paths, the generic `:email` route was silently
shadowing them — meaning the existing "view assigned/scheduled tests" and
"my mistake analysis" endpoints were unreachable. Fixed by moving the
`:email` profile route to register after all of the more specific
`/api/student/...` routes. No request/response shape changed — only the
route registration order.

New tables: `physics_entry_tests`, `physics_entry_questions`,
`physics_entry_attempts`, `lecture_progress`, `material_progress`,
`test_assignments`. New columns: `students.physics_proficiency`,
`materials.term`. New endpoints (all under `/api/physics/...`):
`GET /entry-tests`, `GET /entry-tests/:testNumber`,
`POST /entry-tests/:testNumber/submit`, `GET /proficiency`,
`GET /materials`, `POST /materials/:id/view`, `POST /materials/:id/complete`,
`GET /lectures`, `POST /lectures/:id/progress`, `GET /analytics`,
`GET /recommendations`, `GET /dashboard`. No new dependencies.

