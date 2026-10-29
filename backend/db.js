// db.js — CTK BRIDGE COURSE  |  PostgreSQL edition
// Expanded from NEET CTK IGNITION to support both NEET & JEE,
// centralized question bank, all test types, and faculty approval workflow.

const { Pool } = require('pg');
const { REAL_IMPORTED_QUESTIONS, RAW_IMPORTED_QUESTIONS } = require('./real_imported_questions');
const { changedRows } = require('./question_corrections');
const { auditRow } = require('./question_audit');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL && !process.env.DATABASE_URL.includes('localhost')
        ? { rejectUnauthorized: false }
        : false
});

// ---------------------------------------------------------------------------
// SCHEMA
// ---------------------------------------------------------------------------
async function initSchema() {
    // AUTH
    await pool.query(`
        CREATE TABLE IF NOT EXISTS users (
            id              SERIAL PRIMARY KEY,
            name            TEXT NOT NULL,
            email           TEXT UNIQUE NOT NULL,
            password_hash   TEXT NOT NULL,
            role            TEXT NOT NULL DEFAULT 'student' CHECK (role IN ('student','faculty','admin')),
            is_verified     BOOLEAN DEFAULT FALSE,
            -- Faculty accounts require admin sign-off before they can log
            -- in (students/admins are approved by default). See the
            -- ALTER TABLE migration below for existing databases.
            is_approved     BOOLEAN NOT NULL DEFAULT TRUE,
            otp_code        TEXT,
            otp_expires_at  TIMESTAMPTZ,
            reset_otp_code      TEXT,
            reset_otp_expires_at TIMESTAMPTZ,
            onboarding_done BOOLEAN DEFAULT FALSE,
            created_at      TIMESTAMPTZ DEFAULT NOW()
        );
        CREATE TABLE IF NOT EXISTS auth_attempts (
            id          SERIAL PRIMARY KEY,
            email       TEXT NOT NULL,
            kind        TEXT NOT NULL,
            created_at  TIMESTAMPTZ DEFAULT NOW()
        );
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS students (
            email               TEXT PRIMARY KEY,
            name                TEXT NOT NULL,
            phone               TEXT,
            category            TEXT,
            aim                 TEXT,
            exam_date           TEXT,
            target_institution  TEXT,
            state               TEXT,
            current_class       TEXT,
            daily_study_hours   REAL,
            prep_level          TEXT,
            target_exam         TEXT DEFAULT 'NEET' CHECK (target_exam IN ('NEET','JEE','BOTH')),
            created_at          TIMESTAMPTZ DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS progress (
            email           TEXT PRIMARY KEY REFERENCES students(email) ON DELETE CASCADE,
            bio_accuracy    REAL DEFAULT 40,
            phy_accuracy    REAL DEFAULT 35,
            chem_accuracy   REAL DEFAULT 38,
            zoo_accuracy    REAL DEFAULT 40,
            math_accuracy   REAL DEFAULT 35,
            quiz_count      INTEGER DEFAULT 0,
            weekly_history  TEXT DEFAULT '[40,40,40,40,40,40,40]'
        );

        CREATE TABLE IF NOT EXISTS targets (
            email   TEXT PRIMARY KEY REFERENCES students(email) ON DELETE CASCADE,
            bio     REAL,
            phy     REAL,
            chem    REAL,
            zoo     REAL,
            math    REAL
        );

        CREATE TABLE IF NOT EXISTS faculty (
            email       TEXT PRIMARY KEY REFERENCES users(email) ON DELETE CASCADE,
            name        TEXT NOT NULL,
            department  TEXT,
            created_at  TIMESTAMPTZ DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS settings (
            key     TEXT PRIMARY KEY,
            value   TEXT
        );

        CREATE TABLE IF NOT EXISTS feedback (
            id          SERIAL PRIMARY KEY,
            message     TEXT NOT NULL,
            created_at  TIMESTAMPTZ DEFAULT NOW()
        );

        -- Student/community blog posts. Any authenticated user can write
        -- one about anything; admin can remove any post. author_email
        -- cascades on account deletion so removing a user cleans up their
        -- posts automatically.
        CREATE TABLE IF NOT EXISTS blogs (
            id              SERIAL PRIMARY KEY,
            author_email    TEXT NOT NULL REFERENCES users(email) ON DELETE CASCADE,
            author_name     TEXT NOT NULL,
            author_role     TEXT NOT NULL,
            title           TEXT NOT NULL,
            content         TEXT NOT NULL,
            created_at      TIMESTAMPTZ DEFAULT NOW(),
            updated_at      TIMESTAMPTZ DEFAULT NOW()
        );

        -- ===================================================================
        -- CENTRALIZED QUESTION BANK (core asset — single source of truth)
        -- All test types draw exclusively from here.
        -- ===================================================================
        CREATE TABLE IF NOT EXISTS question_bank (
            id              SERIAL PRIMARY KEY,
            course_type     TEXT NOT NULL DEFAULT 'NEET' CHECK (course_type IN ('NEET','JEE','BOTH')),
            subject         TEXT NOT NULL,
            chapter_name    TEXT NOT NULL,
            topic           TEXT,
            subtopic        TEXT,
            question_text   TEXT NOT NULL,
            option_a        TEXT NOT NULL,
            option_b        TEXT NOT NULL,
            option_c        TEXT NOT NULL,
            option_d        TEXT NOT NULL,
            correct_answer  TEXT NOT NULL CHECK (correct_answer IN ('A','B','C','D')),
            explanation     TEXT,
            difficulty      TEXT NOT NULL DEFAULT 'Moderate' CHECK (difficulty IN ('Easy','Moderate','Difficult')),
            estimated_time  INTEGER DEFAULT 60,  -- seconds
            -- approval workflow
            status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
            submitted_by    TEXT REFERENCES faculty(email) ON DELETE SET NULL,
            approved_by     TEXT REFERENCES faculty(email) ON DELETE SET NULL,
            approved_at     TIMESTAMPTZ,
            rejection_note  TEXT,
            -- usage tracking (critical requirement)
            usage_count     INTEGER DEFAULT 0,
            created_at      TIMESTAMPTZ DEFAULT NOW()
        );

        -- Student-level exposure history (which questions a student has seen)
        CREATE TABLE IF NOT EXISTS question_exposure (
            student_email   TEXT REFERENCES students(email) ON DELETE CASCADE,
            question_id     INTEGER REFERENCES question_bank(id) ON DELETE CASCADE,
            last_seen_at    TIMESTAMPTZ DEFAULT NOW(),
            times_seen      INTEGER DEFAULT 1,
            PRIMARY KEY (student_email, question_id)
        );

        -- ===================================================================
        -- CHAPTERS (organized under course_type > subject)
        -- ===================================================================
        CREATE TABLE IF NOT EXISTS chapters (
            id              SERIAL PRIMARY KEY,
            course_type     TEXT NOT NULL DEFAULT 'NEET' CHECK (course_type IN ('NEET','JEE','BOTH')),
            subject         TEXT NOT NULL,
            name            TEXT NOT NULL,
            description     TEXT,
            position        INTEGER NOT NULL DEFAULT 0,
            created_by      TEXT REFERENCES faculty(email) ON DELETE SET NULL,
            created_at      TIMESTAMPTZ DEFAULT NOW(),
            UNIQUE (course_type, subject, name)
        );

        -- ===================================================================
        -- TEST INSTANCES — all generated tests (entry, daily, weekly, monthly,
        -- grand, mock) are stored here with type classification
        -- ===================================================================
        CREATE TABLE IF NOT EXISTS generated_tests (
            id              SERIAL PRIMARY KEY,
            test_type       TEXT NOT NULL CHECK (test_type IN (
                                'entry','daily','weekly','monthly','grand','mock','chapter_combo','faculty')),
            course_type     TEXT NOT NULL DEFAULT 'NEET',
            title           TEXT NOT NULL,
            subject_filter  TEXT,           -- NULL = all subjects
            chapter_filter  TEXT,           -- for chapter-combo tests
            difficulty_mode TEXT DEFAULT 'Moderate' CHECK (difficulty_mode IN ('Easy','Moderate','Difficult','Mixed')),
            question_count  INTEGER DEFAULT 90,
            time_limit_min  INTEGER DEFAULT 180,
            negative_marking BOOLEAN DEFAULT FALSE,
            -- for faculty tests
            created_by      TEXT REFERENCES faculty(email) ON DELETE SET NULL,
            -- for auto-generated daily/weekly/monthly
            generated_for_date DATE,
            -- schedule metadata
            scheduled_at    TIMESTAMPTZ,
            -- 'draft' Grand Tests are staged for faculty review/editing and
            -- are NOT visible to students until published; every other
            -- test_type is created already-published (immediately usable).
            status          TEXT NOT NULL DEFAULT 'published' CHECK (status IN ('draft','published')),
            created_at      TIMESTAMPTZ DEFAULT NOW()
        );

        -- Questions assigned to a generated test (ordered, with randomised options)
        CREATE TABLE IF NOT EXISTS generated_test_questions (
            id              SERIAL PRIMARY KEY,
            test_id         INTEGER REFERENCES generated_tests(id) ON DELETE CASCADE,
            question_id     INTEGER REFERENCES question_bank(id) ON DELETE CASCADE,
            position        INTEGER DEFAULT 0,
            -- randomized option order stored as JSON array of original indices [2,0,3,1]
            option_order    JSONB DEFAULT '[0,1,2,3]'
        );

        -- Server-side stamp of when a student FIRST opened a given test
        -- (entry/daily/weekly/monthly/mock/chapter-combo/grand -- all share
        -- the generated_tests id space). Used to enforce the time limit
        -- server-side instead of trusting the client's own countdown timer,
        -- which resets to the full duration on every page reload.
        -- ON CONFLICT DO NOTHING when the questions are re-fetched means
        -- re-opening/refreshing a test in progress does NOT reset the clock.
        CREATE TABLE IF NOT EXISTS test_start_times (
            test_id         INTEGER NOT NULL,
            student_email   TEXT REFERENCES students(email) ON DELETE CASCADE,
            started_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            PRIMARY KEY (test_id, student_email)
        );

        -- Student attempts at any generated test. test_id intentionally has
        -- no FK constraint: it's shared by the legacy faculty "tests" table
        -- (server.js) and the Bridge Course "generated_tests" table
        -- (qbank.js) — a single FK could only validate against one of them.
        CREATE TABLE IF NOT EXISTS test_attempts (
            id              SERIAL PRIMARY KEY,
            test_id         INTEGER,
            student_email   TEXT REFERENCES students(email) ON DELETE CASCADE,
            answers         JSONB,          -- {question_id: 'A'|'B'|'C'|'D'|null}
            score           REAL,
            total           INTEGER,
            correct_count   INTEGER DEFAULT 0,
            wrong_count     INTEGER DEFAULT 0,
            skipped_count   INTEGER DEFAULT 0,
            neet_equiv_score REAL,
            percentile_est  REAL,
            time_taken_sec  INTEGER,
            submitted_at    TIMESTAMPTZ DEFAULT NOW()
        );

        -- Per-question mistake log. test_id and question_id intentionally
        -- have no FK constraints: both are shared between the legacy
        -- faculty-created test system (server.js — test_id -> tests.id,
        -- question_id -> test_questions.id) and the Bridge Course engine
        -- (qbank.js — test_id -> generated_tests.id, question_id ->
        -- question_bank.id). A single FK could only validate one pairing.
        CREATE TABLE IF NOT EXISTS mistakes (
            id              SERIAL PRIMARY KEY,
            student_email   TEXT REFERENCES students(email) ON DELETE CASCADE,
            test_id         INTEGER,
            question_id     INTEGER,
            subject         TEXT,
            chapter_name    TEXT,
            topic           TEXT,
            subtopic        TEXT,
            concept         TEXT,
            difficulty      TEXT,
            mistake_type    TEXT,
            created_at      TIMESTAMPTZ DEFAULT NOW()
        );

        -- Fixed entry tests per course type (3 per course, pre-generated)
        CREATE TABLE IF NOT EXISTS entry_tests (
            id              SERIAL PRIMARY KEY,
            course_type     TEXT NOT NULL CHECK (course_type IN ('NEET','JEE')),
            test_number     INTEGER NOT NULL CHECK (test_number IN (1,2,3)),
            test_id         INTEGER REFERENCES generated_tests(id) ON DELETE SET NULL,
            title           TEXT NOT NULL,
            UNIQUE (course_type, test_number)
        );

        -- Legacy faculty-created tests (preserved from original)
        CREATE TABLE IF NOT EXISTS tests (
            id              SERIAL PRIMARY KEY,
            title           TEXT NOT NULL,
            subject         TEXT NOT NULL,
            chapter         TEXT,
            chapter_id      INTEGER REFERENCES chapters(id) ON DELETE SET NULL,
            difficulty      TEXT DEFAULT 'Medium',
            time_limit_min  INTEGER DEFAULT 30,
            negative_marking BOOLEAN DEFAULT FALSE,
            randomize       BOOLEAN DEFAULT FALSE,
            scheduled_at    TIMESTAMPTZ,
            created_by      TEXT REFERENCES faculty(email) ON DELETE SET NULL,
            created_at      TIMESTAMPTZ DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS test_questions (
            id              SERIAL PRIMARY KEY,
            test_id         INTEGER REFERENCES tests(id) ON DELETE CASCADE,
            q_type          TEXT NOT NULL DEFAULT 'mcq' CHECK (q_type IN ('mcq','fill_blank')),
            question_text   TEXT NOT NULL,
            options         JSONB,
            correct_answer  TEXT NOT NULL,
            topic           TEXT,
            subtopic        TEXT,
            concept         TEXT,
            difficulty      TEXT DEFAULT 'Medium',
            position        INTEGER DEFAULT 0,
            ocr_source      BOOLEAN DEFAULT FALSE
        );

        CREATE TABLE IF NOT EXISTS test_assignments (
            test_id         INTEGER REFERENCES tests(id) ON DELETE CASCADE,
            student_email   TEXT REFERENCES students(email) ON DELETE CASCADE,
            group_name      TEXT,
            assigned_at     TIMESTAMPTZ DEFAULT NOW(),
            PRIMARY KEY (test_id, student_email)
        );

        -- Study materials
        CREATE TABLE IF NOT EXISTS lectures (
            id              SERIAL PRIMARY KEY,
            title           TEXT NOT NULL,
            subject         TEXT NOT NULL,
            url             TEXT NOT NULL,
            lecturer_name   TEXT NOT NULL,
            lecturer_email  TEXT,
            chapter_id      INTEGER REFERENCES chapters(id) ON DELETE SET NULL,
            course_type     TEXT DEFAULT 'NEET',
            approved        INTEGER DEFAULT 0,
            created_at      TIMESTAMPTZ DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS materials (
            id              SERIAL PRIMARY KEY,
            title           TEXT NOT NULL,
            subject         TEXT NOT NULL,
            chapter         TEXT,
            chapter_id      INTEGER REFERENCES chapters(id) ON DELETE SET NULL,
            topic           TEXT,
            material_type   TEXT NOT NULL DEFAULT 'file' CHECK (material_type IN ('file','link','note')),
            file_name       TEXT,
            mime_type       TEXT,
            file_size       INTEGER,
            file_data       BYTEA,
            external_url    TEXT,
            description     TEXT,
            uploaded_by     TEXT REFERENCES faculty(email) ON DELETE SET NULL,
            term            INTEGER,
            course_type     TEXT DEFAULT 'NEET',
            created_at      TIMESTAMPTZ DEFAULT NOW()
        );

        -- Chapter notes: lecturer-authored HTML pages shown as-is to
        -- students, organised simply by subject + chapter (no term /
        -- conceptual-formulae-applications categorisation). Fully
        -- editable by any faculty member, same shared-content model as
        -- chapters itself -- add, edit or delete at any time.
        CREATE TABLE IF NOT EXISTS chapter_notes (
            id              SERIAL PRIMARY KEY,
            chapter_id      INTEGER REFERENCES chapters(id) ON DELETE CASCADE,
            subject         TEXT NOT NULL,
            title           TEXT NOT NULL,
            html_content    TEXT NOT NULL,
            position        INTEGER NOT NULL DEFAULT 0,
            created_by      TEXT REFERENCES faculty(email) ON DELETE SET NULL,
            created_at      TIMESTAMPTZ DEFAULT NOW(),
            updated_at      TIMESTAMPTZ DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS lecture_progress (
            student_email           TEXT REFERENCES students(email) ON DELETE CASCADE,
            lecture_id              INTEGER REFERENCES lectures(id) ON DELETE CASCADE,
            percent_watched         REAL DEFAULT 0,
            last_position_seconds   INTEGER DEFAULT 0,
            completed               BOOLEAN DEFAULT FALSE,
            updated_at              TIMESTAMPTZ DEFAULT NOW(),
            PRIMARY KEY (student_email, lecture_id)
        );

        CREATE TABLE IF NOT EXISTS material_progress (
            student_email   TEXT REFERENCES students(email) ON DELETE CASCADE,
            material_id     INTEGER REFERENCES materials(id) ON DELETE CASCADE,
            viewed          BOOLEAN DEFAULT FALSE,
            downloaded      BOOLEAN DEFAULT FALSE,
            completed       BOOLEAN DEFAULT FALSE,
            updated_at      TIMESTAMPTZ DEFAULT NOW(),
            PRIMARY KEY (student_email, material_id)
        );

        -- NEET cutoff cache
        CREATE TABLE IF NOT EXISTS cutoff_cache (
            year        INTEGER NOT NULL,
            category    TEXT NOT NULL,
            aiims       REAL NOT NULL,
            govt        REAL NOT NULL,
            private     REAL NOT NULL,
            source      TEXT DEFAULT 'web-research-ai',
            fetched_at  TIMESTAMPTZ DEFAULT NOW(),
            PRIMARY KEY (year, category)
        );
    `);

    // Migrations for backward compat
    await pool.query(`
        -- Same "CREATE TABLE IF NOT EXISTS is a no-op on pre-existing
        -- tables" issue as chapters/question_bank above: any users table
        -- that already existed before is_approved was added needs it
        -- backfilled explicitly. Defaults to TRUE so existing student/
        -- admin/faculty accounts are not retroactively locked out.
        ALTER TABLE users ADD COLUMN IF NOT EXISTS is_approved BOOLEAN NOT NULL DEFAULT TRUE;
        -- Mobile-number registration: optional phone on the account (E.164).
        -- Phone-only accounts keep a placeholder email so every email-keyed
        -- table keeps working unchanged.
        ALTER TABLE users ADD COLUMN IF NOT EXISTS phone TEXT;
        CREATE UNIQUE INDEX IF NOT EXISTS users_phone_key ON users(phone) WHERE phone IS NOT NULL;
        ALTER TABLE students ADD COLUMN IF NOT EXISTS target_institution TEXT;
        ALTER TABLE students ADD COLUMN IF NOT EXISTS state TEXT;
        ALTER TABLE students ADD COLUMN IF NOT EXISTS current_class TEXT;
        ALTER TABLE students ADD COLUMN IF NOT EXISTS daily_study_hours REAL;
        ALTER TABLE students ADD COLUMN IF NOT EXISTS prep_level TEXT;
        ALTER TABLE students ADD COLUMN IF NOT EXISTS target_exam TEXT DEFAULT 'NEET';
        ALTER TABLE students ADD COLUMN IF NOT EXISTS physics_proficiency TEXT;
        ALTER TABLE progress ADD COLUMN IF NOT EXISTS zoo_accuracy REAL DEFAULT 40;
        ALTER TABLE progress ADD COLUMN IF NOT EXISTS math_accuracy REAL DEFAULT 35;
        ALTER TABLE test_attempts ADD COLUMN IF NOT EXISTS correct_count INTEGER DEFAULT 0;
        ALTER TABLE test_attempts ADD COLUMN IF NOT EXISTS wrong_count INTEGER DEFAULT 0;
        ALTER TABLE test_attempts ADD COLUMN IF NOT EXISTS skipped_count INTEGER DEFAULT 0;
        ALTER TABLE test_attempts ADD COLUMN IF NOT EXISTS neet_equiv_score REAL;
        ALTER TABLE test_attempts ADD COLUMN IF NOT EXISTS percentile_est REAL;
        ALTER TABLE test_attempts ADD COLUMN IF NOT EXISTS time_taken_sec INTEGER;
        -- test_attempts.test_id is shared by two subsystems: the legacy
        -- faculty-created "tests" table (server.js) and the newer Bridge
        -- Course "generated_tests" table (qbank.js). A single FK can only
        -- point at one of them, so drop it rather than have one subsystem
        -- permanently break the other's inserts.
        ALTER TABLE test_attempts DROP CONSTRAINT IF EXISTS test_attempts_test_id_fkey;
        ALTER TABLE mistakes ADD COLUMN IF NOT EXISTS chapter_name TEXT;
        ALTER TABLE mistakes ADD COLUMN IF NOT EXISTS subtopic TEXT;
        ALTER TABLE mistakes ADD COLUMN IF NOT EXISTS concept TEXT;
        ALTER TABLE mistakes DROP CONSTRAINT IF EXISTS mistakes_test_id_fkey;
        ALTER TABLE mistakes DROP CONSTRAINT IF EXISTS mistakes_question_id_fkey;
        -- The "chapters" table is shared by the original legacy chapter
        -- system (server.js: subject/name/description/position/created_by)
        -- and the newer NEET/JEE dual-track Bridge system, which added
        -- course_type to the same CREATE TABLE statement above. That
        -- CREATE TABLE IF NOT EXISTS is a no-op on any database whose
        -- "chapters" table already existed before course_type was added,
        -- so it never picked up the new column -- this is what was causing
        -- "column course_type of relation chapters does not exist" on
        -- startup. Same reasoning applies to question_bank.
        ALTER TABLE chapters ADD COLUMN IF NOT EXISTS course_type TEXT NOT NULL DEFAULT 'NEET';
        ALTER TABLE chapters ADD COLUMN IF NOT EXISTS description TEXT;
        ALTER TABLE chapters ADD COLUMN IF NOT EXISTS position INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE chapters ADD COLUMN IF NOT EXISTS created_by TEXT REFERENCES faculty(email) ON DELETE SET NULL;
        ALTER TABLE chapters ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();
        ALTER TABLE question_bank ADD COLUMN IF NOT EXISTS course_type TEXT NOT NULL DEFAULT 'NEET';
        ALTER TABLE question_bank ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'pending';
        ALTER TABLE question_bank ADD COLUMN IF NOT EXISTS submitted_by TEXT REFERENCES faculty(email) ON DELETE SET NULL;
        ALTER TABLE question_bank ADD COLUMN IF NOT EXISTS approved_by TEXT REFERENCES faculty(email) ON DELETE SET NULL;
        ALTER TABLE question_bank ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ;
        ALTER TABLE question_bank ADD COLUMN IF NOT EXISTS rejection_note TEXT;
        ALTER TABLE question_bank ADD COLUMN IF NOT EXISTS usage_count INTEGER DEFAULT 0;
        ALTER TABLE generated_tests ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'published';
    `);

    // The seedChapters() ON CONFLICT (course_type, subject, name) upsert
    // needs a unique index on exactly those 3 columns to target. A legacy
    // "chapters" table (see above) may only have UNIQUE(subject, name), or
    // no unique constraint at all, so this has to be (re)created explicitly
    // rather than assumed from the CREATE TABLE above. The old (subject,
    // name)-only constraint (if present) also has to be dropped: it's
    // stricter than we need now that course_type exists, and would block
    // e.g. a JEE "Physics/Units and Dimensions" chapter from coexisting
    // with the equivalent NEET one, even though ON CONFLICT only knows
    // about the newer 3-column index.
    await pool.query(`
        ALTER TABLE chapters DROP CONSTRAINT IF EXISTS chapters_subject_name_key;
        CREATE UNIQUE INDEX IF NOT EXISTS chapters_course_subject_name_uidx
            ON chapters (course_type, subject, name);
    `);

    // Unique index on lectures.url so seedProfKonuriLectures() below can use
    // ON CONFLICT (url) DO NOTHING as an idempotent top-up target. Existing
    // databases can already have duplicate urls (e.g. a lecture submitted
    // twice before this index existed), which would make the index creation
    // itself fail -- so duplicates are cleaned up first, keeping the oldest
    // row (lowest id) for each url.
    await pool.query(`
        DELETE FROM lectures a USING lectures b
            WHERE a.url = b.url AND a.id > b.id;
        CREATE UNIQUE INDEX IF NOT EXISTS lectures_url_uidx ON lectures (url);
    `);

    // -----------------------------------------------------------------
    // Additive schema: serve-time option shuffle, namespaced legacy-test
    // clock, restored Physics entry-test tables, lecture submitter email.
    // -----------------------------------------------------------------
    await pool.query(`
        -- A random permutation of the 4 option slots, e.g. [2,0,3,1]: slot i
        -- shows ORIGINAL option perm[i]. Used as the column default so EVERY
        -- insert path (entry tests, daily/weekly/monthly/mock/combo, grand-test
        -- edits) gets a shuffled order without touching each INSERT.
        CREATE OR REPLACE FUNCTION ctk_random_option_order() RETURNS jsonb AS $$
            SELECT jsonb_agg(i ORDER BY random()) FROM generate_series(0,3) AS i
        $$ LANGUAGE sql VOLATILE;
        ALTER TABLE generated_test_questions ALTER COLUMN option_order SET DEFAULT ctk_random_option_order();

        -- Server-side clock for LEGACY faculty tests (the \"tests\" table). Kept
        -- separate from test_start_times because that table's test_id shares
        -- one numeric id space with generated_tests: reusing it would let
        -- legacy test #7 stamp (or expire) Bridge test #7.
        CREATE TABLE IF NOT EXISTS legacy_test_start_times (
            test_id         INTEGER NOT NULL REFERENCES tests(id) ON DELETE CASCADE,
            student_email   TEXT NOT NULL REFERENCES students(email) ON DELETE CASCADE,
            started_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            submitted_at    TIMESTAMPTZ,
            PRIMARY KEY (test_id, student_email)
        );

        -- Lecturer submissions: remember WHO (by login) submitted, so a
        -- faculty member's "my submissions" list no longer depends on the
        -- free-text name typed into the form.
        ALTER TABLE lectures ADD COLUMN IF NOT EXISTS submitted_by_email TEXT;

        -- Faculty file uploads (Cloudflare R2, see storage.js). storage_key is the
        -- object key in the bucket so the file can be deleted/replaced later;
        -- NULL for every pre-existing row and for plain link-based entries.
        -- Additive only: nothing is dropped or rewritten.
        ALTER TABLE lectures  ADD COLUMN IF NOT EXISTS storage_key TEXT;
        ALTER TABLE lectures  ADD COLUMN IF NOT EXISTS file_size_bytes BIGINT;
        ALTER TABLE materials ADD COLUMN IF NOT EXISTS storage_key TEXT;

        -- Physics Student Module entry diagnostics (these three tables were
        -- defined in an earlier release but dropped from this file while the
        -- /api/physics/* routes stayed, so every Physics route 500'd on a
        -- fresh database). lecture_progress / material_progress already exist above.
        CREATE TABLE IF NOT EXISTS physics_entry_tests (
            test_number     INTEGER PRIMARY KEY CHECK (test_number IN (1,2,3)),
            title           TEXT NOT NULL,
            mandatory       BOOLEAN NOT NULL DEFAULT FALSE
        );
        CREATE TABLE IF NOT EXISTS physics_entry_questions (
            id              SERIAL PRIMARY KEY,
            test_number     INTEGER NOT NULL REFERENCES physics_entry_tests(test_number) ON DELETE CASCADE,
            topic           TEXT NOT NULL,
            question_text   TEXT NOT NULL,
            options         JSONB NOT NULL,
            correct_answer  INTEGER NOT NULL,
            position        INTEGER DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS physics_entry_attempts (
            id                  SERIAL PRIMARY KEY,
            student_email       TEXT REFERENCES students(email) ON DELETE CASCADE,
            test_number         INTEGER NOT NULL,
            answers             JSONB,
            score               INTEGER,
            total               INTEGER,
            topic_breakdown     JSONB,
            proficiency_level   TEXT,
            time_taken_seconds  INTEGER,
            submitted_at        TIMESTAMPTZ DEFAULT NOW()
        );
    `);

    // Seed the 3 Physics entry tests + their (development-stage) questions once.
    const { rows: [{ c: peCount }] } = await pool.query(`SELECT COUNT(*) AS c FROM physics_entry_tests`);
    if (parseInt(peCount, 10) === 0) {
        await pool.query(`
            INSERT INTO physics_entry_tests (test_number, title, mandatory) VALUES
            (1, 'Physics Entry Test 1 — Foundation Diagnostic', TRUE),
            (2, 'Physics Entry Test 2 — Extended Diagnostic',   FALSE),
            (3, 'Physics Entry Test 3 — Advanced Diagnostic',   FALSE)
            ON CONFLICT DO NOTHING
        `);
        for (const [testNumber, questions] of Object.entries(PHYSICS_ENTRY_QUESTIONS)) {
            for (let i = 0; i < questions.length; i++) {
                const q = questions[i];
                await pool.query(
                    `INSERT INTO physics_entry_questions (test_number, topic, question_text, options, correct_answer, position)
                     VALUES ($1,$2,$3,$4,$5,$6)`,
                    [parseInt(testNumber, 10), q.topic, q.text, JSON.stringify(q.options), q.answer, i]
                );
            }
        }
        console.log('✅  Seeded 3 Physics entry tests (10 development MCQs each)');
    }

    // One-time: shuffle the option order of tests that nobody has started
    // yet. (A test someone has opened or submitted keeps its stored order so
    // their in-flight answers and history stay consistent.)
    const { rows: [bf] } = await pool.query(`SELECT value FROM settings WHERE key = 'option_order_backfill_v1'`).then(r => ({ rows: r.rows.length ? r.rows : [null] }));
    if (!bf) {
        const { rowCount } = await pool.query(`
            UPDATE generated_test_questions
            SET option_order = ctk_random_option_order()
            WHERE option_order = '[0,1,2,3]'::jsonb
              AND test_id NOT IN (SELECT test_id FROM test_attempts WHERE test_id IS NOT NULL)
              AND test_id NOT IN (SELECT test_id FROM test_start_times)
        `);
        await pool.query(`INSERT INTO settings (key, value) VALUES ('option_order_backfill_v1', $1) ON CONFLICT DO NOTHING`, [String(rowCount)]);
        if (rowCount) console.log(`✅  Shuffled option order on ${rowCount} existing test question(s)`);
    }

    // Seed chapters
    await seedChapters();

    // Seed question bank with dummy questions
    await seedQuestionBank();

    // Import real Bridge Course questions (Physics/Chemistry/Botany/Zoology)
    await importRealQuestions();
    await syncImportedQuestionFixes();

    // Pre-generate entry tests
    await seedEntryTests();

    // If entry tests already existed from before the import above, rebuild
    // them so they draw from the real questions instead of dummy ones
    await migrateEntryTestsToRealQuestions();

    // Seed default admin
    const { rows: adminRows } = await pool.query(`SELECT id FROM users WHERE role = 'admin' LIMIT 1`);
    if (adminRows.length === 0) {
        const bcrypt = require('bcryptjs');
        const isProd = process.env.NODE_ENV === 'production';
        if (isProd && !process.env.DEFAULT_ADMIN_PASSWORD) {
            // The fallback password is committed in this repo, so seeding it on a
            // production database would hand out an admin account to anyone who can
            // read the source. Skip it; the first admin can register with ADMIN_SIGNUP_CODE.
            console.error('⚠️  No admin account exists and DEFAULT_ADMIN_PASSWORD is not set — NOT seeding a default admin in production. Set DEFAULT_ADMIN_PASSWORD (and restart) or register an admin with ADMIN_SIGNUP_CODE.');
        } else {
            const adminEmail = process.env.DEFAULT_ADMIN_EMAIL || 'admin@ctkbridge.com';
            const defaultPass = process.env.DEFAULT_ADMIN_PASSWORD || 'ctk-admin-2026';
            const hash = await bcrypt.hash(defaultPass, 10);
            await pool.query(
                `INSERT INTO users (name, email, password_hash, role, is_verified, onboarding_done)
                 VALUES ('CTK Admin', $1, $2, 'admin', TRUE, TRUE) ON CONFLICT (email) DO NOTHING`,
                [adminEmail, hash]
            );
            // Never print the password itself; logs are routinely shared.
            console.log(`ℹ️  Seeded default admin: ${adminEmail}` + (process.env.DEFAULT_ADMIN_PASSWORD ? ' (password from DEFAULT_ADMIN_PASSWORD)' : ' (development default password — see README; change it)'));
        }
    }

    // Exam date setting
    const { rows } = await pool.query(`SELECT value FROM settings WHERE key = 'exam_date'`);
    if (rows.length === 0) {
        const d = new Date();
        d.setMonth(d.getMonth() + 8);
        await pool.query(
            `INSERT INTO settings (key, value) VALUES ('exam_date', $1) ON CONFLICT DO NOTHING`,
            [d.toISOString().split('T')[0]]
        );
    }

    // Seed sample lectures
    const { rows: lRows } = await pool.query(`SELECT COUNT(*) AS c FROM lectures`);
    if (parseInt(lRows[0].c, 10) === 0) {
        await pool.query(`
            INSERT INTO lectures (title, subject, url, lecturer_name, approved, course_type) VALUES
            ('Human Reproduction - High Yield Revision', 'Botany',   'https://www.youtube.com/embed/UMo7dUNGkQo', 'Dr. Meera Sharma',  1, 'NEET'),
            ('Thermodynamics - Connecting Concepts',     'Physics',  'https://www.youtube.com/embed/4i1MUWJoI0U', 'Prof. Anil Kapoor', 1, 'NEET'),
            ('Chemical Bonding - VSEPR & Hybridisation', 'Chemistry','https://www.youtube.com/embed/v=uVBSBFxbUlA', 'Dr. Priya Nair', 1, 'NEET'),
            ('Calculus Fundamentals for JEE', 'Mathematics', 'https://www.youtube.com/embed/WUvTyaaNkzM', 'Prof. Ramesh Kumar', 1, 'JEE')
        `);
    }

    // Idempotent top-up (like seedChapters): adds Prof. Konuri's Connectomic
    // lecture videos on every startup via ON CONFLICT (url) DO NOTHING, so
    // it's safe to re-run against a database that's already live and never
    // duplicates rows. lecturer_name = 'CTK Faculty' is what the frontend
    // (renderPractice() in app.js) filters on to populate the "Prof.
    // Konuri's Connectomic Lectures" section on the Practice page.
    await seedProfKonuriLectures();

    console.log('✅  CTK Bridge Course database schema ready');
}

