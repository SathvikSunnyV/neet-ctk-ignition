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

