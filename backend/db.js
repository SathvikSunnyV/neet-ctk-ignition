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
// HISTORICAL NEET CUTOFF DATA (2021-2024, NEET out of 720)
// Source pattern: NEET UG counselling qualifying/closing cutoff trends
// published by NTA/MCC for All-India quota, by category.
// These are representative aggregate figures used as the model's training
// data — admins can extend this table via /api/admin/cutoff-data as more
// official data becomes available, and the model recomputes automatically.
// ---------------------------------------------------------------------------
const HISTORICAL_CUTOFFS = [
    // year, category, AIIMS_closing, GovtMedical_closing, PrivateMedical_closing, qualifying_percentile_score
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
 * AI-based cutoff & rank prediction.
 * Trains a per-(category, institution) linear regression on HISTORICAL_CUTOFFS
 * (2021-2024) and extrapolates to the target exam year, then applies a
 * state-quota adjustment. Outputs Safe / Target / Stretch scores, an
 * estimated rank band, and an admission probability.
 *
 * @param {string} aim       - 'AIIMS' | 'Government Medical College' | 'Private Medical College'
 * @param {string} category  - 'General' | 'EWS' | 'OBC' | 'SC' | 'ST' | 'PwD' | 'Others'
 * @param {string} state
 * @param {string|Date} examDate
 * @param {number} [currentAccuracyPct] - student's current average accuracy (0-100), optional
 */
function predictCutoff(aim, category, state, examDate, currentAccuracyPct = null) {
    const instKey = INSTITUTION_KEY[aim] || 'govt';
    const cat = HISTORICAL_CUTOFFS.some(r => r.category === category)
        ? category
        : (CATEGORY_FALLBACK[category] || 'General');

    const rows = HISTORICAL_CUTOFFS.filter(r => r.category === cat)
        .map(r => ({ x: r.year, y: r[instKey] }));

    const { slope, intercept } = linearRegression(rows);

    const targetYear = examDate ? new Date(examDate).getFullYear() : (new Date().getFullYear() + 1);
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
            method: 'linear-regression-on-historical-cutoffs',
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

module.exports = {
    pool, initSchema, QUESTIONS, computeTargets, TOPIC_BANK, AIM_BASE_TARGETS, RESERVED_CATEGORIES,
    predictCutoff, HISTORICAL_CUTOFFS, STATE_ADJUSTMENT
};