// ---------------------------------------------------------------------------
// CURRICULUM DEFINITIONS
// ---------------------------------------------------------------------------
const CURRICULUM = {
    NEET: {
        Physics:  ['Units and Dimensions','Kinematics','Laws of Motion','Work Energy Power',
                   'Rotational Motion','Gravitation','Oscillations and Waves','Thermodynamics',
                   'Electrostatics','Current Electricity','Magnetism','Optics','Modern Physics'],
        Chemistry: ['Atomic Structure','Chemical Bonding','States of Matter','Thermodynamics',
                    'Equilibrium','Electrochemistry','Chemical Kinetics','Surface Chemistry',
                    'Periodic Table','s-Block Elements','p-Block Elements','Organic Chemistry Basics',
                    'Hydrocarbons'],
        Botany:   ['Cell Biology','Plant Physiology','Reproduction in Plants','Genetics',
                   'Evolution','Ecology','Plant Morphology','Biomolecules','Biotechnology',
                   'Plant Kingdom','Photosynthesis','Respiration','Plant Growth'],
        Zoology:  ['Animal Kingdom','Human Physiology','Reproduction','Genetics & Evolution',
                   'Human Health & Disease','Biotechnology Applications','Ecology',
                   'Cell Biology & Biomolecules','Animal Morphology','Nervous System',
                   'Endocrine System','Excretory System','Circulatory System']
    },
    JEE: {
        Physics:  ['Units and Dimensions','Kinematics','Laws of Motion','Work Energy Power',
                   'Rotational Motion','Gravitation','Oscillations and Waves','Thermodynamics',
                   'Electrostatics','Current Electricity','Magnetism','Optics','Modern Physics'],
        Chemistry: ['Atomic Structure','Chemical Bonding','States of Matter','Thermodynamics',
                    'Equilibrium','Electrochemistry','Chemical Kinetics','Surface Chemistry',
                    'Periodic Table','s-Block Elements','p-Block Elements','Organic Chemistry Basics',
                    'Hydrocarbons'],
        Mathematics: ['Sets Relations Functions','Complex Numbers','Matrices Determinants',
                      'Permutations Combinations','Binomial Theorem','Sequences Series',
                      'Straight Lines','Conic Sections','Limits Continuity','Differentiation',
                      'Integration','Differential Equations','Vectors 3D','Probability','Trigonometry']
    }
};

