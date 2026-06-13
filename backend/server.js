// server.js — NEET CTK IGNITION  |  PostgreSQL + Express
// Serves the REST API and static frontend.

const express = require('express');
const cors    = require('cors');
const path    = require('path');
require('dotenv').config();
const { pool, initSchema, QUESTIONS, computeTargets, TOPIC_BANK } = require('./db');

const app  = express();
const PORT = process.env.PORT || 4000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'frontend')));

// ---------------------------------------------------------------------------
// Helper: full student bundle (student + progress + targets)
// ---------------------------------------------------------------------------
async function getStudentBundle(email) {
    const { rows: [student] } = await pool.query(`SELECT * FROM students WHERE email = $1`, [email]);
    if (!student) return null;
    const { rows: [progress] } = await pool.query(`SELECT * FROM progress WHERE email = $1`, [email]);
    const { rows: [targets]  } = await pool.query(`SELECT * FROM targets  WHERE email = $1`, [email]);
    return { student, progress, targets };
}

// ---------------------------------------------------------------------------
// STUDENT REGISTRATION
// ---------------------------------------------------------------------------
app.post('/api/register', async (req, res) => {
    const { name, email, phone, category, aim, examDate } = req.body;

    if (!name?.trim() || !email?.trim())
        return res.status(400).json({ error: 'Name and email are required.' });

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
        return res.status(400).json({ error: 'Please provide a valid email address.' });

    try {
        const { rows: [existing] } = await pool.query(
            `SELECT email FROM students WHERE email = $1`, [email]
        );

        if (existing) {
            await pool.query(
                `UPDATE students SET name=$1, phone=$2, category=$3, aim=$4, exam_date=$5 WHERE email=$6`,
                [name, phone || '', category || 'General', aim || 'Government Medical College', examDate || null, email]
            );
        } else {
            await pool.query(
                `INSERT INTO students (email, name, phone, category, aim, exam_date) VALUES ($1,$2,$3,$4,$5,$6)`,
                [email, name, phone || '', category || 'General', aim || 'Government Medical College', examDate || null]
            );
            await pool.query(
                `INSERT INTO progress (email, bio_accuracy, phy_accuracy, chem_accuracy, quiz_count, weekly_history)
                 VALUES ($1, 40, 35, 38, 0, '[40,40,40,40,40,40,40]')`,
                [email]
            );
        }

        const t = computeTargets(aim || 'Government Medical College', category || 'General');
        await pool.query(
            `INSERT INTO targets (email, bio, phy, chem) VALUES ($1,$2,$3,$4)
             ON CONFLICT (email) DO UPDATE SET bio=$2, phy=$3, chem=$4`,
            [email, t.bio, t.phy, t.chem]
        );

        return res.status(201).json(await getStudentBundle(email));
    } catch (err) {
        console.error(err);
        return res.status(500).json({ error: 'Server error during registration.' });
    }
});

// ---------------------------------------------------------------------------
// FETCH STUDENT PROFILE
// ---------------------------------------------------------------------------
app.get('/api/student/:email', async (req, res) => {
    const bundle = await getStudentBundle(req.params.email);
    if (!bundle) return res.status(404).json({ error: 'Student not found.' });
    res.json(bundle);
});

// ---------------------------------------------------------------------------
// EXAM DATE
// ---------------------------------------------------------------------------
app.get('/api/admin/exam-date', async (req, res) => {
    const { rows: [row] } = await pool.query(`SELECT value FROM settings WHERE key = 'exam_date'`);
    res.json({ examDate: row ? row.value : null });
});

app.post('/api/admin/exam-date', async (req, res) => {
    const { examDate } = req.body;
    if (!examDate) return res.status(400).json({ error: 'examDate is required.' });
    await pool.query(
        `INSERT INTO settings (key, value) VALUES ('exam_date', $1)
         ON CONFLICT (key) DO UPDATE SET value = $1`,
        [examDate]
    );
    res.json({ examDate });
});

// ---------------------------------------------------------------------------
// QUESTIONS — never expose the correct answer
// ---------------------------------------------------------------------------
app.get('/api/questions', (req, res) => {
    res.json(QUESTIONS.map(({ id, subject, topic, text, options }) => ({ id, subject, topic, text, options })));
});

