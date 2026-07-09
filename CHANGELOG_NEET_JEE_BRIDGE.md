# NEET + JEE Bridge Course Extension — Change Log

This update extends the existing CTK Bridge Course platform to fully support
**both NEET and JEE** through the already-centralized question bank
(`Course → Subject → Chapter → Question → Difficulty`), without altering the
existing project structure, tables, or endpoints that were already working.
Everything below is **additive** — no table was dropped, no endpoint was
removed, and no existing frontend page was rewritten.

Tested end-to-end against a local PostgreSQL instance (register → OTP →
login → onboarding → chapter CRUD → question submit/edit/delete → daily/
mock/chapter-combo test generation → question-exposure tracking). Your real
`.env` / production database was never touched.

## 1. Question bank depth (dummy content)

- `seedQuestionBank()` in `backend/db.js` now **tops every chapter up to
  ~100 approved dummy MCQs** (previously 5), spread evenly across
  Easy/Moderate/Difficult so every difficulty filter has enough supply.
- It's idempotent and additive: it only inserts what's missing per chapter,
  so it safely tops up a database that was already seeded with fewer
  questions — you don't need to wipe your existing data to pick this up.

## 2. Faculty CRUD — questions (completed)

- Added `DELETE /api/qbank/questions/:id`. Faculty can delete their own
  not-yet-approved submissions; only an admin can delete an already-approved
  question. (Add/edit/approve/reject already existed and are unchanged.)
- Question Bank page (faculty/admin view) now shows **Edit** / **Delete**
  buttons on each result in the browser, wired to the existing PUT endpoint
  and the new DELETE endpoint.

## 3. Faculty CRUD — chapters, course-aware (new)

- New endpoints, scoped by `courseType` + `subject` so NEET and JEE chapters
  never collide even when they share a subject name (Physics, Chemistry):
  - `GET /api/qbank/chapters?courseType=&subject=`
  - `POST /api/qbank/chapters` (create)
  - `PUT /api/qbank/chapters/:id` (rename/describe — also re-tags any
    questions filed under the old chapter name so nothing is orphaned)
  - `DELETE /api/qbank/chapters/:id` (removing a chapter never deletes its
    questions — they stay in the bank)
- New **"🗂️ Manage Chapters"** card on the Question Bank page (faculty
  only): pick Course → Subject, then add/rename/delete chapters. This is
  how a JEE Mathematics chapter can be added or retired (Mathematics stays
  a fully removable subject/chapter, per the requirement) without touching
  NEET content.
- This is distinct from (and doesn't change) the pre-existing
  `/api/faculty/chapters` system, which manages chapters for materials/
  lecture links and isn't course-scoped — that keeps working exactly as
  before.

## 4. Test generation — repetition avoidance (enhanced)

- `fillTestQuestions()` and the chapter-combo generator now accept an
  optional student email. When present, question selection **prefers
  questions that student hasn't been served yet** (via the existing
  `question_exposure` table), and only falls back to the least-used
  questions overall if the unseen pool can't cover the full quota.
- Wired into the per-request test types where this matters most — **Mock
  Test**, **Grand Test**, and **Chapter-Combo Test** — since each of those
  generates a fresh test per request. (Daily/Weekly/Monthly tests are
  intentionally one shared instance per course/period across all students,
  so they keep using pool-wide `usage_count` balancing as before.)
- Verified with a real run: two consecutive Mock Tests for the same student
  came back with **0 question overlap** out of 90+90.

## 5. Bug fix — question-exposure logging no longer 500s pre-onboarding

- `GET /api/bridge/tests/:id/questions` previously threw a hard 500 for any
  student who opened a test before finishing onboarding (their
  `question_exposure` insert failed a foreign-key check against `students`,
  which only gets a row after onboarding). Exposure logging is bookkeeping,
  not something that should block a student from seeing their test — it's
  now best-effort and non-fatal.

## Already in place (verified, not changed)

Some of the requested capabilities were already implemented correctly, and
this update deliberately left them alone:

- Centralized `question_bank` + `chapters` tables keyed by
  `course_type / subject / chapter_name / difficulty` — single source of
  truth for all test types, no duplicate repositories.
- NEET → Physics, Chemistry, Botany, Zoology; JEE → Physics, Chemistry,
  Mathematics (`CURRICULUM` in `backend/db.js`).
- Course choice (NEET/JEE) during account setup (`obTargetExam` in the
  onboarding step right after registration/verification).
- Faculty question submission + approval/rejection workflow.
- Difficulty tagging (Easy/Moderate/Difficult) on every question, with
  students choosing a difficulty mode when generating Mock Tests.
- 90-question test generation with balanced subject distribution
  (`TEST_SUBJECT_DIST`) for daily, weekly, monthly, grand, mock, and
  chapter-combo tests, all drawn exclusively from the centralized bank.