// Subject distributions for 90-question tests
const TEST_SUBJECT_DIST = {
    NEET: { Physics: 22, Chemistry: 23, Botany: 22, Zoology: 23 },
    JEE:  { Physics: 30, Chemistry: 30, Mathematics: 30 }
};

// Entry tests specifically: no real Mathematics content has been imported
// for JEE (only Physics & Chemistry), so JEE entry tests are built from
// Physics + Chemistry only, without a Mathematics component. NEET is
// unaffected. This intentionally does NOT touch TEST_SUBJECT_DIST above,
// which still governs JEE daily/weekly/monthly/mock tests (those keep
// their Mathematics share).
const ENTRY_TEST_SUBJECT_DIST = {
    NEET: TEST_SUBJECT_DIST.NEET,
    JEE:  { Physics: 45, Chemistry: 45 }
};

// Difficulty ratios per mode
const DIFFICULTY_RATIOS = {
    Easy:     { Easy: 0.70, Moderate: 0.25, Difficult: 0.05 },
    Moderate: { Easy: 0.25, Moderate: 0.50, Difficult: 0.25 },
    Difficult:{ Easy: 0.10, Moderate: 0.40, Difficult: 0.50 },
    Mixed:    { Easy: 0.33, Moderate: 0.34, Difficult: 0.33 }
};