// ---------------------------------------------------------------------------
// SUBMIT QUIZ
// ---------------------------------------------------------------------------
app.post('/api/submit-quiz', async (req, res) => {
    const { email, answers } = req.body;
    if (!email) return res.status(400).json({ error: 'email is required.' });
    if (!Array.isArray(answers) || answers.length !== QUESTIONS.length)
        return res.status(400).json({ error: `answers must be an array of length ${QUESTIONS.length}.` });

    const { rows: [progress] } = await pool.query(`SELECT * FROM progress WHERE email = $1`, [email]);
    if (!progress) return res.status(404).json({ error: 'Student progress not found. Please register first.' });

    const stats = { Biology: { c: 0, t: 0 }, Physics: { c: 0, t: 0 }, Chemistry: { c: 0, t: 0 } };
    let totalCorrect = 0;

    QUESTIONS.forEach((q, i) => {
        stats[q.subject].t += 1;
        if (answers[i] === q.answer) { stats[q.subject].c += 1; totalCorrect += 1; }
    });

    const acc = s => stats[s].t > 0 ? (stats[s].c / stats[s].t) * 100 : null;
    const blend = (old, attempt) => attempt === null
        ? old
        : Math.round((old * 0.7 + attempt * 0.3) * 10) / 10;

    const newBio  = blend(progress.bio_accuracy,  acc('Biology'));
    const newPhy  = blend(progress.phy_accuracy,  acc('Physics'));
    const newChem = blend(progress.chem_accuracy, acc('Chemistry'));

    let history = [];
    try { history = JSON.parse(progress.weekly_history); } catch (_) {}
    history.push(Math.round(((newBio + newPhy + newChem) / 3) * 10) / 10);
    if (history.length > 7) history = history.slice(-7);

    await pool.query(
        `UPDATE progress SET bio_accuracy=$1, phy_accuracy=$2, chem_accuracy=$3,
                             quiz_count=quiz_count+1, weekly_history=$4
         WHERE email=$5`,
        [newBio, newPhy, newChem, JSON.stringify(history), email]
    );

    res.json({
        score: totalCorrect,
        total: QUESTIONS.length,
        accuracy: Math.round((totalCorrect / QUESTIONS.length) * 100),
        updatedProgress: { bio_accuracy: newBio, phy_accuracy: newPhy, chem_accuracy: newChem, weekly_history: history }
    });
});

// ---------------------------------------------------------------------------
// PROGRESS
// ---------------------------------------------------------------------------
app.get('/api/progress/:email', async (req, res) => {
    const { rows: [progress] } = await pool.query(`SELECT * FROM progress WHERE email = $1`, [req.params.email]);
    if (!progress) return res.status(404).json({ error: 'Progress not found.' });
    let history = [];
    try { history = JSON.parse(progress.weekly_history); } catch (_) {}
    res.json({ ...progress, weekly_history: history });
});

// ---------------------------------------------------------------------------
// PERSONALISED PLAN
// ---------------------------------------------------------------------------
app.get('/api/plan/:email', async (req, res) => {
    const bundle = await getStudentBundle(req.params.email);
    if (!bundle) return res.status(404).json({ error: 'Student not found.' });

    const { rows: [examRow] } = await pool.query(`SELECT value FROM settings WHERE key = 'exam_date'`);
    const today    = new Date();
    const exam     = examRow ? new Date(examRow.value) : today;
    const daysLeft = Math.max(0, Math.ceil((exam - today) / 86400000));

    const foundation    = Math.floor(daysLeft * 0.4);
    const consolidation = Math.floor(daysLeft * 0.4);
    const peakPractice  = daysLeft - foundation - consolidation;

    const { progress, targets, student } = bundle;
    const avgAcc     = (progress.bio_accuracy + progress.phy_accuracy + progress.chem_accuracy) / 3;
    const targetAvg  = (targets.bio + targets.phy + targets.chem) / 3;
    const progressPct = Math.min(100, Math.round((avgAcc / targetAvg) * 1000) / 10);

    const subjects = [
        { key: 'Biology',   acc: progress.bio_accuracy,  target: targets.bio  },
        { key: 'Physics',   acc: progress.phy_accuracy,  target: targets.phy  },
        { key: 'Chemistry', acc: progress.chem_accuracy, target: targets.chem }
    ].sort((a, b) => (a.acc - a.target) - (b.acc - b.target));

    res.json({
        daysLeft,
        phases: {
            foundation:    { days: foundation,    focus: 'Revise fundamentals, attempt Level-1 topic quizzes, build clean concept notes.' },
            consolidation: { days: consolidation, focus: 'Cross-chapter MCQs, work through the Error Atlas, attempt mixed-subject quizzes.' },
            peakPractice:  { days: peakPractice,  focus: 'Full-length mock tests, Advanced Mode practice, timed revision sprints.' }
        },
        progressPercent: progressPct,
        focusSubject:  subjects[0].key,
        strongSubject: subjects[subjects.length - 1].key,
        message: `Based on your category (${student.category}) and aim (${student.aim}), prioritise ${subjects[0].key} while maintaining momentum in ${subjects[subjects.length - 1].key}. You have ${daysLeft} days until your target exam date.`
    });
});

// ---------------------------------------------------------------------------
// APPROVED LECTURES
// ---------------------------------------------------------------------------
app.get('/api/approved-lectures', async (req, res) => {
    const { rows } = await pool.query(`SELECT * FROM lectures WHERE approved = 1 ORDER BY created_at DESC`);
    res.json(rows);
});

