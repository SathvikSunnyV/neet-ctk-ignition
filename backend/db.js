// db.js — CTK BRIDGE COURSE  |  PostgreSQL edition
// Expanded from NEET CTK IGNITION to support both NEET & JEE,
// centralized question bank, all test types, and faculty approval workflow.

const { Pool } = require('pg');

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
    `);

    // Seed chapters
    await seedChapters();

    // Seed question bank with dummy questions
    await seedQuestionBank();

    // Pre-generate entry tests
    await seedEntryTests();

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
    const { rows } = await pool.query(`SELECT COUNT(*) AS c FROM chapters`);
    if (parseInt(rows[0].c, 10) > 0) return;

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
    console.log('✅  Seeded chapters for NEET & JEE');
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
// GENERATE ENTRY TESTS (3 per course, fixed for all students)
// ---------------------------------------------------------------------------
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
                // offset by testNum so each entry test gets different questions
                const { rows: questions } = await pool.query(
                    `SELECT id FROM question_bank
                     WHERE course_type = $1 AND subject = $2 AND status = 'approved'
                     ORDER BY id
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
 * Generate a Grand Test (every 3 months, comprehensive).
 */
async function generateGrandTest(courseType, label, studentEmail = null) {
    const { rows: [gt] } = await pool.query(
        `INSERT INTO generated_tests (test_type, course_type, title, difficulty_mode, question_count, time_limit_min)
         VALUES ('grand', $1, $2, 'Mixed', 90, 180) RETURNING id`,
        [courseType, `${courseType} Grand Test — ${label}`]
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
    return {
        category: cat, institution: aim, targetYear,
        safeScore: Math.round(Math.min(NEET_MAX_SCORE, predicted + 12)),
        targetScore,
        stretchScore: Math.round(Math.min(NEET_MAX_SCORE, predicted + 28)),
        estimatedRank: { low: Math.max(1, Math.round(estimatedRank * 0.7)), high: Math.round(estimatedRank * 1.3), mid: estimatedRank },
        admissionProbability,
        modelInfo: { method: usingLiveData ? 'linear-regression-live' : 'linear-regression-static', usingLiveData }
    };
}

const AIM_BASE_TARGETS = {
    'AIIMS':                      { bio: 92, phy: 88, chem: 90 },
    'Government Medical College': { bio: 85, phy: 78, chem: 82 },
    'Private Medical College':    { bio: 75, phy: 65, chem: 70 }
};

function computeTargets(aim, category) {
    const base = AIM_BASE_TARGETS[aim] || AIM_BASE_TARGETS['Government Medical College'];
    const relax = ['OBC','SC','ST','EWS','PwD'].includes(category) ? 5 : 0;
    return {
        bio:  Math.max(50, base.bio  - relax),
        phy:  Math.max(50, base.phy  - relax),
        chem: Math.max(50, base.chem - relax)
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
    computeTargets, TOPIC_BANK, AIM_BASE_TARGETS,
    predictCutoff, HISTORICAL_CUTOFFS, STATE_ADJUSTMENT,
    refreshCutoffCache, getCachedCutoffRows, isCutoffCacheStale,
    generateDailyTest, generateWeeklyTest, generateMonthlyTest,
    generateGrandTest, generateChapterComboTest, generateMockTest,
    fillTestQuestions, computeScore
};