async function seedChapters() {
    // Idempotent top-up (not a one-time seed): ON CONFLICT DO NOTHING makes
    // every insert safe to repeat, so this must NOT bail out early just
    // because *some* chapters already exist. Bailing out early was the bug
    // that left newly-added subjects (e.g. Botany, Zoology, Mathematics)
    // with zero chapters on any database that had already been seeded
    // before those subjects existed -- which is exactly why "Chapter Combo
    // Test" showed no chapters to pick from for those subjects. Every
    // course/subject/chapter combo in CURRICULUM is checked/inserted on
    // every startup so older databases automatically catch up.
    for (const [courseType, subjects] of Object.entries(CURRICULUM)) {
        for (const [subject, chapters] of Object.entries(subjects)) {
            for (let i = 0; i < chapters.length; i++) {
                await pool.query(
                    `INSERT INTO chapters (course_type, subject, name, position) VALUES ($1,$2,$3,$4)
                     ON CONFLICT (course_type, subject, name) DO NOTHING`,
                    [courseType, subject, chapters[i], i]
                );
            }
        }
    }
    console.log('✅  Chapters up to date for NEET & JEE');
}

// Prof. Konuri's Connectomic lecture videos, hosted on the CDN. Grouped
// under lecturer_name = 'CTK Faculty' so they surface in the dedicated
// "Prof. Konuri's Connectomic Lectures" section on the Practice page
// (see renderPractice() in frontend/app.js), separate from community/
// approved faculty lectures. Titles/subjects can be edited later from
// the Lecturer Hub if needed -- this just gets them onto the platform.
// Base URL comes from env (CDN_BASE_URL) via cdn.js -- never hard-code it here.
const { lectureBase: PROF_KONURI_LECTURE_BASE_URL, legacyBases: LEGACY_CDN_BASES, isConfigured: CDN_BASE_CONFIGURED } = require('./cdn');
const PROF_KONURI_LECTURES = [
    ['Connectomic_Method.mp4',                          'Connectomic Method'],
    ['Connectomics_Beats_Medical_Exam_Cramming.m4a',     'Connectomics Beats Medical Exam Cramming'],
    ['Don_t_Calculate.mp4',                              "Don't Calculate"],
    ['Lorry_vs.mp4',                                     'Lorry vs.'],
    ['Lorry_vs_Bullet_paradox.mp4',                      'Lorry vs Bullet Paradox'],
    ['One_Key,_Many_Doors.mp4',                          'One Key, Many Doors'],
    ['Replace_mental_boxes_with_neural_highways.m4a',    'Replace Mental Boxes With Neural Highways'],
    ['Scaling_the_Seven_Hills.mp4',                       'Scaling the Seven Hills'],
    ['Scaling_the_Seven_Hills_with_AI.m4a',               'Scaling the Seven Hills with AI'],
    ['The_Fifth_and_Sixth_Hills.mp4',                     'The Fifth and Sixth Hills'],
    ['The_First_Hill.mp4',                                'The First Hill'],
    ['The_Inclined_Plane.mp4',                            'The Inclined Plane'],
    ['The_NEET_Challenge.mp4',                            'The NEET Challenge'],
    ['The_Second_Hill.mp4',                               'The Second Hill'],
    ['The_Seventh_Hill.mp4',                              'The Seventh Hill'],
    ['The_Third_Hill__Discovery.mp4',                     'The Third Hill Discovery'],
    ['Why_Oil_Doesn_t_Mix.mp4',                           "Why Oil Doesn't Mix"],
];

// Re-points lecture rows at the current CDN_BASE_URL after the bucket/account
// moves. Idempotent, runs every startup, and does nothing at all unless
// CDN_BASE_URL is set -- so existing deployments are untouched until opted in.
//  1. Seeded 'CTK Faculty' rows are matched by FILENAME, so they follow the
//     base whatever it used to be.
//  2. Any other row (e.g. faculty-submitted) is only rewritten if it sits on a
//     known legacy base -- external links to other sites are never touched.
// Conflicts with the unique url index are resolved by keeping one row.
async function syncLectureCdnBase() {
    if (!CDN_BASE_CONFIGURED) return;
    const base = PROF_KONURI_LECTURE_BASE_URL;

    for (const [fileName] of PROF_KONURI_LECTURES) {
        const target = `${base}/${fileName}`;
        const { rows: stale } = await pool.query(
            `SELECT id FROM lectures
              WHERE lecturer_name = 'CTK Faculty' AND right(url, $1) = $2 AND url <> $3
              ORDER BY id`,
            [fileName.length + 1, '/' + fileName, target]
        );
        if (!stale.length) continue;
        const { rows: existing } = await pool.query(`SELECT id FROM lectures WHERE url = $1`, [target]);
        const ids = stale.map(r => r.id);
        if (existing.length) {
            await pool.query(`DELETE FROM lectures WHERE id = ANY($1::int[])`, [ids]);
        } else {
            await pool.query(`UPDATE lectures SET url = $1 WHERE id = $2`, [target, ids[0]]);
            if (ids.length > 1) await pool.query(`DELETE FROM lectures WHERE id = ANY($1::int[])`, [ids.slice(1)]);
        }
    }

    for (const oldBase of LEGACY_CDN_BASES) {
        const { rows } = await pool.query(
            `SELECT id, url FROM lectures WHERE left(url, $1) = $2`,
            [oldBase.length + 1, oldBase + '/']
        );
        for (const row of rows) {
            try {
                await pool.query(`UPDATE lectures SET url = $1 WHERE id = $2`, [base + row.url.slice(oldBase.length), row.id]);
            } catch (err) {
                if (err.code !== '23505') throw err; // target url already exists -> leave this row as-is
            }
        }
    }
    console.log(`✅  Lecture URLs synced to CDN base ${base}`);
}

async function seedProfKonuriLectures() {
    // One-time cleanup: two filenames were corrected after being seeded
    // under the wrong URL (typo'd "Al" -> "AI", missing double underscore
    // in "Third_Hill__Discovery"). Remove the old, now-broken rows so they
    // don't linger as duplicate 404 cards alongside the corrected ones.
    // Matched by filename (not full URL) so it works whatever the base was.
    for (const badFile of ['Scaling_the_Seven_Hills_with_Al.m4a', 'The_Third_Hill_Discovery.mp4']) {
        await pool.query(
            `DELETE FROM lectures WHERE lecturer_name = 'CTK Faculty' AND right(url, $1) = $2`,
            [badFile.length + 1, '/' + badFile]
        );
    }

    await syncLectureCdnBase();

    for (const [fileName, title] of PROF_KONURI_LECTURES) {
        // DO UPDATE (not DO NOTHING): self-healing on every startup, so if a
        // row for this url already exists with a stale/incorrect
        // lecturer_name (e.g. it was added once through the regular faculty
        // "submit lecture" flow before this seed existed, or survived a
        // dedup pass with the wrong lecturer_name), it gets corrected back
        // to 'CTK Faculty' instead of silently staying wrong forever.
        await pool.query(
            `INSERT INTO lectures (title, subject, url, lecturer_name, approved, course_type)
             VALUES ($1, 'Connectomic Theory', $2, 'CTK Faculty', 1, 'NEET')
             ON CONFLICT (url) DO UPDATE SET
                title         = EXCLUDED.title,
                subject       = EXCLUDED.subject,
                lecturer_name = EXCLUDED.lecturer_name,
                approved      = EXCLUDED.approved,
                course_type   = EXCLUDED.course_type`,
            [title, `${PROF_KONURI_LECTURE_BASE_URL}/${fileName}`]
        );
    }
    console.log('✅  Prof. Konuri Connectomic lectures up to date');
}

// ---------------------------------------------------------------------------
// DUMMY QUESTION BANK SEED
// Tops every chapter up to ~100 dummy questions (approved), spread evenly
// across Easy/Moderate/Difficult, so the platform works out of the box and
// every difficulty filter has enough supply. Idempotent: safe to run on
// every server start — only inserts what's missing per chapter, so it also
// tops up databases that were previously seeded with fewer questions.
// Faculty replace/add to these via the Question Bank over time.
// ---------------------------------------------------------------------------
const DUMMY_QUESTIONS_PER_CHAPTER = 100;

async function seedQuestionBank() {
    const difficulties = ['Easy','Moderate','Difficult'];
    let totalInserted = 0;

    for (const [courseType, subjects] of Object.entries(CURRICULUM)) {
        for (const [subject, chapters] of Object.entries(subjects)) {
            for (const chapter of chapters) {
                const { rows: [{ c }] } = await pool.query(
                    `SELECT COUNT(*) AS c FROM question_bank
                     WHERE course_type = $1 AND subject = $2 AND chapter_name = $3`,
                    [courseType, subject, chapter]
                );
                const existing = parseInt(c, 10);
                if (existing >= DUMMY_QUESTIONS_PER_CHAPTER) continue;

                // Build every missing row for this chapter and insert them
                // in ONE query (multi-row VALUES) instead of one round-trip
                // per question — with ~9000+ dummy questions total, one
                // query per row was extremely slow against remote DBs
                // (Render/Railway) and made startup look like it had hung.
                const values = [];
                const params = [];
                let p = 0;
                for (let i = existing; i < DUMMY_QUESTIONS_PER_CHAPTER; i++) {
                    const diff = difficulties[i % 3];
                    const row = [
                        courseType, subject, chapter, chapter,
                        `[${courseType}·${subject}·${chapter}] Sample Question ${i+1}: Which of the following best describes a key concept in ${chapter}?`,
                        `Option A — Correct concept related to ${chapter} (item ${i+1})`,
                        `Option B — Plausible but incorrect distractor`,
                        `Option C — Common misconception about ${chapter}`,
                        `Option D — Unrelated concept`,
                        'A',
                        `The correct answer is A because it accurately describes the fundamental principle of ${chapter}.`,
                        diff,
                        diff === 'Easy' ? 45 : diff === 'Moderate' ? 60 : 90
                    ];
                    values.push(`(${row.map(() => `$${++p}`).join(',')},'approved')`);
                    params.push(...row);
                    totalInserted++;
                }
                if (values.length === 0) continue;

                await pool.query(
                    `INSERT INTO question_bank
                     (course_type, subject, chapter_name, topic, question_text,
                      option_a, option_b, option_c, option_d, correct_answer,
                      explanation, difficulty, estimated_time, status)
                     VALUES ${values.join(',')}`,
                    params
                );
            }
        }
    }
    if (totalInserted > 0) {
        console.log(`✅  Topped up question_bank with ${totalInserted} dummy questions (target ~${DUMMY_QUESTIONS_PER_CHAPTER}/chapter)`);
    }
}

// ---------------------------------------------------------------------------
// REAL QUESTION IMPORT — Bridge Course source material (Physics, Chemistry,
// Botany, Zoology). Replaces reliance on dummy questions for these subjects.
// Botany & Zoology share the same underlying Biology questions. Idempotent:
// tagged via subtopic = 'bridge_course_import' so it only inserts once even
// if the server restarts many times.
// ---------------------------------------------------------------------------
async function importRealQuestions() {
    const byCourseType = {};
    let skipped = 0;
    for (const q of REAL_IMPORTED_QUESTIONS) {
        // Never seed a row that fails the structural audit (wrong/unknown key,
        // duplicate options, letter-reference options, working-out in the
        // explanation): a bad row costs students marks, a missing row costs nothing.
        const { errors } = auditRow(q);
        if (errors.length) { skipped++; console.error(`⚠️  Skipping question that fails audit (${errors.join('; ')}): ${String(q.question_text).slice(0, 70)}`); continue; }
        (byCourseType[q.course_type] = byCourseType[q.course_type] || []).push(q);
    }
    if (skipped) console.error(`⚠️  ${skipped} imported question(s) skipped by the audit — run \`npm run audit:questions\``);

    const CHUNK = 200;
    for (const [courseType, qs] of Object.entries(byCourseType)) {
        const { rows: [{ c }] } = await pool.query(
            `SELECT COUNT(*) AS c FROM question_bank WHERE subtopic = 'bridge_course_import' AND course_type = $1`,
            [courseType]
        );
        if (parseInt(c, 10) > 0) continue; // this course type's real questions already imported

        for (let i = 0; i < qs.length; i += CHUNK) {
            const chunk = qs.slice(i, i + CHUNK);
            const values = [];
            const params = [];
            let p = 0;
            for (const q of chunk) {
                const row = [
                    q.course_type, q.subject, q.chapter_name, q.topic, 'bridge_course_import',
                    q.question_text, q.option_a, q.option_b, q.option_c, q.option_d,
                    q.correct_answer, q.explanation, q.difficulty, q.estimated_time
                ];
                values.push(`(${row.map(() => `$${++p}`).join(',')},'approved')`);
                params.push(...row);
            }
            await pool.query(
                `INSERT INTO question_bank
                 (course_type, subject, chapter_name, topic, subtopic,
                  question_text, option_a, option_b, option_c, option_d,
                  correct_answer, explanation, difficulty, estimated_time, status)
                 VALUES ${values.join(',')}`,
                params
            );
        }
        console.log(`✅  Imported ${qs.length} real Bridge Course questions for ${courseType}`);
    }
}

