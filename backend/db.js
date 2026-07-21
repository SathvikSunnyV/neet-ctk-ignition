// db.js — CTK BRIDGE COURSE  |  PostgreSQL edition
// Expanded from NEET CTK IGNITION to support both NEET & JEE,
// centralized question bank, all test types, and faculty approval workflow.

const { Pool } = require('pg');
const { REAL_IMPORTED_QUESTIONS } = require('./real_imported_questions');

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

    // Seed chapters
    await seedChapters();

    // Seed question bank with dummy questions
    await seedQuestionBank();

    // Import real Bridge Course questions (Physics/Chemistry/Botany/Zoology)
    await importRealQuestions();

    // Pre-generate entry tests
    await seedEntryTests();

    // If entry tests already existed from before the import above, rebuild
    // them so they draw from the real questions instead of dummy ones
    await migrateEntryTestsToRealQuestions();

    // Seed default admin
    const { rows: adminRows } = await pool.query(`SELECT id FROM users WHERE role = 'admin' LIMIT 1`);
    if (adminRows.length === 0) {
        const bcrypt = require('bcryptjs');
        const defaultPass = process.env.DEFAULT_ADMIN_PASSWORD || 'ctk-admin-2026';
        const hash = await bcrypt.hash(defaultPass, 10);
        await pool.query(
            `INSERT INTO users (name, email, password_hash, role, is_verified, onboarding_done)
             VALUES ('CTK Admin', $1, $2, 'admin', TRUE, TRUE) ON CONFLICT (email) DO NOTHING`,
            [process.env.DEFAULT_ADMIN_EMAIL || 'admin@ctkbridge.com', hash]
        );
        console.log(`ℹ️  Seeded default admin: ${process.env.DEFAULT_ADMIN_EMAIL || 'admin@ctkbridge.com'} / ${defaultPass}`);
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
    const { rows: [{ c }] } = await pool.query(
        `SELECT COUNT(*) AS c FROM question_bank WHERE subtopic = 'bridge_course_import'`
    );
    if (parseInt(c, 10) > 0) return; // already imported

    const CHUNK = 200;
    for (let i = 0; i < REAL_IMPORTED_QUESTIONS.length; i += CHUNK) {
        const chunk = REAL_IMPORTED_QUESTIONS.slice(i, i + CHUNK);
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
    console.log(`✅  Imported ${REAL_IMPORTED_QUESTIONS.length} real Bridge Course questions (Physics/Chemistry/Botany/Zoology)`);
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
    const { rows: [{ c }] } = await pool.query(`
        SELECT COUNT(*) AS c
        FROM entry_tests et
        JOIN generated_test_questions gtq ON gtq.test_id = et.test_id
        JOIN question_bank qb ON qb.id = gtq.question_id
        WHERE qb.subtopic = 'bridge_course_import'
    `);
    if (parseInt(c, 10) > 0) return; // already using real questions

    const { rows: ets } = await pool.query(`SELECT test_id FROM entry_tests`);
    if (ets.length === 0) return; // nothing generated yet — seedEntryTests() will handle it fresh

    const testIds = ets.map(r => r.test_id);
    await pool.query(`DELETE FROM generated_test_questions WHERE test_id = ANY($1::int[])`, [testIds]);
    await pool.query(`DELETE FROM entry_tests`);
    await pool.query(`DELETE FROM generated_tests WHERE id = ANY($1::int[])`, [testIds]);

    await seedEntryTests();
    console.log('✅  Regenerated entry tests using real Bridge Course questions');
}

async function seedEntryTests() {
    const { rows } = await pool.query(`SELECT COUNT(*) AS c FROM entry_tests`);
    if (parseInt(rows[0].c, 10) > 0) return;

    for (const courseType of ['NEET','JEE']) {
        for (let testNum = 1; testNum <= 3; testNum++) {
            // Create the generated_test record
            const { rows: [gt] } = await pool.query(
                `INSERT INTO generated_tests (test_type, course_type, title, difficulty_mode, question_count, time_limit_min)
                 VALUES ('entry', $1, $2, 'Mixed', 90, 180) RETURNING id`,
                [courseType, `${courseType} Entry Test ${testNum} — Baseline Assessment`]
            );
            const testId = gt.id;

            // Pick 90 approved questions, balanced across subjects, low overlap between tests
            const dist = TEST_SUBJECT_DIST[courseType];
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
    console.log('✅  Pre-generated 3 entry tests each for NEET & JEE');
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
             ORDER BY usage_count ASC, RANDOM() LIMIT $${baseParams.length + 2}`,
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
             ORDER BY usage_count ASC, RANDOM() LIMIT $${topUpParams.length}`,
            topUpParams
        );
        return unseen.concat(topUp);
    }

    const params = [...baseParams, limit];
    const { rows } = await pool.query(
        `SELECT id FROM question_bank
         WHERE course_type = $1 AND subject = $2 ${diffClause} AND status = 'approved'
         ${chapterClause}
         ORDER BY usage_count ASC, RANDOM() LIMIT $${params.length}`,
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
    const neetEquivScore = Math.round((rawScore / totalMax) * 720);
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
    const { rows: [progress] } = await pool.query(`SELECT * FROM progress WHERE email = $1`, [email]);
    if (!progress) return;

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

async function refreshCutoffCache(year) {
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
const JEE_ESTIMATED_CANDIDATES = 1200000; // approx annual JEE Main candidate pool

// JEE Main's 3 subjects carry equal weight (100 marks each of 300 total),
// so a subject-wise breakdown is expressed the same accuracy-percentage
// way the student's own `targets` table already is (see computeJeeTargets
// below) rather than trying to invent a percentile-per-subject split —
// JEE percentile is a whole-exam normalized figure and doesn't decompose
// per-subject the way a raw NEET score does.
async function predictJeeCutoff(category, examDate, currentAccuracyPct = null) {
    const cat = HISTORICAL_JEE_CUTOFFS.some(r => r.category === category) ? category : (CATEGORY_FALLBACK[category] || 'General');
    const targetYear = examDate ? new Date(examDate).getFullYear() : (new Date().getFullYear() + 1);
    const rows = HISTORICAL_JEE_CUTOFFS.filter(r => r.category === cat).map(r => ({ x: r.year, y: r.percentile }));
    const { slope, intercept } = linearRegression(rows);
    let predicted = slope * targetYear + intercept;
    predicted = Math.min(99.9999999, Math.max(1, predicted));
    const targetPercentile = Math.round(predicted * 1000000) / 1000000;
    const estimatedRank = Math.max(1, Math.round(JEE_ESTIMATED_CANDIDATES * (1 - predicted / 100)));

    let admissionProbability = null;
    if (currentAccuracyPct !== null) {
        const diff = currentAccuracyPct - predicted;
        admissionProbability = Math.round((1 / (1 + Math.exp(-0.15 * diff))) * 1000) / 10;
    }

    const jeeTargets = computeJeeTargets(cat);
    return {
        exam: 'JEE', category: cat, targetYear,
        safePercentile: Math.round(Math.min(99.9999999, predicted + 2) * 1000000) / 1000000,
        targetPercentile,
        stretchPercentile: Math.round(Math.min(99.9999999, predicted + 5) * 1000000) / 1000000,
        subjectCutoffs: {
            Physics:     { accuracyTargetPct: jeeTargets.phy },
            Chemistry:   { accuracyTargetPct: jeeTargets.chem },
            Mathematics: { accuracyTargetPct: jeeTargets.math }
        },
        estimatedRank: { low: Math.max(1, Math.round(estimatedRank * 0.7)), high: Math.round(estimatedRank * 1.3), mid: estimatedRank },
        admissionProbability,
        modelInfo: { method: 'linear-regression-static', usingLiveData: false, dataSource: 'historical-regression' }
    };
}

const AIM_BASE_TARGETS = {
    'AIIMS':                      { bio: 92, phy: 88, chem: 90, zoo: 92 },
    'Government Medical College': { bio: 85, phy: 78, chem: 82, zoo: 85 },
    'Private Medical College':    { bio: 75, phy: 65, chem: 70, zoo: 75 }
};

// JEE has no institution-tier "aim" field in onboarding (JEE Main qualifying
// cutoffs are category-wise only, not institution-tiered — tiering only
// happens later in JoSAA counselling), so this is a single flat baseline
// adjusted by category, mirroring the NEET relax logic below.
const JEE_BASE_TARGETS = { phy: 80, chem: 78, math: 82 };

function computeTargets(aim, category) {
    const base = AIM_BASE_TARGETS[aim] || AIM_BASE_TARGETS['Government Medical College'];
    const relax = ['OBC','SC','ST','EWS','PwD'].includes(category) ? 5 : 0;
    return {
        bio:  Math.max(50, base.bio  - relax),
        phy:  Math.max(50, base.phy  - relax),
        chem: Math.max(50, base.chem - relax),
        zoo:  Math.max(50, base.zoo  - relax),
        math: Math.max(50, JEE_BASE_TARGETS.math - relax)
    };
}

function computeJeeTargets(category) {
    const relax = ['OBC','SC','ST','EWS','PwD'].includes(category) ? 5 : 0;
    return {
        phy:  Math.max(50, JEE_BASE_TARGETS.phy  - relax),
        chem: Math.max(50, JEE_BASE_TARGETS.chem - relax),
        math: Math.max(50, JEE_BASE_TARGETS.math - relax)
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

module.exports = {
    pool, initSchema,
    CURRICULUM, TEST_SUBJECT_DIST, DIFFICULTY_RATIOS,
    computeTargets, computeJeeTargets, TOPIC_BANK, AIM_BASE_TARGETS,
    predictCutoff, predictJeeCutoff, HISTORICAL_CUTOFFS, HISTORICAL_JEE_CUTOFFS, STATE_ADJUSTMENT,
    refreshCutoffCache, getCachedCutoffRows, isCutoffCacheStale,
    generateDailyTest, generateWeeklyTest, generateMonthlyTest,
    generateGrandTest, generateChapterComboTest, generateMockTest,
    fillTestQuestions, computeScore, applyBridgeProgressUpdate
};