// ---------------------------------------------------------------------------
// LECTURER HUB
// ---------------------------------------------------------------------------
app.post('/api/lecturer/submit', async (req, res) => {
    const { title, subject, url, lecturerName } = req.body;
    if (!title?.trim() || !url?.trim() || !lecturerName?.trim())
        return res.status(400).json({ error: 'Title, URL and lecturer name are required.' });
    if (!/^https?:\/\//i.test(url))
        return res.status(400).json({ error: 'Please provide a valid video URL.' });

    await pool.query(
        `INSERT INTO lectures (title, subject, url, lecturer_name, approved) VALUES ($1,$2,$3,$4,0)`,
        [title.trim(), subject || 'Physics', url.trim(), lecturerName.trim()]
    );
    res.status(201).json({ success: true });
});

app.get('/api/lecturer/submissions/:lecturerName', async (req, res) => {
    const { rows } = await pool.query(
        `SELECT id, title, subject, url, approved, created_at FROM lectures
         WHERE lecturer_name = $1 ORDER BY created_at DESC`,
        [req.params.lecturerName]
    );
    res.json(rows);
});

// ---------------------------------------------------------------------------
// ADMIN CONSOLE
// ---------------------------------------------------------------------------
app.get('/api/admin/pending-lectures', async (req, res) => {
    const { rows } = await pool.query(`SELECT * FROM lectures WHERE approved = 0 ORDER BY created_at ASC`);
    res.json(rows);
});

app.post('/api/admin/approve-lecture/:id', async (req, res) => {
    const { rowCount } = await pool.query(`UPDATE lectures SET approved = 1 WHERE id = $1`, [req.params.id]);
    if (rowCount === 0) return res.status(404).json({ error: 'Lecture not found.' });
    res.json({ success: true });
});

app.delete('/api/admin/reject-lecture/:id', async (req, res) => {
    const { rowCount } = await pool.query(`DELETE FROM lectures WHERE id = $1`, [req.params.id]);
    if (rowCount === 0) return res.status(404).json({ error: 'Lecture not found.' });
    res.json({ success: true });
});

app.get('/api/admin/analytics-summary', async (req, res) => {
    const { rows } = await pool.query(`
        SELECT s.email, s.name, s.category, s.aim,
               p.bio_accuracy, p.phy_accuracy, p.chem_accuracy, p.quiz_count
        FROM students s
        JOIN progress p ON s.email = p.email
        ORDER BY s.created_at DESC
    `);
    res.json(rows);
});

app.post('/api/admin/reset-all', async (req, res) => {
    await pool.query(`
        DELETE FROM feedback;
        DELETE FROM lectures;
        DELETE FROM targets;
        DELETE FROM progress;
        DELETE FROM students;
    `);
    await pool.query(`
        INSERT INTO lectures (title, subject, url, lecturer_name, approved) VALUES
        ('Human Reproduction - High Yield Revision', 'Biology',   'https://www.youtube.com/embed/UMo7dUNGkQo', 'Dr. Meera Sharma',  1),
        ('Thermodynamics - Connecting Concepts',     'Physics',   'https://www.youtube.com/embed/4i1MUWJoI0U', 'Prof. Anil Kapoor', 1)
    `);
    res.json({ success: true });
});

// ---------------------------------------------------------------------------
// FEEDBACK
// ---------------------------------------------------------------------------
app.post('/api/feedback', async (req, res) => {
    const { message } = req.body;
    if (!message?.trim()) return res.status(400).json({ error: 'Message cannot be empty.' });
    await pool.query(`INSERT INTO feedback (message) VALUES ($1)`, [message.trim()]);
    res.status(201).json({ success: true });
});

app.get('/api/admin/feedback', async (req, res) => {
    const { rows } = await pool.query(`SELECT * FROM feedback ORDER BY created_at DESC`);
    res.json(rows);
});

// ---------------------------------------------------------------------------
// ERROR ATLAS
// ---------------------------------------------------------------------------
app.get('/api/error-atlas/:email', async (req, res) => {
    const bundle = await getStudentBundle(req.params.email);
    if (!bundle) return res.status(404).json({ error: 'Student not found.' });

    const { progress, targets } = bundle;
    const gaps = [
        { key: 'bio',  label: 'Biology',   gap: targets.bio  - progress.bio_accuracy  },
        { key: 'phy',  label: 'Physics',   gap: targets.phy  - progress.phy_accuracy  },
        { key: 'chem', label: 'Chemistry', gap: targets.chem - progress.chem_accuracy }
    ].sort((a, b) => b.gap - a.gap);

    const atlas = gaps.filter(g => g.gap > 0).map(g => ({
        subject: g.label,
        gap: Math.round(g.gap * 10) / 10,
        topics: TOPIC_BANK[g.key]
    }));

    res.json({ atlas });
});

// ---------------------------------------------------------------------------
// SPA fallback
// ---------------------------------------------------------------------------
app.get(/^\/(?!api).*/, (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'frontend', 'index.html'));
});

// ---------------------------------------------------------------------------
// START
// ---------------------------------------------------------------------------
initSchema()
    .then(() => app.listen(PORT, () =>
        console.log(`🚀  NEET CTK IGNITION running on http://localhost:${PORT}`)
    ))
    .catch(err => { console.error('Failed to initialise database:', err); process.exit(1); });