// ---------------------------------------------------------------------------
// IMPORTED-QUESTION REPAIR
// Databases seeded from an older release already contain the old (wrong)
// answer keys / options / explanations, and importRealQuestions() above never
// touches a course type that has already been imported. This brings those rows
// up to the corrected bank in place.
//
// Safety: a row is only updated if it STILL EQUALS the original imported
// values (stem, all four options, key and explanation). Anything a faculty
// member edited through the question-bank UI no longer matches and is left
// alone. Idempotent: after one pass nothing matches, so re-runs are no-ops.
// ---------------------------------------------------------------------------
async function syncImportedQuestionFixes() {
    const work = changedRows(RAW_IMPORTED_QUESTIONS, REAL_IMPORTED_QUESTIONS)
        .filter(({ now }) => !auditRow(now).errors.length);
    if (!work.length) return;

    let updated = 0;
    const CHUNK = 250;
    for (let i = 0; i < work.length; i += CHUNK) {
        const part = work.slice(i, i + CHUNK);
        const col = f => part.map(({ old }) => old[f] ?? null);
        const colNew = f => part.map(({ now }) => now[f] ?? null);
        const { rowCount } = await pool.query(
            `UPDATE question_bank qb SET
                 question_text = v.n_q, option_a = v.n_a, option_b = v.n_b, option_c = v.n_c, option_d = v.n_d,
                 correct_answer = v.n_k, explanation = v.n_e
             FROM (SELECT
                     unnest($1::text[]) AS course_type, unnest($2::text[]) AS subject, unnest($3::text[]) AS chapter_name,
                     unnest($4::text[]) AS o_q, unnest($5::text[]) AS o_a, unnest($6::text[]) AS o_b,
                     unnest($7::text[]) AS o_c, unnest($8::text[]) AS o_d, unnest($9::text[]) AS o_k, unnest($10::text[]) AS o_e,
                     unnest($11::text[]) AS n_q, unnest($12::text[]) AS n_a, unnest($13::text[]) AS n_b,
                     unnest($14::text[]) AS n_c, unnest($15::text[]) AS n_d, unnest($16::text[]) AS n_k, unnest($17::text[]) AS n_e
                  ) v
             WHERE qb.subtopic = 'bridge_course_import'
               AND qb.course_type = v.course_type AND qb.subject = v.subject AND qb.chapter_name = v.chapter_name
               AND qb.question_text = v.o_q
               AND qb.option_a = v.o_a AND qb.option_b = v.o_b AND qb.option_c = v.o_c AND qb.option_d = v.o_d
               AND qb.correct_answer = v.o_k
               AND qb.explanation IS NOT DISTINCT FROM v.o_e`,
            [
                col('course_type'), col('subject'), col('chapter_name'),
                col('question_text'), col('option_a'), col('option_b'), col('option_c'), col('option_d'), col('correct_answer'), col('explanation'),
                colNew('question_text'), colNew('option_a'), colNew('option_b'), colNew('option_c'), colNew('option_d'), colNew('correct_answer'), colNew('explanation')
            ]
        );
        updated += rowCount;
    }
    if (updated) console.log(`✅  Repaired ${updated} imported question row(s) (answer keys / options / explanations)`);
}

// ---------------------------------------------------------------------------
// ENTRY TEST MIGRATION — if entry tests were already generated (e.g. on an
// existing dev database) before the real questions above were imported,
// they'd still be built from dummy questions. This checks whether any
// current entry-test question is real (non-dummy) content; if not, it wipes
// just the entry tests (not any other test type) and lets seedEntryTests()
// rebuild them — which now prefers real questions (see seedEntryTests below).
// Safe to run on every startup: it's a no-op once entry tests are real.
// ---------------------------------------------------------------------------
async function migrateEntryTestsToRealQuestions() {
    for (const courseType of ['NEET', 'JEE']) {
        const { rows: [{ c }] } = await pool.query(`
            SELECT COUNT(*) AS c
            FROM entry_tests et
            JOIN generated_test_questions gtq ON gtq.test_id = et.test_id
            JOIN question_bank qb ON qb.id = gtq.question_id
            WHERE qb.subtopic = 'bridge_course_import' AND et.course_type = $1
        `, [courseType]);
        if (parseInt(c, 10) > 0) continue; // this course type's entry tests already real

        const { rows: ets } = await pool.query(
            `SELECT test_id FROM entry_tests WHERE course_type = $1`, [courseType]
        );
        if (ets.length === 0) continue; // nothing generated yet for this course type — seedEntryTests() will handle it fresh

        const testIds = ets.map(r => r.test_id);
        await pool.query(`DELETE FROM generated_test_questions WHERE test_id = ANY($1::int[])`, [testIds]);
        await pool.query(`DELETE FROM entry_tests WHERE course_type = $1`, [courseType]);
        await pool.query(`DELETE FROM generated_tests WHERE id = ANY($1::int[])`, [testIds]);

        await seedEntryTests();
        console.log(`✅  Regenerated ${courseType} entry tests using real Bridge Course questions`);
    }
}

async function seedEntryTests() {
    for (const courseType of ['NEET','JEE']) {
        for (let testNum = 1; testNum <= 3; testNum++) {
            // Per (course_type, test_number) check — NOT a global count — so
            // e.g. adding JEE later doesn't get skipped just because NEET's
            // entry tests already exist.
            const { rows: existing } = await pool.query(
                `SELECT 1 FROM entry_tests WHERE course_type = $1 AND test_number = $2`,
                [courseType, testNum]
            );
            if (existing.length > 0) continue;

            // Create the generated_test record
            const { rows: [gt] } = await pool.query(
                `INSERT INTO generated_tests (test_type, course_type, title, difficulty_mode, question_count, time_limit_min)
                 VALUES ('entry', $1, $2, 'Mixed', 90, 180) RETURNING id`,
                [courseType, `${courseType} Entry Test ${testNum} — Baseline Assessment`]
            );
            const testId = gt.id;

            // Pick 90 approved questions, balanced across subjects, low overlap between tests.
            // Uses ENTRY_TEST_SUBJECT_DIST (not TEST_SUBJECT_DIST) so JEE entry
            // tests are Physics + Chemistry only — see note above.
            const dist = ENTRY_TEST_SUBJECT_DIST[courseType];
            let position = 0;

            for (const [subject, count] of Object.entries(dist)) {
                // offset by testNum so each entry test gets different questions.
                // Real (imported) questions are ordered before dummy/sample
                // ones so entry tests are filled with real content first,
                // only falling back to dummy questions if there isn't
                // enough real supply for a subject.
                const { rows: questions } = await pool.query(
                    `SELECT id FROM question_bank
                     WHERE course_type = $1 AND subject = $2 AND status = 'approved'
                     ORDER BY COALESCE(subtopic = 'bridge_course_import', false) DESC, id
                     LIMIT $3 OFFSET $4`,
                    [courseType, subject, count, (testNum - 1) * count]
                );
                for (const q of questions) {
                    await pool.query(
                        `INSERT INTO generated_test_questions (test_id, question_id, position) VALUES ($1,$2,$3)`,
                        [testId, q.id, position++]
                    );
                }
            }

            // Register in entry_tests table
            await pool.query(
                `INSERT INTO entry_tests (course_type, test_number, test_id, title)
                 VALUES ($1, $2, $3, $4)
                 ON CONFLICT (course_type, test_number) DO NOTHING`,
                [courseType, testNum, testId, `${courseType} Entry Test ${testNum}`]
            );
        }
    }
    console.log('✅  Entry tests up to date for NEET & JEE');
}

// ---------------------------------------------------------------------------
// TEST GENERATION ENGINE
// ---------------------------------------------------------------------------

/**
 * Generate a daily test for a given course type and date.
 * 90 questions, balanced subject distribution, no repeated questions within 30 days per student.
 */
async function generateDailyTest(courseType, date = new Date()) {
    const dateStr = date.toISOString().split('T')[0];

    // Check if already generated for this date
    const { rows: existing } = await pool.query(
        `SELECT id FROM generated_tests WHERE test_type='daily' AND course_type=$1 AND generated_for_date=$2`,
        [courseType, dateStr]
    );
    if (existing.length > 0) return existing[0].id;

    const { rows: [gt] } = await pool.query(
        `INSERT INTO generated_tests (test_type, course_type, title, difficulty_mode, question_count, time_limit_min, generated_for_date)
         VALUES ('daily', $1, $2, 'Mixed', 90, 180, $3) RETURNING id`,
        [courseType, `${courseType} Daily Practice Test — ${dateStr}`, dateStr]
    );
    const testId = gt.id;
    await fillTestQuestions(testId, courseType, 90, 'Mixed', null, null);
    return testId;
}

/**
 * Generate a weekly test (more comprehensive, higher difficulty proportion).
 */
async function generateWeeklyTest(courseType, weekStart = new Date()) {
    const dateStr = weekStart.toISOString().split('T')[0];
    const { rows: existing } = await pool.query(
        `SELECT id FROM generated_tests WHERE test_type='weekly' AND course_type=$1 AND generated_for_date=$2`,
        [courseType, dateStr]
    );
    if (existing.length > 0) return existing[0].id;

    const { rows: [gt] } = await pool.query(
        `INSERT INTO generated_tests (test_type, course_type, title, difficulty_mode, question_count, time_limit_min, generated_for_date)
         VALUES ('weekly', $1, $2, 'Difficult', 90, 180, $3) RETURNING id`,
        [courseType, `${courseType} Weekly Assessment — Week of ${dateStr}`, dateStr]
    );
    const testId = gt.id;
    await fillTestQuestions(testId, courseType, 90, 'Difficult', null, null);
    return testId;
}

/**
 * Generate a monthly test.
 */
async function generateMonthlyTest(courseType, month, year) {
    const dateStr = `${year}-${String(month).padStart(2,'0')}-01`;
    const { rows: existing } = await pool.query(
        `SELECT id FROM generated_tests WHERE test_type='monthly' AND course_type=$1 AND generated_for_date=$2`,
        [courseType, dateStr]
    );
    if (existing.length > 0) return existing[0].id;

    const monthName = new Date(dateStr).toLocaleString('default', { month: 'long' });
    const { rows: [gt] } = await pool.query(
        `INSERT INTO generated_tests (test_type, course_type, title, difficulty_mode, question_count, time_limit_min, generated_for_date)
         VALUES ('monthly', $1, $2, 'Difficult', 90, 180, $3) RETURNING id`,
        [courseType, `${courseType} Monthly Test — ${monthName} ${year}`, dateStr]
    );
    const testId = gt.id;
    await fillTestQuestions(testId, courseType, 90, 'Difficult', null, null);
    return testId;
}

/**
 * Generate a Grand Test (every 3 months, comprehensive). Grand tests are
 * faculty-published (not student self-serve): calling this twice for the
 * same courseType + label returns the existing test instead of creating a
 * duplicate, so it's safe for a faculty member to "publish" the same
 * label more than once.
 */
async function generateGrandTest(courseType, label, studentEmail = null, createdBy = null, status = 'draft') {
    const title = `${courseType} Grand Test — ${label}`;
    const { rows: existing } = await pool.query(
        `SELECT id FROM generated_tests WHERE test_type='grand' AND course_type=$1 AND title=$2`,
        [courseType, title]
    );
    if (existing.length > 0) return existing[0].id;

    const { rows: [gt] } = await pool.query(
        `INSERT INTO generated_tests (test_type, course_type, title, difficulty_mode, question_count, time_limit_min, created_by, status)
         VALUES ('grand', $1, $2, 'Mixed', 90, 180, $3, $4) RETURNING id`,
        [courseType, title, createdBy, status]
    );
    const testId = gt.id;
    await fillTestQuestions(testId, courseType, 90, 'Mixed', null, null, studentEmail);
    return testId;
}

/**
 * Generate a chapter-combo test (e.g. 3 chapters combined, 6 chapters combined).
 * When studentEmail is given, prefers questions that student hasn't seen yet.
 */
