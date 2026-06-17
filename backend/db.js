// db.js — NEET CTK IGNITION  |  PostgreSQL edition
// Replaces better-sqlite3 with `pg` (node-postgres).
// All queries are async; the pool is exported and used directly in server.js.

const { Pool } = require('pg');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL && !process.env.DATABASE_URL.includes('localhost')
        ? { rejectUnauthorized: false }
        : false
});

// ---------------------------------------------------------------------------
// SCHEMA — run once at startup (idempotent)
// ---------------------------------------------------------------------------
async function initSchema() {
    // -----------------------------------------------------------------
    // AUTH: users table (Student / Faculty / Admin)
    // -----------------------------------------------------------------
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

        -- simple in-DB rate limiting for OTP / login attempts
        CREATE TABLE IF NOT EXISTS auth_attempts (
            id          SERIAL PRIMARY KEY,
            email       TEXT NOT NULL,
            kind        TEXT NOT NULL, -- 'login' | 'otp' | 'reset'
            created_at  TIMESTAMPTZ DEFAULT NOW()
        );
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS students (
            email       TEXT PRIMARY KEY,
            name        TEXT NOT NULL,
            phone       TEXT,
            category    TEXT,
            aim         TEXT,
            exam_date   TEXT,
            target_institution  TEXT,
            state               TEXT,
            current_class       TEXT,
            daily_study_hours   REAL,
            prep_level          TEXT,
            target_exam         TEXT DEFAULT 'NEET',
            created_at  TIMESTAMPTZ DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS progress (
            email           TEXT PRIMARY KEY REFERENCES students(email) ON DELETE CASCADE,
            bio_accuracy    REAL DEFAULT 40,
            phy_accuracy    REAL DEFAULT 35,
            chem_accuracy   REAL DEFAULT 38,
            quiz_count      INTEGER DEFAULT 0,
            weekly_history  TEXT DEFAULT '[40,40,40,40,40,40,40]'
        );

        CREATE TABLE IF NOT EXISTS targets (
            email   TEXT PRIMARY KEY REFERENCES students(email) ON DELETE CASCADE,
            bio     REAL,
            phy     REAL,
            chem    REAL
        );

        CREATE TABLE IF NOT EXISTS lectures (
            id              SERIAL PRIMARY KEY,
            title           TEXT NOT NULL,
            subject         TEXT NOT NULL,
            url             TEXT NOT NULL,
            lecturer_name   TEXT NOT NULL,
            approved        INTEGER DEFAULT 0,
            created_at      TIMESTAMPTZ DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS feedback (
            id          SERIAL PRIMARY KEY,
            message     TEXT NOT NULL,
            created_at  TIMESTAMPTZ DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS settings (
            key     TEXT PRIMARY KEY,
            value   TEXT
        );

        -- Faculty profile (linked to users)
        CREATE TABLE IF NOT EXISTS faculty (
            email       TEXT PRIMARY KEY REFERENCES users(email) ON DELETE CASCADE,
            name        TEXT NOT NULL,
            department  TEXT,
            created_at  TIMESTAMPTZ DEFAULT NOW()
        );

        -- Faculty-created tests
        CREATE TABLE IF NOT EXISTS tests (
            id              SERIAL PRIMARY KEY,
            title           TEXT NOT NULL,
            subject         TEXT NOT NULL,
            chapter         TEXT,
            difficulty      TEXT DEFAULT 'Medium',
            time_limit_min  INTEGER DEFAULT 30,
            negative_marking BOOLEAN DEFAULT FALSE,
            randomize       BOOLEAN DEFAULT FALSE,
            scheduled_at    TIMESTAMPTZ,
            created_by      TEXT REFERENCES faculty(email) ON DELETE SET NULL,
            created_at      TIMESTAMPTZ DEFAULT NOW()
        );

        -- Questions belonging to a test (MCQ or fill-in-the-blank)
        CREATE TABLE IF NOT EXISTS test_questions (
            id              SERIAL PRIMARY KEY,
            test_id         INTEGER REFERENCES tests(id) ON DELETE CASCADE,
            q_type          TEXT NOT NULL DEFAULT 'mcq' CHECK (q_type IN ('mcq','fill_blank')),
            question_text   TEXT NOT NULL,
            options         JSONB,          -- for MCQ: array of option strings
            correct_answer  TEXT NOT NULL,  -- option index (as string) for MCQ, or expected text for fill-in
            topic           TEXT,
            subtopic        TEXT,
            concept         TEXT,
            difficulty      TEXT DEFAULT 'Medium',
            position        INTEGER DEFAULT 0
        );

        -- Student attempts at a test
        CREATE TABLE IF NOT EXISTS test_attempts (
            id              SERIAL PRIMARY KEY,
            test_id         INTEGER REFERENCES tests(id) ON DELETE CASCADE,
            student_email   TEXT REFERENCES students(email) ON DELETE CASCADE,
            answers         JSONB,
            score           REAL,
            total           INTEGER,
            submitted_at    TIMESTAMPTZ DEFAULT NOW()
        );

        -- Per-question mistake log (feeds the Mistake Analysis Engine)
        CREATE TABLE IF NOT EXISTS mistakes (
            id              SERIAL PRIMARY KEY,
            student_email   TEXT REFERENCES students(email) ON DELETE CASCADE,
            test_id         INTEGER REFERENCES tests(id) ON DELETE SET NULL,
            question_id     INTEGER,
            subject         TEXT,
            topic           TEXT,
            subtopic        TEXT,
            concept         TEXT,
            difficulty      TEXT,
            mistake_type    TEXT, -- 'conceptual' | 'calculation' | 'memory' | 'unattempted'
            created_at      TIMESTAMPTZ DEFAULT NOW()
        );

        -- Live-researched NEET cutoff data (replaces static guesses once
        -- populated). One row per (year, category). Refreshed periodically
        -- by research.js via free web search + free LLM extraction.
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

        -- Faculty-uploaded study materials (PDFs, PPTs, DOCX, images, or
        -- YouTube/external links). File bytes are stored directly in
        -- Postgres (bytea) so they survive redeploys on free hosting tiers
        -- that have an ephemeral filesystem.
        CREATE TABLE IF NOT EXISTS materials (
            id              SERIAL PRIMARY KEY,
            title           TEXT NOT NULL,
            subject         TEXT NOT NULL,
            chapter         TEXT,
            material_type   TEXT NOT NULL DEFAULT 'file' CHECK (material_type IN ('file','link')),
            file_name       TEXT,
            mime_type       TEXT,
            file_size       INTEGER,
            file_data       BYTEA,
            external_url    TEXT,
            description     TEXT,
            uploaded_by     TEXT REFERENCES faculty(email) ON DELETE SET NULL,
            created_at      TIMESTAMPTZ DEFAULT NOW()
        );

        -- ===================================================================
        -- PHYSICS STUDENT MODULE (additive — see README "Physics Student
        -- Module" section). The platform's curriculum-aligned subjects keep
        -- working exactly as before; these tables add a dedicated,
        -- Physics-curated experience: entry diagnostics, Term-organised
        -- materials, granular lecture/material progress, and per-student
        -- test assignment.
        -- ===================================================================

        -- The 3 fixed Physics entry-level diagnostics (Test 1 mandatory).
        CREATE TABLE IF NOT EXISTS physics_entry_tests (
            test_number     INTEGER PRIMARY KEY CHECK (test_number IN (1,2,3)),
            title           TEXT NOT NULL,
            mandatory       BOOLEAN NOT NULL DEFAULT FALSE
        );

        -- Questions belonging to each entry test (seeded with 10 dummy MCQs
        -- per test for development purposes, per the spec).
        CREATE TABLE IF NOT EXISTS physics_entry_questions (
            id              SERIAL PRIMARY KEY,
            test_number     INTEGER NOT NULL REFERENCES physics_entry_tests(test_number) ON DELETE CASCADE,
            topic           TEXT NOT NULL,
            question_text   TEXT NOT NULL,
            options         JSONB NOT NULL,
            correct_answer  INTEGER NOT NULL,
            position        INTEGER DEFAULT 0
        );

        -- A student's attempt at an entry test, including the topic-wise
        -- breakdown and the resulting proficiency classification.
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

        -- Granular lecture-watch tracking (percentage watched + resume
        -- position), one row per student per lecture.
        CREATE TABLE IF NOT EXISTS lecture_progress (
            student_email           TEXT REFERENCES students(email) ON DELETE CASCADE,
            lecture_id              INTEGER REFERENCES lectures(id) ON DELETE CASCADE,
            percent_watched         REAL DEFAULT 0,
            last_position_seconds   INTEGER DEFAULT 0,
            completed               BOOLEAN DEFAULT FALSE,
            updated_at              TIMESTAMPTZ DEFAULT NOW(),
            PRIMARY KEY (student_email, lecture_id)
        );

        -- Material view / download / completion tracking, one row per
        -- student per material (feeds the Physics Progress Tracking System).
        CREATE TABLE IF NOT EXISTS material_progress (
            student_email   TEXT REFERENCES students(email) ON DELETE CASCADE,
            material_id     INTEGER REFERENCES materials(id) ON DELETE CASCADE,
            viewed          BOOLEAN DEFAULT FALSE,
            downloaded      BOOLEAN DEFAULT FALSE,
            completed       BOOLEAN DEFAULT FALSE,
            updated_at      TIMESTAMPTZ DEFAULT NOW(),
            PRIMARY KEY (student_email, material_id)
        );

        -- Optional per-student/per-group test assignment. A test with NO
        -- rows here remains visible to every student (preserves existing
        -- behaviour for tests created before this feature existed); a test
        -- WITH rows here becomes visible only to the assigned students.
        CREATE TABLE IF NOT EXISTS test_assignments (
            test_id         INTEGER REFERENCES tests(id) ON DELETE CASCADE,
            student_email   TEXT REFERENCES students(email) ON DELETE CASCADE,
            group_name      TEXT,
            assigned_at     TIMESTAMPTZ DEFAULT NOW(),
            PRIMARY KEY (test_id, student_email)
        );
    `);

    // -----------------------------------------------------------------
    // MIGRATIONS for pre-existing 'students' table (added columns)
    // -----------------------------------------------------------------
    await pool.query(`
        ALTER TABLE students ADD COLUMN IF NOT EXISTS target_institution TEXT;
        ALTER TABLE students ADD COLUMN IF NOT EXISTS state TEXT;
        ALTER TABLE students ADD COLUMN IF NOT EXISTS current_class TEXT;
        ALTER TABLE students ADD COLUMN IF NOT EXISTS daily_study_hours REAL;
        ALTER TABLE students ADD COLUMN IF NOT EXISTS prep_level TEXT;
        ALTER TABLE students ADD COLUMN IF NOT EXISTS target_exam TEXT DEFAULT 'NEET';
        ALTER TABLE students ADD COLUMN IF NOT EXISTS physics_proficiency TEXT;
    `);

    // -----------------------------------------------------------------
    // MIGRATIONS for pre-existing 'materials' table — Term tagging
    // (Term 1 / Term 2 / Term 3) for the Physics Student Module, and a
    // 'note' material_type so curated text content (not just files/links)
    // can be published per topic/term.
    // -----------------------------------------------------------------
    await pool.query(`
        ALTER TABLE materials ADD COLUMN IF NOT EXISTS term INTEGER;
        ALTER TABLE materials DROP CONSTRAINT IF EXISTS materials_material_type_check;
        ALTER TABLE materials ADD CONSTRAINT materials_material_type_check CHECK (material_type IN ('file','link','note'));
    `);

    // Add a foreign-key style soft link from students.email -> users.email
    // (kept soft / no FK constraint to avoid breaking pre-existing rows
    //  created before the users table existed).

    // Seed exam date if missing
    const { rows } = await pool.query(`SELECT value FROM settings WHERE key = 'exam_date'`);
    if (rows.length === 0) {
        const d = new Date();
        d.setMonth(d.getMonth() + 8);
        await pool.query(
            `INSERT INTO settings (key, value) VALUES ('exam_date', $1) ON CONFLICT DO NOTHING`,
            [d.toISOString().split('T')[0]]
        );
    }

    // Seed approved lectures if table is empty
    const { rows: lRows } = await pool.query(`SELECT COUNT(*) AS c FROM lectures`);
    if (parseInt(lRows[0].c, 10) === 0) {
        await pool.query(`
            INSERT INTO lectures (title, subject, url, lecturer_name, approved) VALUES
            ('Human Reproduction - High Yield Revision', 'Biology',   'https://www.youtube.com/embed/UMo7dUNGkQo', 'Dr. Meera Sharma',   1),
            ('Thermodynamics - Connecting Concepts',     'Physics',   'https://www.youtube.com/embed/4i1MUWJoI0U', 'Prof. Anil Kapoor',  1),
            ('Chemical Bonding - VSEPR & Hybridisation', 'Chemistry', 'https://www.youtube.com/embed/v=uVBSBFxbUlA', 'Dr. Priya Nair',    1)
        `);
    }

    // -----------------------------------------------------------------
    // PHYSICS STUDENT MODULE — seed the 3 entry tests + dummy questions
    // -----------------------------------------------------------------
    const { rows: entryTestRows } = await pool.query(`SELECT COUNT(*) AS c FROM physics_entry_tests`);
    if (parseInt(entryTestRows[0].c, 10) === 0) {
        await pool.query(`
            INSERT INTO physics_entry_tests (test_number, title, mandatory) VALUES
            (1, 'Physics Entry Test 1 — Foundation Diagnostic', TRUE),
            (2, 'Physics Entry Test 2 — Extended Diagnostic',   FALSE),
            (3, 'Physics Entry Test 3 — Advanced Diagnostic',   FALSE)
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
        console.log('✅  Seeded 3 Physics entry tests (10 dummy MCQs each)');
    }

    // -----------------------------------------------------------------
    // PHYSICS STUDENT MODULE — seed Term 1 / Term 2 / Term 3 materials
    // for every Physics topic (published as 'note' type materials, owned
    // by the platform rather than a specific faculty account).
    // -----------------------------------------------------------------
    const { rows: physicsNoteRows } = await pool.query(
        `SELECT COUNT(*) AS c FROM materials WHERE subject = 'Physics' AND material_type = 'note'`
    );
    if (parseInt(physicsNoteRows[0].c, 10) === 0) {
        const TERM_LABEL = { 1: 'Conceptual Understanding', 2: 'Definitions & Formulae', 3: 'Advanced Applications' };
        for (const topic of PHYSICS_TOPICS) {
            const content = PHYSICS_TERM_CONTENT[topic];
            if (!content) continue;
            for (const term of [1, 2, 3]) {
                await pool.query(
                    `INSERT INTO materials (title, subject, chapter, material_type, description, term)
                     VALUES ($1,'Physics',$2,'note',$3,$4)`,
                    [`${topic} — Term ${term}: ${TERM_LABEL[term]}`, topic, content[term], term]
                );
            }
        }
        console.log(`✅  Seeded Term 1–3 Physics materials for ${PHYSICS_TOPICS.length} topics`);
    }

    // Seed a default admin account if none exists
    const { rows: adminRows } = await pool.query(`SELECT id FROM users WHERE role = 'admin' LIMIT 1`);
    if (adminRows.length === 0) {
        const bcrypt = require('bcryptjs');
        const defaultPass = process.env.DEFAULT_ADMIN_PASSWORD || 'ctk-admin-2026';
        const hash = await bcrypt.hash(defaultPass, 10);
        await pool.query(
            `INSERT INTO users (name, email, password_hash, role, is_verified, onboarding_done)
             VALUES ('CTK Admin', $1, $2, 'admin', TRUE, TRUE) ON CONFLICT (email) DO NOTHING`,
            [process.env.DEFAULT_ADMIN_EMAIL || 'admin@neetctk.com', hash]
        );
        console.log(`ℹ️  Seeded default admin: ${process.env.DEFAULT_ADMIN_EMAIL || 'admin@neetctk.com'} / ${defaultPass}`);
    }

    console.log('✅  Database schema ready');
}

// ---------------------------------------------------------------------------
// QUESTION BANK  (Level-1 topic-wise quiz, mixed subjects)
// answer = index of correct option (never sent to the client)
// ---------------------------------------------------------------------------
const QUESTIONS = [
    {
        id: 1, subject: 'Biology', topic: 'Cell Division',
        text: "Which organelle is known as the 'powerhouse of the cell'?",
        options: ['Nucleus', 'Mitochondria', 'Ribosome', 'Golgi Body'],
        answer: 1
    },
    {
        id: 2, subject: 'Biology', topic: "Genetics – Mendel's Laws",
        text: "Mendel's Law of Independent Assortment applies to genes located on:",
        options: ['The same chromosome', 'Different chromosomes', 'The same locus', 'mRNA strands'],
        answer: 1
    },
    {
        id: 3, subject: 'Biology', topic: 'Human Physiology – Digestion',
        text: 'Which enzyme in saliva begins the digestion of starch?',
        options: ['Pepsin', 'Lipase', 'Salivary amylase', 'Trypsin'],
        answer: 2
    },
    {
        id: 4, subject: 'Biology', topic: 'Plant Physiology',
        text: 'The process by which plants lose water through their leaves is called:',
        options: ['Respiration', 'Transpiration', 'Photosynthesis', 'Osmosis'],
        answer: 1
    },
    {
        id: 5, subject: 'Physics', topic: "Newton's Laws of Motion",
        text: "Newton's Second Law of Motion is mathematically expressed as:",
        options: ['F = ma', 'F = mv', 'F = m/a', 'F = a/m'],
        answer: 0
    },
    {
        id: 6, subject: 'Physics', topic: 'Electrostatics',
        text: 'The SI unit of electric potential is:',
        options: ['Ampere', 'Volt', 'Ohm', 'Watt'],
        answer: 1
    },
    {
        id: 7, subject: 'Physics', topic: 'Optics',
        text: 'A convex lens is also known as a:',
        options: ['Diverging lens', 'Converging lens', 'Concave lens', 'Plano lens'],
        answer: 1
    },
    {
        id: 8, subject: 'Physics', topic: 'Thermodynamics',
        text: 'The first law of thermodynamics is essentially a statement of:',
        options: ['Entropy', 'Conservation of energy', 'Absolute zero', 'Ideal gas behaviour'],
        answer: 1
    },
    {
        id: 9, subject: 'Chemistry', topic: 'Chemical Bonding',
        text: 'A chemical bond formed by the complete transfer of electrons between atoms is called:',
        options: ['Covalent bond', 'Ionic bond', 'Metallic bond', 'Hydrogen bond'],
        answer: 1
    },
    {
        id: 10, subject: 'Chemistry', topic: 'Equilibrium',
        text: 'The pH of a neutral aqueous solution at 25°C is:',
        options: ['0', '7', '14', '1'],
        answer: 1
    },
    {
        id: 11, subject: 'Chemistry', topic: 'Periodic Table',
        text: 'Which group of the periodic table contains the alkali metals?',
        options: ['Group 1', 'Group 2', 'Group 17', 'Group 18'],
        answer: 0
    },
    {
        id: 12, subject: 'Chemistry', topic: 'Organic Chemistry – Hydrocarbons',
        text: 'The IUPAC name of CH₃–CH₂–CH₃ is:',
        options: ['Methane', 'Ethane', 'Propane', 'Butane'],
        answer: 2
    }
];

// ---------------------------------------------------------------------------
// FALLBACK BASELINE — NEET cutoff data (2021-2024, NEET out of 720)
// Used ONLY when the live `cutoff_cache` table (populated via real web
// search + AI extraction, see research.js) has no usable data yet — e.g.
// first run before any refresh has succeeded, or if the deployment
// environment has no outbound internet/AI access. Once real data is
// cached, this baseline is ignored.
// ---------------------------------------------------------------------------
const HISTORICAL_CUTOFFS = [
    // year, category, AIIMS_closing, GovtMedical_closing, PrivateMedical_closing
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

// State-level adjustment factors (state quota seats are typically easier
// to secure than All-India quota at the same institution tier). Applied as
// a small percentage shift to the All-India figures above.
const STATE_ADJUSTMENT = {
    'Andhra Pradesh': -0.015, 'Telangana': -0.015, 'Karnataka': -0.01,
    'Tamil Nadu': -0.01, 'Kerala': -0.01, 'Maharashtra': -0.005,
    'Delhi': 0.0, 'Uttar Pradesh': 0.005, 'Bihar': 0.01,
    'Rajasthan': 0.0, 'West Bengal': -0.005, 'Gujarat': -0.005,
    'Madhya Pradesh': 0.005, 'Punjab': 0.0, 'Haryana': 0.0
};

// PwD is treated like the relaxation applied to OBC for fallback purposes
const CATEGORY_FALLBACK = { 'PwD': 'OBC', 'Others': 'General' };

const INSTITUTION_KEY = {
    'AIIMS': 'aiims',
    'Government Medical College': 'govt',
    'Private Medical College': 'private'
};

const NEET_MAX_SCORE = 720;
const NEET_MAX_RANK  = 1500000; // approx All-India candidates

// How long cached real-data stays "fresh" before a background refresh is
// attempted again (cutoffs only change once a year, around results time,
// but we re-check periodically in case of corrections/updates).
const CUTOFF_CACHE_TTL_DAYS = 30;

/**
 * Reads cached real cutoff rows from the DB for a given year.
 * Returns [] if nothing cached yet for that year.
 */
async function getCachedCutoffRows(year) {
    const { rows } = await pool.query(
        `SELECT year, category, aiims, govt, private, fetched_at FROM cutoff_cache WHERE year = $1`,
        [year]
    );
    return rows;
}

/**
 * Returns true if the cache for this year is missing or stale enough to
 * warrant a refresh attempt.
 */
async function isCutoffCacheStale(year) {
    const rows = await getCachedCutoffRows(year);
    if (rows.length < 3) return true; // not enough categories cached
    const oldest = rows.reduce((min, r) => Math.min(min, new Date(r.fetched_at).getTime()), Date.now());
    const ageDays = (Date.now() - oldest) / (1000 * 60 * 60 * 24);
    return ageDays > CUTOFF_CACHE_TTL_DAYS;
}

/**
 * Attempts a real-data refresh for the given year using research.js
 * (free web search + free LLM extraction) and writes successful rows
 * into cutoff_cache. Safe to call frequently — it no-ops on failure.
 */
async function refreshCutoffCache(year) {
    let fetchRealCutoffData;
    try {
        ({ fetchRealCutoffData } = require('./research'));
    } catch (err) {
        return { success: false, reason: 'research module unavailable' };
    }

    try {
        const rows = await fetchRealCutoffData(year);
        for (const r of rows) {
            await pool.query(
                `INSERT INTO cutoff_cache (year, category, aiims, govt, private, source, fetched_at)
                 VALUES ($1,$2,$3,$4,$5,'web-research-ai', NOW())
                 ON CONFLICT (year, category) DO UPDATE SET
                    aiims = $3, govt = $4, private = $5, source = 'web-research-ai', fetched_at = NOW()`,
                [r.year, r.category, r.aiims, r.govt, r.private]
            );
        }
        console.log(`✅  Cutoff cache refreshed for ${year} (${rows.length} categories, live web data)`);
        return { success: true, rowCount: rows.length };
    } catch (err) {
        console.warn(`⚠️  Cutoff cache refresh failed for ${year}: ${err.message} — using existing cache / static baseline.`);
        return { success: false, reason: err.message };
    }
}

/**
 * Builds the regression training set for a (category, institution),
 * preferring real cached data and only filling in gaps from the static
 * baseline if a given year has no cached entry at all. Also reports
 * whether any live-fetched rows were actually used.
 */
async function buildTrainingRows(category, instKey) {
    const cachedAll = await pool.query(`SELECT * FROM cutoff_cache WHERE category = $1 ORDER BY year ASC`, [category]);
    const cachedYears = new Set(cachedAll.rows.map(r => r.year));

    const rows = cachedAll.rows.map(r => ({ x: r.year, y: r[instKey] }));

    // Fill in any years missing from the cache using the static baseline,
    // so the regression always has enough points even on a partial cache.
    for (const baseline of HISTORICAL_CUTOFFS.filter(r => r.category === category)) {
        if (!cachedYears.has(baseline.year)) {
            rows.push({ x: baseline.year, y: baseline[instKey] });
        }
    }

    return { rows: rows.sort((a, b) => a.x - b.x), usingLiveData: cachedAll.rows.length > 0 };
}

/**
 * Simple linear regression: returns {slope, intercept} for y = slope*x + intercept
 */
function linearRegression(points) {
    const n = points.length;
    const sumX  = points.reduce((s, p) => s + p.x, 0);
    const sumY  = points.reduce((s, p) => s + p.y, 0);
    const sumXY = points.reduce((s, p) => s + p.x * p.y, 0);
    const sumXX = points.reduce((s, p) => s + p.x * p.x, 0);
    const denom = (n * sumXX - sumX * sumX) || 1;
    const slope = (n * sumXY - sumX * sumY) / denom;
    const intercept = (sumY - slope * sumX) / n;
    return { slope, intercept };
}

/**
 * AI-based cutoff & rank prediction — now backed by REAL, periodically
 * refreshed web data (see research.js / cutoff_cache) rather than a fixed
 * table. Falls back to a static historical baseline only where live data
 * is not yet available for a given year, so the feature degrades
 * gracefully but always prefers real numbers when present.
 *
 * @param {string} aim       - 'AIIMS' | 'Government Medical College' | 'Private Medical College'
 * @param {string} category  - 'General' | 'EWS' | 'OBC' | 'SC' | 'ST' | 'PwD' | 'Others'
 * @param {string} state
 * @param {string|Date} examDate
 * @param {number} [currentAccuracyPct] - student's current average accuracy (0-100), optional
 */
async function predictCutoff(aim, category, state, examDate, currentAccuracyPct = null) {
    const instKey = INSTITUTION_KEY[aim] || 'govt';
    const cat = HISTORICAL_CUTOFFS.some(r => r.category === category)
        ? category
        : (CATEGORY_FALLBACK[category] || 'General');

    const targetYear = examDate ? new Date(examDate).getFullYear() : (new Date().getFullYear() + 1);

    // Kick off a background refresh if the cache looks stale — don't block
    // this request on it; the next request will benefit from fresh data.
    isCutoffCacheStale(targetYear).then(stale => {
        if (stale) refreshCutoffCache(targetYear).catch(() => {});
    }).catch(() => {});

    const { rows, usingLiveData } = await buildTrainingRows(cat, instKey);

    const { slope, intercept } = linearRegression(rows);

    let predicted = slope * targetYear + intercept;

    // Apply state quota adjustment
    const stateAdj = STATE_ADJUSTMENT[state] ?? 0;
    predicted = predicted * (1 + stateAdj);

    // Clamp to plausible NEET score range
    predicted = Math.min(NEET_MAX_SCORE, Math.max(100, predicted));

    const targetScore  = Math.round(predicted);
    const safeScore    = Math.round(Math.min(NEET_MAX_SCORE, predicted + 12)); // small buffer for safety margin
    const stretchScore = Math.round(Math.min(NEET_MAX_SCORE, predicted + 28)); // ambitious goal

    // Estimated rank: approximate inverse relationship between score and
    // All-India rank, anchored using the historical General/AIIMS top-rank
    // benchmark (~700/720 ≈ rank 1) and a percentile decay model.
    const percentile = predicted / NEET_MAX_SCORE;
    const estimatedRank = Math.round(NEET_MAX_RANK * Math.pow(1 - percentile, 6));
    const rankLow  = Math.max(1, Math.round(estimatedRank * 0.7));
    const rankHigh = Math.round(estimatedRank * 1.3);

    // Admission probability based on how the student's current trajectory
    // (accuracy-derived projected score) compares to the predicted cutoff.
    let admissionProbability = null;
    if (currentAccuracyPct !== null && !Number.isNaN(currentAccuracyPct)) {
        const projectedScore = (currentAccuracyPct / 100) * NEET_MAX_SCORE;
        const diff = projectedScore - targetScore;
        // logistic curve centred on the target score
        const k = 0.08;
        admissionProbability = Math.round((1 / (1 + Math.exp(-k * diff))) * 1000) / 10;
    }

    return {
        category: cat,
        institution: aim,
        targetYear,
        safeScore,
        targetScore,
        stretchScore,
        estimatedRank: { low: rankLow, high: rankHigh, mid: estimatedRank },
        admissionProbability,
        modelInfo: {
            method: usingLiveData
                ? 'linear-regression-on-live-web-researched-cutoffs'
                : 'linear-regression-on-static-baseline (live data not yet fetched)',
            dataSource: usingLiveData ? 'web-research-ai' : 'static-baseline',
            trainingPoints: rows.length,
            slope: Math.round(slope * 100) / 100,
            stateAdjustmentPct: Math.round(stateAdj * 1000) / 10
        }
    };
}


const AIM_BASE_TARGETS = {
    'AIIMS':                      { bio: 92, phy: 88, chem: 90 },
    'Government Medical College': { bio: 85, phy: 78, chem: 82 },
    'Private Medical College':    { bio: 75, phy: 65, chem: 70 }
};

const RESERVED_CATEGORIES = ['OBC', 'SC', 'ST', 'EWS', 'PwD'];

function computeTargets(aim, category) {
    const base = AIM_BASE_TARGETS[aim] || AIM_BASE_TARGETS['Government Medical College'];
    const relax = RESERVED_CATEGORIES.includes(category) ? 5 : 0;
    return {
        bio:  Math.max(50, base.bio  - relax),
        phy:  Math.max(50, base.phy  - relax),
        chem: Math.max(50, base.chem - relax)
    };
}

// ---------------------------------------------------------------------------
// ERROR ATLAS — topic → remedial mapping per subject
// ---------------------------------------------------------------------------
const TOPIC_BANK = {
    bio: [
        { topic: 'Cell Division (Mitosis & Meiosis)', remedy: 'Revisit Hill III (Let the Student Discover) — draw the cell cycle yourself before checking the textbook diagram.' },
        { topic: "Genetics — Mendel's Laws",          remedy: "Use Hill IV (One Key, Many Doors) — solve cross-problems for pea plants, then apply the same ratios to human pedigree charts." },
        { topic: 'Human Physiology — Nervous System', remedy: 'Apply Hill VI (Build Connections) — link neuron structure to the reflex arc and then to hormonal coordination.' },
        { topic: 'Plant Physiology',                  remedy: 'Apply Hill I (Known to Unknown) — relate transpiration to everyday examples of evaporation first.' }
    ],
    phy: [
        { topic: "Newton's Laws of Motion", remedy: 'Go back to Hill I (Known to Unknown) — start from everyday push/pull examples before tackling numericals.' },
        { topic: 'Electrostatics',          remedy: "Use Hill II (Central Point) — anchor every formula to Coulomb's Law as the central idea." },
        { topic: 'Rotational Mechanics',    remedy: 'Apply Hill V (Recognise Patterns) — compare linear and rotational analogues side by side.' },
        { topic: 'Thermodynamics',          remedy: 'Use Hill III (Discover) — derive the first law from energy conservation intuition before memorising state functions.' }
    ],
    chem: [
        { topic: 'Chemical Bonding',               remedy: 'Revisit Hill III — predict bond type from electronegativity before checking the answer key.' },
        { topic: 'Equilibrium',                    remedy: "Use Hill II (Central Point) — treat Le Chatelier's Principle as the anchor for every shift-based question." },
        { topic: 'Organic Reaction Mechanisms',    remedy: 'Apply Hill VII (Real-World Wisdom) — relate mechanisms to real industrial/biological processes to aid recall.' },
        { topic: 'Periodic Table & Periodicity',   remedy: 'Use Hill V (Patterns) — map trends (atomic radius, ionisation energy) graphically before doing MCQs.' }
    ]
};

// ===========================================================================
// PHYSICS STUDENT MODULE — additive constants
// (entry diagnostics, Term-organised materials, proficiency classification)
// ===========================================================================

// Canonical Physics topic list, as specified in the Physics Student Module
// requirements. Used for entry-test question tagging, Term-based material
// organisation, and topic-wise analytics.
const PHYSICS_TOPICS = [
    'Units and Dimensions',
    'Kinematics',
    'Laws of Motion',
    'Work, Energy and Power',
    'Rotational Motion',
    'Gravitation',
    'Oscillations and Waves',
    'Thermodynamics',
    'Electrostatics',
    'Current Electricity',
    'Magnetism',
    'Optics',
    'Modern Physics'
];

// Term 1 (Conceptual Understanding) / Term 2 (Definitions & Formulae) /
// Term 3 (Advanced Applications) seed content for every Physics topic.
// This is starter content, intended to demonstrate the three-stage
// learning model end-to-end — faculty can add further file/link materials
// per topic/term from the Lecturer Hub at any time.
const PHYSICS_TERM_CONTENT = {
    'Units and Dimensions': {
        1: "Every physical quantity is built from a few base quantities — length, mass, time, and others. Dimensional analysis lets you check whether an equation could possibly be correct just by tracking these building blocks, without doing any arithmetic.",
        2: "Dimensional formula notation: [M^a L^b T^c …]. SI base units: metre (m), kilogram (kg), second (s), ampere (A), kelvin (K), mole (mol), candela (cd). Principle of homogeneity: only quantities with the same dimensions can be added, subtracted, or equated.",
        3: "Use dimensional analysis to check whether a formula (e.g. T = 2π√(l/g)) is dimensionally a time, to derive how one quantity depends on others up to a dimensionless constant, and to convert between unit systems in multi-step numericals."
    },
    'Kinematics': {
        1: "Kinematics describes how position changes with time, independent of what causes the motion. Velocity tells you how fast position changes; acceleration tells you how fast velocity changes — think of a car speeding up, not why the engine pushes it.",
        2: "v = u + at, s = ut + ½at², v² = u² + 2as (uniform acceleration). Relative velocity: v_AB = v_A − v_B. Projectile motion: range R = u²sin2θ/g, max height H = u²sin²θ/2g, time of flight T = 2u sinθ/g.",
        3: "Apply the kinematic equations to multi-stage motion (e.g. a ball thrown up and later caught), combine projectile motion with relative velocity (river–boat problems), and read acceleration/displacement from the slope/area of v-t and x-t graphs."
    },
    'Laws of Motion': {
        1: "Newton's three laws explain why objects keep moving, speed up, or stop. A body resists changes to its motion (inertia); a net push or pull is needed to change that motion; and every push has an equal push back.",
        2: "First law: a body remains at rest or in uniform motion unless acted on by a net external force. Second law: F = dp/dt = ma. Third law: F_AB = −F_BA. Friction: f = μN (limiting static friction ≥ kinetic friction).",
        3: "Solve connected-block and pulley systems using free-body diagrams, analyse motion on inclined planes with friction, and apply circular-motion force balance (tension or friction supplying the centripetal force)."
    },
    'Work, Energy and Power': {
        1: "Work is done when a force causes displacement. Energy is the capacity to do work, and it doesn't disappear — it just changes form, like kinetic energy converting to potential energy as a ball rises.",
        2: "W = F·s·cosθ. KE = ½mv². Gravitational PE = mgh. Work-energy theorem: W_net = ΔKE. Power: P = W/t = F·v. Conservation of mechanical energy: KE + PE = constant when no non-conservative force acts.",
        3: "Apply energy conservation to pendulum and spring-block problems, use the work-energy theorem to find speeds without solving for acceleration directly, and compute power output on inclined planes with friction."
    },
    'Rotational Motion': {
        1: "Just as linear motion has mass, velocity, and force, rotational motion has moment of inertia, angular velocity, and torque — each rotational quantity is a direct analogue of a linear one.",
        2: "Torque: τ = r × F. Moment of inertia: disc = ½MR², ring = MR², rod about centre = ML²/12. Angular momentum: L = Iω. Rotational KE = ½Iω². Parallel axis theorem: I = I_cm + Md².",
        3: "Solve rolling-without-slipping problems (combining translational and rotational KE), apply conservation of angular momentum (e.g. a figure skater pulling arms in), and find moment of inertia for composite bodies."
    },
    'Gravitation': {
        1: "Every mass attracts every other mass. The same force that pulls an apple down keeps the Moon orbiting the Earth — gravity is universal and follows one simple rule based on mass and distance.",
        2: "F = Gm₁m₂/r². g = GM/R². Orbital velocity: v = √(GM/r). Escape velocity: v_e = √(2GM/R). Kepler's third law: T² ∝ r³. Gravitational potential energy: U = −GMm/r.",
        3: "Calculate satellite orbital periods and energies, find how g varies with height and depth, and apply Kepler's laws to compare planetary or satellite orbits."
    },
    'Oscillations and Waves': {
        1: "Oscillations are repetitive back-and-forth motion around a stable point, like a swing settling into a rhythm. Waves are how that disturbance travels outward through a medium without the medium itself travelling along.",
        2: "SHM: x = A sin(ωt + φ); T = 2π√(m/k) for a spring, T = 2π√(l/g) for a pendulum. Wave speed: v = fλ. Beats: f_beat = |f₁ − f₂|. Doppler effect: f' = f(v ± v_o)/(v ∓ v_s).",
        3: "Analyse spring-mass and pendulum systems for changes in time period, solve standing-wave and resonance problems in strings and pipes, and apply the Doppler effect to moving-source/observer numericals."
    },
    'Thermodynamics': {
        1: "Thermodynamics tracks energy as heat and work flow into or out of a system. The first law is simply energy conservation applied to heat engines, while entropy describes which processes happen naturally on their own.",
        2: "First law: ΔQ = ΔU + ΔW. Ideal gas law: PV = nRT. Cp − Cv = R. Carnot efficiency: η = 1 − T_cold/T_hot. Adiabatic process: PV^γ = constant.",
        3: "Apply the first law to isothermal, adiabatic, isochoric and isobaric processes on a P-V diagram, find work done as the area under the curve, and compute Carnot efficiency given reservoir temperatures."
    },
    'Electrostatics': {
        1: "Electric charge creates a field around itself that pushes or pulls other charges, similar to how mass creates a gravitational field — Coulomb's law is the electrical analogue of Newton's law of gravitation.",
        2: "Coulomb's law: F = kq₁q₂/r². Electric field: E = F/q = kq/r². Potential: V = kq/r. Parallel-plate capacitance: C = ε₀A/d. Gauss's law: ∮E·dA = Q_enc/ε₀.",
        3: "Use Gauss's law for symmetric charge distributions (spheres, cylinders, sheets), solve series/parallel capacitor combination and energy-stored problems, and apply potential energy to charged-particle motion."
    },
    'Current Electricity': {
        1: "Current is the organised flow of charge through a conductor, driven by a potential difference — much like water flows downhill because of a height difference, charge flows because of a voltage difference.",
        2: "Ohm's law: V = IR. Resistivity: R = ρl/A. Kirchhoff's laws: ΣI = 0 at a junction, ΣV = 0 around a loop. Power: P = VI = I²R. Series: R = R₁+R₂; Parallel: 1/R = 1/R₁+1/R₂.",
        3: "Solve resistor-network problems with Kirchhoff's laws, analyse Wheatstone bridge and potentiometer circuits, and calculate heating effects and electrical energy consumption in multi-component circuits."
    },
    'Magnetism': {
        1: "Moving charges create magnetic fields, and magnetic fields push on moving charges — magnetism is fundamentally about charges in motion, which is why a stationary charge feels no magnetic force at all.",
        2: "Force on a moving charge: F = qvB sinθ. Force on a current-carrying wire: F = BIL sinθ. Field of a long straight wire: B = μ₀I/2πr. Torque on a current loop: τ = NIAB sinθ.",
        3: "Apply circular/helical motion of charged particles in magnetic fields (radius r = mv/qB) to velocity-selector and cyclotron problems, and find the field due to combinations of wires, loops, and solenoids."
    },
    'Optics': {
        1: "Light can be treated as rays that travel in straight lines, bend at surfaces, and reflect off mirrors — ray optics explains everyday experiences like why a straw looks bent in water or why mirrors flip your image.",
        2: "Mirror formula: 1/v + 1/u = 1/f. Lens formula: 1/v − 1/u = 1/f. Magnification: m = v/u = h'/h. Lens maker's formula: 1/f = (n−1)(1/R₁ − 1/R₂). Snell's law: n₁ sinθ₁ = n₂ sinθ₂.",
        3: "Solve lens/mirror combination problems for image position and nature, apply Snell's law to total internal reflection and prism deviation, and find the magnifying power of simple microscopes and telescopes."
    },
    'Modern Physics': {
        1: "At very small scales, energy and matter behave in chunks rather than continuously — light arrives as photons, and atoms emit or absorb energy only in fixed steps, not gradually.",
        2: "Photoelectric equation: hf = φ + KE_max. Bohr model: E_n = −13.6/n² eV. Radioactive decay: N = N₀e^(−λt), half-life t½ = 0.693/λ. Mass-energy equivalence: E = mc².",
        3: "Solve photoelectric threshold-frequency and stopping-potential problems, apply Bohr's model to transition energies/wavelengths in hydrogen-like atoms, and use decay laws to find remaining activity over time."
    }
};

// 10 dummy MCQs per entry test (development-stage content, per spec),
// cycling through the canonical topic list so every test samples broadly
// across the Physics syllabus. answer = index of correct option.
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

    // Build 3 tests of 10 questions each, cycling through the bank with a
    // varied starting offset per test so each diagnostic samples a
    // slightly different slice of the syllabus.
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

// Beginner / Intermediate / Advanced classification thresholds, applied to
// a percentage score on an entry test (Section 1.5 of the spec).
function classifyPhysicsProficiency(percentScore) {
    if (percentScore >= 75) return 'Advanced';
    if (percentScore >= 45) return 'Intermediate';
    return 'Beginner';
}

module.exports = {
    pool, initSchema, QUESTIONS, computeTargets, TOPIC_BANK, AIM_BASE_TARGETS, RESERVED_CATEGORIES,
    predictCutoff, HISTORICAL_CUTOFFS, STATE_ADJUSTMENT,
    refreshCutoffCache, getCachedCutoffRows, isCutoffCacheStale,
    PHYSICS_TOPICS, PHYSICS_TERM_CONTENT, PHYSICS_ENTRY_QUESTIONS, classifyPhysicsProficiency
};
