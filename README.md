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
