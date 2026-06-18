# Faculty Module Enhancement — Change Log

This update implements the five Faculty Module requirements (chapter-wise
materials & lecture links, OCR test upload, individual student analytics,
Error Atlas, and chapter management) on top of the existing NEET CTK
IGNITION codebase, **without removing or rewriting any existing
functionality**. Every endpoint, table, and frontend feature that existed
before this change still works exactly as it did.

Everything below was tested against a local PostgreSQL instance (registration
→ OTP → login → chapter CRUD → material/lecture/test CRUD → test
attempt/grading → student analytics → Error Atlas → OCR extraction from a
real PDF), plus a jsdom-based test pass exercising the new frontend logic
directly. **Nothing was run against your production database** — your real
`.env` (Render Postgres credentials, JWT secret, Brevo/HF keys) is untouched
and was verified byte-for-byte identical to the original after testing.

## 1. Chapter Management System (new)

- New `chapters` table (`subject`, `name`, `description`, `position`,
  `created_by`). Auto-seeded with the 13 existing Physics topics so your
  current content is immediately chapter-organised with no manual work.
- New endpoints: `GET /api/chapters`, `POST/PUT/DELETE
  /api/faculty/chapters`, `POST /api/faculty/chapters/reorder`.
- New "📂 Chapter management" card on the Faculty Hub page: create, rename,
  reorder (↑/↓), and delete chapters. Deleting a chapter never deletes the
  materials/tests/lectures linked to it — they're just unlinked
  (`ON DELETE SET NULL`).
- `materials`, `tests`, and `lectures` each gained a `chapter_id` column
  (nullable FK). The old free-text `chapter` column is kept and
  auto-synced for backward compatibility with anything still reading it
  directly.

## 2. Faculty Materials & Lecture Links — chapter-wise (enhanced)

- Material upload/link forms now use a **chapter dropdown** instead of
  free text, plus a new optional **Topic** field (separate, finer-grained
  than chapter).
- New `PUT /api/faculty/materials/:id` lets faculty **edit** an existing
  material's title/chapter/topic/description/term (and URL, for links)
  without deleting and re-uploading. An "Edit" button was added to "My
  uploaded materials".
- New chapter-wise faculty lecture link CRUD
  (`POST/GET/PUT/DELETE /api/faculty/lectures`), published instantly —
  separate from, and fully compatible with, the original anonymous
  "submit for admin approval" Lecturer Hub flow which is untouched.

## 3. Test Upload with OCR Support (new)

- New `backend/ocr.js`: extracts raw text from an uploaded PDF
  (`pdf-parse`) or image (`tesseract.js`, pure-JS OCR — no native system
  dependencies), then structures it into `{questionText, options,
  correctAnswerIndex}` using the same free Hugging Face inference API
  already used elsewhere in this project (falls back to a deterministic
  regex-based parser — tested against multiple-choice layouts with both
  inline "Answer: B" lines and trailing "Answer Key: 1-A, 2-C" blocks — if
  no `HF_TOKEN` is configured or the AI call fails).
- New `POST /api/faculty/tests/ocr-extract`: takes the upload, returns a
  **preview only** — nothing is saved to the database.
- New "OCR upload" section on the test form: faculty uploads a file, sees
  an editable preview (questions flagged "needs review" when the correct
  answer couldn't be determined), corrects anything OCR got wrong, then
  clicks "Add to test form" to merge them into the same manual-entry form
  used for hand-typed questions — both paths go through identical
  validation before saving.
- **Known limitation (by design, documented rather than silently
  failing):** scanned PDFs with no embedded text layer are rejected with a
  clear message asking for an image upload instead, since rasterising PDF
  pages for OCR would require native system libraries (poppler/ghostscript)
  that aren't reliably available across every free hosting tier.
- Manual test creation/editing also enhanced: faculty can now **edit an
  existing scheduled test** in place (`PUT /api/faculty/tests/:id`,
  `GET /api/faculty/tests/:id` for fetching with answers), not just create
  new ones. Test creation/editing also gained the chapter dropdown.

## 4. Individual Student Analytics (new)

- `GET /api/faculty/students` — students who've engaged with this
  faculty member's tests/materials/lectures (keeps the picker relevant
  rather than dumping the entire roster).
- `GET /api/faculty/students/:email/analytics` — tests attempted, average
  score/accuracy, **chapter-wise performance** (re-graded from each
  attempt's stored answers against the question bank, not just the
  mistake log, so it reflects both correct and incorrect answers),
  strong/weak chapters, materials completed, lectures watched, and a
  unified recent-activity feed across tests/materials/lectures.
- New "🧑‍🎓 Individual student analytics" card with a student picker.

## 5. Error Atlas — Hotspot Analysis (new)

- `GET /api/faculty/error-atlas` — chapter-wise breakdown of the specific
  questions with the highest error rate (mistakes ÷ attempts on that
  test) across all of a faculty member's tests, plus the most frequently
  misunderstood concepts/topics per chapter.
- New "🗺️ Error Atlas" card with expandable chapter sections and
  colour-coded hotspot badges (red ≥60% error rate, amber ≥30%).
- The pre-existing simpler `/api/error-atlas/:email` (per-student
  subject-gap analysis) is untouched — this is an additive, more granular
  companion view for faculty, not a replacement.

## Bug fixes discovered while testing (small, unrelated to the above)

- **`auth.js` — OTP/email fallback never actually worked.** The code and
  README both claimed that without a configured `BREVO_API_KEY`, OTP
  emails would be logged to the console instead of failing — but the
  function unconditionally called the Brevo API regardless, so
  registration/login/password-reset would throw a 500 in any environment
  without real Brevo credentials. Fixed to match the documented behaviour
  (console-log fallback). This doesn't change any behaviour when
  `BREVO_API_KEY` *is* configured, as it is in your `.env`.
- A PostgreSQL `GROUP BY` query in the new Error Atlas endpoint initially
  grouped by an output alias inside a `COALESCE(...)` expression, which
  Postgres rejected; fixed to group by the underlying columns directly.
- A frontend bug in the new "load extracted/edited question into the test
  form" logic double-incremented an internal row counter, which would
  have caused the wrong row to be populated when editing a test or adding
  OCR-extracted questions (caught and fixed via a jsdom-based DOM test,
  not just code review).

## Files changed

- `backend/db.js` — chapters table, migrations, seeding/backfill.
- `backend/server.js` — all new routes listed above; materials/tests/
  lectures endpoints extended for chapter linkage; faculty analytics
  extended.
- `backend/ocr.js` — **new file**, OCR extraction pipeline.
- `backend/auth.js` — email fallback bug fix (see above).
- `backend/package.json` / `package-lock.json` — added `tesseract.js`,
  `pdf-parse`.
- `frontend/index.html` — new Chapter Management, Error Atlas, Individual
  Student Analytics, and Faculty Lecture Links cards; OCR upload section
  and edit-mode banners added to the Test/Materials cards; chapter/topic
  fields replace free-text chapter inputs.
- `frontend/app.js` — corresponding logic for everything above.

## Not changed

Student-facing pages, the Physics Student Module, authentication flows
(beyond the email-fallback fix), the admin console, the existing
analytics/recommendation engine, and the database connection your `.env`
points to.