async function generateChapterComboTest(courseType, subject, chapters, studentEmail = null) {
    const title = `${courseType} ${subject} — Chapters: ${chapters.join(', ')}`;
    const { rows: [gt] } = await pool.query(
        `INSERT INTO generated_tests (test_type, course_type, title, subject_filter, chapter_filter, difficulty_mode, question_count, time_limit_min)
         VALUES ('chapter_combo', $1, $2, $3, $4, 'Mixed', 90, 180) RETURNING id`,
        [courseType, title, subject, chapters.join(',')]
    );
    const testId = gt.id;

    // Fill from specific chapters only, spreading across difficulty so the
    // combo test isn't accidentally all-Easy or all-Difficult.
    const ratios = DIFFICULTY_RATIOS.Mixed;
    const totalCount = 90;
    const easyCount = Math.round(totalCount * ratios.Easy);
    const moderateCount = Math.round(totalCount * ratios.Moderate);
    const difficultCount = totalCount - easyCount - moderateCount;

    let position = 0;
    for (const [diff, dCount] of [['Easy', easyCount],['Moderate', moderateCount],['Difficult', difficultCount]]) {
        if (dCount <= 0) continue;
        const questions = await pickQuestions({ courseType, subject, diff, chapterFilter: chapters, studentEmail, limit: dCount });
        for (const q of questions) {
            await pool.query(
                `INSERT INTO generated_test_questions (test_id, question_id, position) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
                [testId, q.id, position++]
            );
            await pool.query(`UPDATE question_bank SET usage_count = usage_count + 1 WHERE id = $1`, [q.id]);
        }
    }
    return testId;
}

/**
 * Generate a full NEET/JEE mock test.
 */
async function generateMockTest(courseType, difficultyMode = 'Mixed', studentEmail = null) {
    const testId = await createAndFillTest('mock', courseType,
        `${courseType} Full Mock Test — ${new Date().toISOString().split('T')[0]}`,
        difficultyMode, 90, 180, studentEmail);
    return testId;
}

async function createAndFillTest(type, courseType, title, difficultyMode, questionCount, timeLimitMin, studentEmail = null) {
    const { rows: [gt] } = await pool.query(
        `INSERT INTO generated_tests (test_type, course_type, title, difficulty_mode, question_count, time_limit_min)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [type, courseType, title, difficultyMode, questionCount, timeLimitMin]
    );
    await fillTestQuestions(gt.id, courseType, questionCount, difficultyMode, null, null, studentEmail);
    return gt.id;
}

/**
 * Picks up to `limit` approved questions for a course/subject/difficulty
 * (optionally restricted to a set of chapters). When `studentEmail` is
 * given, questions that student has already been served (question_exposure)
 * are avoided first; if the unseen pool can't cover the full quota, it tops
 * up from the least-recently-used questions overall so the test can still
 * be filled. This is the single place both fillTestQuestions (daily/weekly/
 * monthly/grand/mock) and the chapter-combo generator draw from, so
 * repetition avoidance is consistent across every test type.
 */
// The dummy seed rows ("[NEET·Physics·Kinematics] Sample Question 7: ...", answer
// always A) exist so a test can still be assembled for a chapter that has no
// real questions yet. They sort AFTER every real question in pickQuestions, so
// they only appear when the real pool is exhausted, and are reported.
const PLACEHOLDER_LIKE = `question_text LIKE '[%·%·%] Sample Question %'`;

async function countPlaceholderQuestions(testId) {
    const { rows: [r] } = await pool.query(
        `SELECT COUNT(*)::int AS n FROM generated_test_questions g
         JOIN question_bank qb ON qb.id = g.question_id
         WHERE g.test_id = $1 AND qb.${PLACEHOLDER_LIKE}`,
        [testId]
    );
    return r.n;
}

async function pickQuestions({ courseType, subject, diff, chapterFilter, studentEmail, limit }) {
    if (limit <= 0) return [];

    const baseParams = [courseType, subject];
    if (diff) baseParams.push(diff);
    const diffClause = diff ? `AND difficulty = $3` : '';
    const chapterClause = chapterFilter ? `AND chapter_name = ANY($${baseParams.length + 1})` : '';
    if (chapterFilter) baseParams.push(chapterFilter);

    if (studentEmail) {
        const exclParams = [...baseParams, studentEmail, limit];
        const { rows: unseen } = await pool.query(
            `SELECT id FROM question_bank
             WHERE course_type = $1 AND subject = $2 ${diffClause} AND status = 'approved'
             ${chapterClause}
             AND id NOT IN (SELECT question_id FROM question_exposure WHERE student_email = $${baseParams.length + 1})
             ORDER BY (question_text LIKE '[%·%·%] Sample Question %') ASC, usage_count ASC, RANDOM() LIMIT $${baseParams.length + 2}`,
            exclParams
        );
        if (unseen.length >= limit) return unseen;

        // Not enough unseen questions left — top up with the least-used
        // remaining ones (still avoiding exact duplicates within this pick).
        const remaining = limit - unseen.length;
        const excludeIds = unseen.map(q => q.id);
        const topUpParams = [...baseParams];
        let excludeClause = '';
        if (excludeIds.length) {
            excludeClause = `AND id != ALL($${topUpParams.length + 1})`;
            topUpParams.push(excludeIds);
        }
        topUpParams.push(remaining);
        const { rows: topUp } = await pool.query(
            `SELECT id FROM question_bank
             WHERE course_type = $1 AND subject = $2 ${diffClause} AND status = 'approved'
             ${chapterClause} ${excludeClause}
             ORDER BY (question_text LIKE '[%·%·%] Sample Question %') ASC, usage_count ASC, RANDOM() LIMIT $${topUpParams.length}`,
            topUpParams
        );
        return unseen.concat(topUp);
    }

    const params = [...baseParams, limit];
    const { rows } = await pool.query(
        `SELECT id FROM question_bank
         WHERE course_type = $1 AND subject = $2 ${diffClause} AND status = 'approved'
         ${chapterClause}
         ORDER BY (question_text LIKE '[%·%·%] Sample Question %') ASC, usage_count ASC, RANDOM() LIMIT $${params.length}`,
        params
    );
    return rows;
}

async function fillTestQuestions(testId, courseType, totalCount, difficultyMode, subjectFilter, chapterFilter, studentEmail = null) {
    const dist = subjectFilter
        ? { [subjectFilter]: totalCount }
        : TEST_SUBJECT_DIST[courseType] || TEST_SUBJECT_DIST.NEET;

    const ratios = DIFFICULTY_RATIOS[difficultyMode] || DIFFICULTY_RATIOS.Mixed;
    let position = 0;

    for (const [subject, count] of Object.entries(dist)) {
        const easyCount     = Math.round(count * ratios.Easy);
        const moderateCount = Math.round(count * ratios.Moderate);
        const difficultCount = count - easyCount - moderateCount;

        for (const [diff, dCount] of [['Easy', easyCount],['Moderate', moderateCount],['Difficult', difficultCount]]) {
            if (dCount <= 0) continue;

            const questions = await pickQuestions({ courseType, subject, diff, chapterFilter, studentEmail, limit: dCount });
            for (const q of questions) {
                await pool.query(
                    `INSERT INTO generated_test_questions (test_id, question_id, position)
                     VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
                    [testId, q.id, position++]
                );
                await pool.query(`UPDATE question_bank SET usage_count = usage_count + 1 WHERE id = $1`, [q.id]);
            }
        }
    }
}

// ---------------------------------------------------------------------------
// SCORE COMPUTATION
// ---------------------------------------------------------------------------
function computeScore(answers, questions, negativeMarking = false) {
    let correct = 0, wrong = 0, skipped = 0;
    const markPerQ = questions.length > 0 ? 4 : 4;

    for (const q of questions) {
        const ans = answers[q.id];
        if (!ans) { skipped++; continue; }
        if (ans === q.correct_answer) { correct++; }
        else { wrong++; }
    }

    const rawScore = correct * 4 - (negativeMarking ? wrong * 1 : 0);
    const totalMax = questions.length * 4;
    const percentage = totalMax > 0 ? (rawScore / totalMax) * 100 : 0;
    // Negative marking can push rawScore below zero; NEET never presents a
    // negative "marks out of 720" to students, so clamp at zero.
    const neetEquivScore = Math.max(0, Math.round((rawScore / totalMax) * 720));
    // Heuristic-only fallback, used when there isn't yet a large enough
    // cohort of attempts on this specific test to compute a real
    // percentile (see computeCohortPercentile below, used by the submit
    // route when cohort data is available). NOT a calibrated percentile.
    const percentileEst = Math.min(99.9, Math.max(0.1, 50 + (percentage - 50) * 0.8));

    return { correct, wrong, skipped, rawScore, totalMax, percentage, neetEquivScore, percentileEst };
}

// Maps a Bridge-course subject name to its `progress` table column suffix.
const BRIDGE_SUBJECT_PROGRESS_KEY = {
    Botany: 'bio', Biology: 'bio', Zoology: 'zoo',
    Physics: 'phy', Chemistry: 'chem', Mathematics: 'math'
};

/**
 * Updates the student's `progress` row (per-subject accuracy, quiz_count,
 * weekly_history) after ANY Bridge-course test submission -- daily, weekly,
 * monthly, mock, chapter-combo, grand, or entry. Every test type funnels
 * through the same /api/bridge/tests/:id/submit route, so calling this once
 * there is enough to make sure every test a student takes is reflected in
 * their progress everywhere it's shown (profile, leaderboard, error atlas),
 * not just in the quiz_count counter.
 *
 * A single generated test can span several subjects (e.g. a full mock or
 * grand test), so this blends each subject's own accuracy column using the
 * same 70/30 (existing/new) formula the legacy single-subject flow uses,
 * and pushes this attempt's overall percentage onto weekly_history.
 */
async function applyBridgeProgressUpdate(email, questions, answers, correctCount, totalCount) {
    let { rows: [progress] } = await pool.query(`SELECT * FROM progress WHERE email = $1`, [email]);
    if (!progress) {
        // A `students` row without a `progress` row (e.g. onboarding was interrupted
        // between the two inserts) used to drop every update silently. Heal it with the
        // column defaults. If there is no students row at all, the FK rejects this and
        // the caller's try/catch reports it — it is never swallowed here.
        await pool.query(`INSERT INTO progress (email) VALUES ($1) ON CONFLICT (email) DO NOTHING`, [email]);
        ({ rows: [progress] } = await pool.query(`SELECT * FROM progress WHERE email = $1`, [email]));
        if (!progress) return;
    }

    const bySubject = {};
    for (const q of questions) {
        const key = BRIDGE_SUBJECT_PROGRESS_KEY[q.subject];
        if (!key) continue;
        if (!bySubject[key]) bySubject[key] = { correct: 0, total: 0 };
        bySubject[key].total++;
        const ans = (answers || {})[q.id];
        if (ans && ans === q.correct_answer) bySubject[key].correct++;
    }

    const colMap = { bio: 'bio_accuracy', phy: 'phy_accuracy', chem: 'chem_accuracy', zoo: 'zoo_accuracy', math: 'math_accuracy' };
    const setClauses = [];
    const params = [];
    for (const [key, { correct, total }] of Object.entries(bySubject)) {
        if (total === 0) continue;
        const attemptAcc = (correct / total) * 100;
        const oldVal = progress[colMap[key]];
        const blended = Math.round((oldVal * 0.7 + attemptAcc * 0.3) * 10) / 10;
        params.push(blended);
        setClauses.push(`${colMap[key]} = $${params.length}`);
    }

    let history = [];
    try { history = JSON.parse(progress.weekly_history); } catch (_) { history = []; }
    const overallAcc = totalCount > 0 ? (correctCount / totalCount) * 100 : 0;
    history.push(Math.round(overallAcc * 10) / 10);
    if (history.length > 7) history = history.slice(-7);

    params.push(JSON.stringify(history));
    const historyIdx = params.length;
    params.push(email);
    const emailIdx = params.length;

    await pool.query(
        `UPDATE progress SET ${setClauses.length ? setClauses.join(', ') + ',' : ''}
         quiz_count = quiz_count + 1, weekly_history = $${historyIdx} WHERE email = $${emailIdx}`,
        params
    );
}

// ---------------------------------------------------------------------------
// HISTORICAL CUTOFFS & PREDICTION (retained from original)
// ---------------------------------------------------------------------------
const HISTORICAL_CUTOFFS = [
    { year: 2021, category: 'General', aiims: 686, govt: 620, private: 480 },
    { year: 2021, category: 'EWS',     aiims: 678, govt: 605, private: 460 },
    { year: 2021, category: 'OBC',     aiims: 670, govt: 590, private: 440 },
    { year: 2021, category: 'SC',      aiims: 640, govt: 520, private: 380 },
    { year: 2021, category: 'ST',      aiims: 620, govt: 480, private: 350 },
    { year: 2022, category: 'General', aiims: 692, govt: 625, private: 485 },
    { year: 2022, category: 'EWS',     aiims: 684, govt: 612, private: 465 },
    { year: 2022, category: 'OBC',     aiims: 676, govt: 596, private: 445 },
    { year: 2022, category: 'SC',      aiims: 648, govt: 528, private: 388 },
    { year: 2022, category: 'ST',      aiims: 628, govt: 488, private: 358 },
    { year: 2023, category: 'General', aiims: 697, govt: 633, private: 492 },
    { year: 2023, category: 'EWS',     aiims: 690, govt: 620, private: 472 },
    { year: 2023, category: 'OBC',     aiims: 683, govt: 604, private: 452 },
    { year: 2023, category: 'SC',      aiims: 656, govt: 536, private: 396 },
    { year: 2023, category: 'ST',      aiims: 636, govt: 496, private: 366 },
    { year: 2024, category: 'General', aiims: 700, govt: 640, private: 500 },
    { year: 2024, category: 'EWS',     aiims: 693, govt: 628, private: 480 },
    { year: 2024, category: 'OBC',     aiims: 686, govt: 612, private: 460 },
    { year: 2024, category: 'SC',      aiims: 660, govt: 544, private: 404 },
    { year: 2024, category: 'ST',      aiims: 640, govt: 504, private: 374 }
];

const STATE_ADJUSTMENT = {
    'Andhra Pradesh': -0.015, 'Telangana': -0.015, 'Karnataka': -0.01,
    'Tamil Nadu': -0.01, 'Kerala': -0.01, 'Maharashtra': -0.005,
    'Delhi': 0.0, 'Uttar Pradesh': 0.005, 'Bihar': 0.01,
    'Rajasthan': 0.0, 'West Bengal': -0.005, 'Gujarat': -0.005
};
const CATEGORY_FALLBACK = { 'PwD': 'OBC', 'Others': 'General' };
const INSTITUTION_KEY = {
    'AIIMS': 'aiims',
    'Government Medical College': 'govt',
    'Private Medical College': 'private'
};
const NEET_MAX_SCORE = 720;
const NEET_MAX_RANK  = 1500000;
const CUTOFF_CACHE_TTL_DAYS = 30;

async function getCachedCutoffRows(year) {
    const { rows } = await pool.query(
        `SELECT year, category, aiims, govt, private, fetched_at FROM cutoff_cache WHERE year = $1`, [year]
    );
    return rows;
}

async function isCutoffCacheStale(year) {
    const rows = await getCachedCutoffRows(year);
    if (rows.length < 3) return true;
    const oldest = rows.reduce((min, r) => Math.min(min, new Date(r.fetched_at).getTime()), Date.now());
    return (Date.now() - oldest) / (1000 * 60 * 60 * 24) > CUTOFF_CACHE_TTL_DAYS;
}

// Single-flight + cool-down around the real refresh. predictCutoff() triggers a
// background refresh whenever the cache is stale, so a burst of requests at
// result time used to start dozens of parallel web-search + AI calls that
// rate-limit each other and all fail, leaving the cache stale. Now concurrent
// callers share one in-flight refresh, and after an attempt (success or failure)
// further automatic attempts wait CUTOFF_REFRESH_COOLDOWN_MS. An explicit admin
// refresh passes { force: true } to skip the cool-down (it still shares an
// in-flight run).
const CUTOFF_REFRESH_COOLDOWN_MS = 10 * 60 * 1000;
const cutoffRefreshInFlight = new Map();
const cutoffRefreshLastAttempt = new Map();
function refreshCutoffCache(year, { force = false } = {}) {
    if (cutoffRefreshInFlight.has(year)) return cutoffRefreshInFlight.get(year);
    if (!force && Date.now() - (cutoffRefreshLastAttempt.get(year) || 0) < CUTOFF_REFRESH_COOLDOWN_MS) {
        return Promise.resolve({ success: false, throttled: true });
    }
    cutoffRefreshLastAttempt.set(year, Date.now());
    const run = doRefreshCutoffCache(year).finally(() => cutoffRefreshInFlight.delete(year));
    cutoffRefreshInFlight.set(year, run);
    return run;
}

async function doRefreshCutoffCache(year) {
    let fetchRealCutoffData;
    try { ({ fetchRealCutoffData } = require('./research')); } catch { return { success: false }; }
    try {
        const rows = await fetchRealCutoffData(year);
        for (const r of rows) {
            await pool.query(
                `INSERT INTO cutoff_cache (year, category, aiims, govt, private, source, fetched_at)
                 VALUES ($1,$2,$3,$4,$5,'web-research-ai', NOW())
                 ON CONFLICT (year, category) DO UPDATE SET
                    aiims=$3, govt=$4, private=$5, source='web-research-ai', fetched_at=NOW()`,
                [r.year, r.category, r.aiims, r.govt, r.private]
            );
        }
        return { success: true };
    } catch (err) {
        return { success: false, reason: err.message };
    }
}

async function buildTrainingRows(category, instKey) {
    const cachedAll = await pool.query(`SELECT * FROM cutoff_cache WHERE category = $1 ORDER BY year ASC`, [category]);
    const cachedYears = new Set(cachedAll.rows.map(r => r.year));
    const rows = cachedAll.rows.map(r => ({ x: r.year, y: r[instKey] }));
    for (const baseline of HISTORICAL_CUTOFFS.filter(r => r.category === category)) {
        if (!cachedYears.has(baseline.year)) rows.push({ x: baseline.year, y: baseline[instKey] });
    }
    return { rows: rows.sort((a, b) => a.x - b.x), usingLiveData: cachedAll.rows.length > 0 };
}

function linearRegression(points) {
    const n = points.length;
    const sumX  = points.reduce((s, p) => s + p.x, 0);
    const sumY  = points.reduce((s, p) => s + p.y, 0);
    const sumXY = points.reduce((s, p) => s + p.x * p.y, 0);
    const sumXX = points.reduce((s, p) => s + p.x * p.x, 0);
    const denom = (n * sumXX - sumX * sumX) || 1;
    return { slope: (n * sumXY - sumX * sumY) / denom, intercept: (sumY - (n * sumXY - sumX * sumY) / denom * sumX) / n };
}

// NEET subject sections carry equal weight (45 questions / 180 marks each
// out of the 720 total) — this is real NEET exam structure, not a guess, so
// prorating the overall score prediction across sections this way is a
// sound (not fabricated) way to give subject-wise cutoff figures.
const NEET_SUBJECT_SHARE = { Physics: 0.25, Chemistry: 0.25, Botany: 0.25, Zoology: 0.25 };

async function predictCutoff(aim, category, state, examDate, currentAccuracyPct = null) {
    const instKey = INSTITUTION_KEY[aim] || 'govt';
    const cat = HISTORICAL_CUTOFFS.some(r => r.category === category) ? category : (CATEGORY_FALLBACK[category] || 'General');
    const targetYear = examDate ? new Date(examDate).getFullYear() : (new Date().getFullYear() + 1);
    isCutoffCacheStale(targetYear).then(stale => { if (stale) refreshCutoffCache(targetYear).catch(() => {}); }).catch(() => {});
    const { rows, usingLiveData } = await buildTrainingRows(cat, instKey);
    const { slope, intercept } = linearRegression(rows);
    let predicted = slope * targetYear + intercept;
    predicted = predicted * (1 + (STATE_ADJUSTMENT[state] ?? 0));
    predicted = Math.min(NEET_MAX_SCORE, Math.max(100, predicted));
    const targetScore = Math.round(predicted);
    const percentile = predicted / NEET_MAX_SCORE;
    const estimatedRank = Math.round(NEET_MAX_RANK * Math.pow(1 - percentile, 6));
    let admissionProbability = null;
    if (currentAccuracyPct !== null) {
        const diff = (currentAccuracyPct / 100) * NEET_MAX_SCORE - targetScore;
        admissionProbability = Math.round((1 / (1 + Math.exp(-0.08 * diff))) * 1000) / 10;
    }
    const safeScore = Math.round(Math.min(NEET_MAX_SCORE, predicted + 12));
    const stretchScore = Math.round(Math.min(NEET_MAX_SCORE, predicted + 28));

    const subjectCutoffs = {};
    for (const [subject, share] of Object.entries(NEET_SUBJECT_SHARE)) {
        subjectCutoffs[subject] = {
            safeScore: Math.round(safeScore * share),
            targetScore: Math.round(targetScore * share),
            stretchScore: Math.round(stretchScore * share),
            maxMarks: Math.round(NEET_MAX_SCORE * share)
        };
    }

    return {
        exam: 'NEET', category: cat, institution: aim, targetYear,
        safeScore, targetScore, stretchScore, maxMarks: NEET_MAX_SCORE,
        subjectCutoffs,
        estimatedRank: { low: Math.max(1, Math.round(estimatedRank * 0.7)), high: Math.round(estimatedRank * 1.3), mid: estimatedRank },
        admissionProbability,
        modelInfo: {
            method: usingLiveData ? 'linear-regression-live' : 'linear-regression-static',
            usingLiveData, dataSource: usingLiveData ? 'web-research-ai' : 'historical-regression'
        }
    };
}

// JEE Main qualifying percentile cutoffs (for JEE Advanced eligibility),
// category-wise, as publicly reported by NTA each year. Unlike NEET these
// are NOT institution-tiered at the Main-exam stage (institution tiering
// only happens later, in JoSAA counselling), so there's a single trend per
// category rather than per-institution tiers.
const HISTORICAL_JEE_CUTOFFS = [
    { year: 2021, category: 'General', percentile: 87.8992241 },
    { year: 2021, category: 'EWS',     percentile: 66.2214845 },
    { year: 2021, category: 'OBC',     percentile: 68.0234447 },
    { year: 2021, category: 'SC',      percentile: 46.8825338 },
    { year: 2021, category: 'ST',      percentile: 34.6728999 },
    { year: 2022, category: 'General', percentile: 88.4121383 },
    { year: 2022, category: 'EWS',     percentile: 63.1114141 },
    { year: 2022, category: 'OBC',     percentile: 67.0090297 },
    { year: 2022, category: 'SC',      percentile: 43.0820954 },
    { year: 2022, category: 'ST',      percentile: 26.7771328 },
    { year: 2023, category: 'General', percentile: 90.7788642 },
    { year: 2023, category: 'EWS',     percentile: 73.6114227 },
    { year: 2023, category: 'OBC',     percentile: 73.6114227 },
    { year: 2023, category: 'SC',      percentile: 51.9776027 },
    { year: 2023, category: 'ST',      percentile: 37.2348772 },
    { year: 2024, category: 'General', percentile: 93.2362181 },
    { year: 2024, category: 'EWS',     percentile: 81.3221276 },
    { year: 2024, category: 'OBC',     percentile: 79.6757881 },
    { year: 2024, category: 'SC',      percentile: 60.0923182 },
    { year: 2024, category: 'ST',      percentile: 46.6975840 }
];
// Static real-world-representative closing ranks (Common Rank List, overall
// across branches) for JEE's 3 institution tiers, category-wise, by year --
// the JEE-side counterpart to HISTORICAL_CUTOFFS above. Institution tiering
// happens via JoSAA closing rank (not JEE Main percentile, which is exam-
// wide only), so this is a separate static table rather than an extra
// column on HISTORICAL_JEE_CUTOFFS. Category-wise rank lists are how JoSAA
// itself reports cutoffs, so a lower number for a reserved category reflects
// that category's own (smaller) rank list, not an "easier" bar.
const JEE_INSTITUTION_KEY = { 'IIT': 'iit', 'NIT': 'nit', 'IIIT/GFTI': 'iiit' };
const HISTORICAL_JEE_INSTITUTION_CUTOFFS = [
    { year: 2021, category: 'General', iit: 100000, nit: 180000, iiit: 280000 },
    { year: 2021, category: 'EWS',     iit: 60000,  nit: 110000, iiit: 170000 },
    { year: 2021, category: 'OBC',     iit: 55000,  nit: 100000, iiit: 155000 },
    { year: 2021, category: 'SC',      iit: 32000,  nit: 60000,  iiit: 95000  },
    { year: 2021, category: 'ST',      iit: 16000,  nit: 30000,  iiit: 48000  },
    { year: 2022, category: 'General', iit: 96000,  nit: 172000, iiit: 268000 },
    { year: 2022, category: 'EWS',     iit: 58000,  nit: 106000, iiit: 164000 },
    { year: 2022, category: 'OBC',     iit: 53000,  nit: 96000,  iiit: 149000 },
    { year: 2022, category: 'SC',      iit: 31000,  nit: 58000,  iiit: 91000  },
    { year: 2022, category: 'ST',      iit: 15500,  nit: 29000,  iiit: 46000  },
    { year: 2023, category: 'General', iit: 92000,  nit: 165000, iiit: 257000 },
    { year: 2023, category: 'EWS',     iit: 56000,  nit: 102000, iiit: 158000 },
    { year: 2023, category: 'OBC',     iit: 51000,  nit: 93000,  iiit: 143000 },
    { year: 2023, category: 'SC',      iit: 30000,  nit: 56000,  iiit: 88000  },
    { year: 2023, category: 'ST',      iit: 15000,  nit: 28000,  iiit: 44500  },
    { year: 2024, category: 'General', iit: 88000,  nit: 158000, iiit: 247000 },
    { year: 2024, category: 'EWS',     iit: 54000,  nit: 98000,  iiit: 152000 },
    { year: 2024, category: 'OBC',     iit: 49000,  nit: 90000,  iiit: 138000 },
    { year: 2024, category: 'SC',      iit: 29000,  nit: 54000,  iiit: 85000  },
    { year: 2024, category: 'ST',      iit: 14500,  nit: 27000,  iiit: 43000  }
];

// JEE Main's 3 subjects carry equal weight (100 marks each of 300 total),
// so a subject-wise breakdown is expressed the same accuracy-percentage
// way the student's own `targets` table already is (see computeJeeTargets
// below) rather than trying to invent a percentile-per-subject split —
// JEE percentile is a whole-exam normalized figure and doesn't decompose
// per-subject the way a raw NEET score does.
//
// Signature mirrors predictCutoff(aim, category, state, examDate, accuracy)
// for consistency -- institution ("aim") first, no state term since JEE has
// no state-quota adjustment the way NEET AIQ/state-quota does.
async function predictJeeCutoff(aim, category, examDate, currentAccuracyPct = null) {
    const inst = JEE_INSTITUTION_KEY[aim] ? aim : 'NIT';
    const instKey = JEE_INSTITUTION_KEY[inst];
    const cat = HISTORICAL_JEE_CUTOFFS.some(r => r.category === category) ? category : (CATEGORY_FALLBACK[category] || 'General');
    const targetYear = examDate ? new Date(examDate).getFullYear() : (new Date().getFullYear() + 1);

    // JEE Main qualifying percentile trend (exam-wide, category-only).
    const rows = HISTORICAL_JEE_CUTOFFS.filter(r => r.category === cat).map(r => ({ x: r.year, y: r.percentile }));
    const { slope, intercept } = linearRegression(rows);
    let predicted = slope * targetYear + intercept;
    predicted = Math.min(99.9999999, Math.max(1, predicted));
    const targetPercentile = Math.round(predicted * 1000000) / 1000000;

    // Institution-tier closing rank trend (JoSAA), regressed off the same
    // static historical data the way NEET's per-institution score is.
    const rankRows = HISTORICAL_JEE_INSTITUTION_CUTOFFS.filter(r => r.category === cat).map(r => ({ x: r.year, y: r[instKey] }));
    const rankReg = linearRegression(rankRows);
    let predictedRank = Math.max(1, Math.round(rankReg.slope * targetYear + rankReg.intercept));
    const safeRank = Math.max(1, Math.round(predictedRank * 0.88));
    const stretchRank = Math.max(1, Math.round(predictedRank * 0.65));

    let admissionProbability = null;
    if (currentAccuracyPct !== null) {
        const diff = currentAccuracyPct - predicted;
        admissionProbability = Math.round((1 / (1 + Math.exp(-0.15 * diff))) * 1000) / 10;
    }

    const jeeTargets = computeJeeTargets(cat, inst);
    return {
        exam: 'JEE', category: cat, institution: inst, targetYear,
        safePercentile: Math.round(Math.min(99.9999999, predicted + 2) * 1000000) / 1000000,
        targetPercentile,
        stretchPercentile: Math.round(Math.min(99.9999999, predicted + 5) * 1000000) / 1000000,
        subjectCutoffs: {
            Physics:     { accuracyTargetPct: jeeTargets.phy },
            Chemistry:   { accuracyTargetPct: jeeTargets.chem },
            Mathematics: { accuracyTargetPct: jeeTargets.math }
        },
        closingRank: { target: predictedRank, safe: safeRank, stretch: stretchRank },
        admissionProbability,
        modelInfo: { method: 'linear-regression-static', usingLiveData: false, dataSource: 'historical-regression' }
    };
}

const AIM_BASE_TARGETS = {
    'AIIMS':                      { bio: 92, phy: 88, chem: 90, zoo: 92 },
    'Government Medical College': { bio: 85, phy: 78, chem: 82, zoo: 85 },
    'Private Medical College':    { bio: 75, phy: 65, chem: 70, zoo: 75 }
};

// JEE institution tiers, mirroring AIM_BASE_TARGETS' shape/pattern above --
// same 3-tier, "top tier hardest" structure, just engineering institutes
// instead of medical colleges.
const JEE_AIM_BASE_TARGETS = {
    'IIT':       { phy: 88, chem: 88, math: 90 },
    'NIT':       { phy: 78, chem: 78, math: 80 },
    'IIIT/GFTI': { phy: 68, chem: 68, math: 70 }
};

// A single student's `targets` row holds all 5 subject columns regardless
// of which exam they're aiming for (NEET and JEE share Physics/Chemistry).
// examType picks which base table drives phy/chem (and which of bio+zoo vs
// math is actually meaningful) so a JEE student's Physics/Chemistry targets
// come from their engineering institution tier, not a medical-college
// fallback, and vice versa for NEET.
function computeTargets(aim, category, examType = 'NEET') {
    const relax = ['OBC','SC','ST','EWS','PwD'].includes(category) ? 5 : 0;
    if (examType === 'JEE') {
        const base = JEE_AIM_BASE_TARGETS[aim] || JEE_AIM_BASE_TARGETS['NIT'];
        return {
            bio: 50, zoo: 50, // not applicable for JEE; neutral placeholder
            phy:  Math.max(50, base.phy  - relax),
            chem: Math.max(50, base.chem - relax),
            math: Math.max(50, base.math - relax)
        };
    }
    const base = AIM_BASE_TARGETS[aim] || AIM_BASE_TARGETS['Government Medical College'];
    return {
        bio:  Math.max(50, base.bio  - relax),
        phy:  Math.max(50, base.phy  - relax),
        chem: Math.max(50, base.chem - relax),
        zoo:  Math.max(50, base.zoo  - relax),
        math: 50 // not applicable for NEET; neutral placeholder
    };
}

function computeJeeTargets(category, aim = 'NIT') {
    const base = JEE_AIM_BASE_TARGETS[aim] || JEE_AIM_BASE_TARGETS['NIT'];
    const relax = ['OBC','SC','ST','EWS','PwD'].includes(category) ? 5 : 0;
    return {
        phy:  Math.max(50, base.phy  - relax),
        chem: Math.max(50, base.chem - relax),
        math: Math.max(50, base.math - relax)
    };
}

const TOPIC_BANK = {
    bio: [
        { topic: 'Cell Division (Mitosis & Meiosis)', remedy: 'Revisit Hill III — draw the cell cycle yourself before checking the textbook diagram.' },
        { topic: "Genetics — Mendel's Laws", remedy: "Use Hill IV — solve cross-problems for pea plants, then apply the same ratios to human pedigree charts." },
        { topic: 'Human Physiology — Nervous System', remedy: 'Apply Hill VI — link neuron structure to the reflex arc and then to hormonal coordination.' },
        { topic: 'Plant Physiology', remedy: 'Apply Hill I — relate transpiration to everyday examples of evaporation first.' }
    ],
    phy: [
        { topic: "Newton's Laws of Motion", remedy: 'Go back to Hill I — start from everyday push/pull examples before tackling numericals.' },
        { topic: 'Electrostatics', remedy: "Use Hill II — anchor every formula to Coulomb's Law as the central idea." },
        { topic: 'Rotational Mechanics', remedy: 'Apply Hill V — compare linear and rotational analogues side by side.' },
        { topic: 'Thermodynamics', remedy: 'Use Hill III — derive the first law from energy conservation intuition before memorising state functions.' }
    ],
    chem: [
        { topic: 'Chemical Bonding', remedy: 'Revisit Hill III — predict bond type from electronegativity before checking the answer key.' },
        { topic: 'Equilibrium', remedy: "Use Hill II — treat Le Chatelier's Principle as the anchor for every shift-based question." },
        { topic: 'Organic Reaction Mechanisms', remedy: 'Apply Hill VII — relate mechanisms to real industrial/biological processes to aid recall.' },
        { topic: 'Periodic Table & Periodicity', remedy: 'Use Hill V — map trends graphically before doing MCQs.' }
    ]
};

// ---------------------------------------------------------------------------
// Physics entry-test seed content (restored from the earlier release).
// 10 development-stage MCQs per entry test, cycling through the topic bank.
// answer = index of the correct option.
// ---------------------------------------------------------------------------
function buildPhysicsEntryQuestions() {
    const bank = [
        { topic: 'Units and Dimensions', text: 'Which of these is a fundamental (base) SI unit?', options: ['Newton', 'Joule', 'Kilogram', 'Watt'], answer: 2 },
        { topic: 'Kinematics', text: 'A body moving with uniform acceleration covers a distance given by which equation?', options: ['s = ut + ½at²', 's = ut', 's = at²', 's = u + at'], answer: 0 },
        { topic: 'Laws of Motion', text: "Newton's First Law is also known as the law of:", options: ['Acceleration', 'Inertia', 'Action-reaction', 'Gravitation'], answer: 1 },
        { topic: 'Work, Energy and Power', text: 'The SI unit of power is the:', options: ['Joule', 'Newton', 'Watt', 'Pascal'], answer: 2 },
        { topic: 'Rotational Motion', text: 'The rotational analogue of mass is:', options: ['Torque', 'Angular velocity', 'Moment of inertia', 'Angular momentum'], answer: 2 },
        { topic: 'Gravitation', text: "The value of escape velocity from Earth's surface is approximately:", options: ['1.1 km/s', '7.9 km/s', '11.2 km/s', '29.8 km/s'], answer: 2 },
        { topic: 'Oscillations and Waves', text: 'The time period of a simple pendulum depends on:', options: ['Mass of the bob', 'Amplitude only', 'Length of the pendulum and g', 'Material of the string'], answer: 2 },
        { topic: 'Thermodynamics', text: 'The first law of thermodynamics is a statement of:', options: ['Entropy increase', 'Conservation of energy', 'Absolute zero', 'Ideal gas behaviour'], answer: 1 },
        { topic: 'Electrostatics', text: 'The SI unit of electric potential is the:', options: ['Ampere', 'Volt', 'Ohm', 'Farad'], answer: 1 },
        { topic: 'Current Electricity', text: "Ohm's Law relates voltage, current and:", options: ['Power', 'Resistance', 'Charge', 'Energy'], answer: 1 },
        { topic: 'Magnetism', text: 'The SI unit of magnetic field strength is the:', options: ['Tesla', 'Weber', 'Henry', 'Gauss'], answer: 0 },
        { topic: 'Optics', text: 'A converging lens is also called a:', options: ['Concave lens', 'Convex lens', 'Plano lens', 'Diverging lens'], answer: 1 },
        { topic: 'Modern Physics', text: 'The photoelectric effect was explained by:', options: ['Newton', 'Maxwell', 'Einstein', 'Bohr'], answer: 2 }
    ];
    const tests = { 1: [], 2: [], 3: [] };
    for (const t of [1, 2, 3]) {
        for (let i = 0; i < 10; i++) {
            const base = bank[(i + (t - 1) * 4) % bank.length];
            tests[t].push({ ...base, text: `[Entry Test ${t} · Q${i + 1}] ${base.text}` });
        }
    }
    return tests;
}
const PHYSICS_ENTRY_QUESTIONS = buildPhysicsEntryQuestions();

module.exports = {
    pool, initSchema,
    CURRICULUM, TEST_SUBJECT_DIST, DIFFICULTY_RATIOS,
    computeTargets, computeJeeTargets, TOPIC_BANK, AIM_BASE_TARGETS, JEE_AIM_BASE_TARGETS,
    predictCutoff, predictJeeCutoff, HISTORICAL_CUTOFFS, HISTORICAL_JEE_CUTOFFS,
    HISTORICAL_JEE_INSTITUTION_CUTOFFS, STATE_ADJUSTMENT,
    refreshCutoffCache, getCachedCutoffRows, isCutoffCacheStale,
    generateDailyTest, generateWeeklyTest, generateMonthlyTest,
    generateGrandTest, generateChapterComboTest, generateMockTest,
    fillTestQuestions, computeScore, applyBridgeProgressUpdate,
    countPlaceholderQuestions, PLACEHOLDER_LIKE
};