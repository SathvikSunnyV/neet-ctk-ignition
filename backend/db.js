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
    await pool.query(`
        CREATE TABLE IF NOT EXISTS students (
            email       TEXT PRIMARY KEY,
            name        TEXT NOT NULL,
            phone       TEXT,
            category    TEXT,
            aim         TEXT,
            exam_date   TEXT,
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
    `);

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
// TARGET GENERATION
// ---------------------------------------------------------------------------
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

module.exports = { pool, initSchema, QUESTIONS, computeTargets, TOPIC_BANK, AIM_BASE_TARGETS, RESERVED_CATEGORIES };
