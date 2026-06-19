// server.js — NEET CTK IGNITION  |  PostgreSQL + Express
// Serves the REST API and static frontend.

const express = require('express');
const cors    = require('cors');
const path    = require('path');
const multer  = require('multer');
require('dotenv').config();
const { pool, initSchema, computeTargets, TOPIC_BANK, predictCutoff, refreshCutoffCache,
    PHYSICS_TOPICS, classifyPhysicsProficiency } = require('./db');
const { generateRecommendations, generatePhysicsRecommendations } = require('./ai');
const { structureWithAI, parseQuestionsRuleBased } = require('./ocr');
const {
    hashPassword, verifyPassword, signToken,
    generateOTP, otpExpiry, isOtpExpired,
    sendOtpEmail,
    authenticate, requireRole, optionalAuth,
    checkRateLimit, recordAttempt
} = require('./auth');

const app  = express();
const PORT = process.env.PORT || 4000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'frontend')));

// ===========================================================================
// AUTHENTICATION SYSTEM (additive — does not affect existing routes)
// ===========================================================================

// ---------------------------------------------------------------------------
// REGISTER (Student / Faculty / Admin) — creates an unverified user and
// sends an OTP for email verification.
// ---------------------------------------------------------------------------
app.post('/api/auth/register', async (req, res) => {
    const { name, email, password, confirmPassword, role } = req.body;
    const cleanEmail = (email || '').trim().toLowerCase();
    const allowedRoles = ['student', 'faculty', 'admin'];
    const finalRole = allowedRoles.includes(role) ? role : 'student';

    if (!name?.trim() || !cleanEmail || !password)
        return res.status(400).json({ error: 'Name, email and password are required.' });

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail))
        return res.status(400).json({ error: 'Please provide a valid email address.' });

    if (password.length < 8)
        return res.status(400).json({ error: 'Password must be at least 8 characters long.' });

    if (confirmPassword !== undefined && password !== confirmPassword)
        return res.status(400).json({ error: 'Passwords do not match.' });

    // Admin self-registration requires an invite code, to avoid open
    // creation of admin accounts.
    if (finalRole === 'admin') {
        const expected = process.env.ADMIN_SIGNUP_CODE || 'ctk-admin-invite';
        if (req.body.adminCode !== expected) {
            return res.status(403).json({ error: 'A valid admin invite code is required to register as Admin.' });
        }
    }

    try {
        const { rows: [existing] } = await pool.query(`SELECT id, is_verified FROM users WHERE email = $1`, [cleanEmail]);
        if (existing && existing.is_verified) {
            return res.status(409).json({ error: 'An account with this email already exists. Please log in.' });
        }

        const passwordHash = await hashPassword(password);
        const otp = generateOTP();
        const expiry = otpExpiry();

        if (existing) {
            await pool.query(
                `UPDATE users SET name=$1, password_hash=$2, role=$3, otp_code=$4, otp_expires_at=$5 WHERE email=$6`,
                [name.trim(), passwordHash, finalRole, otp, expiry, cleanEmail]
            );
        } else {
            await pool.query(
                `INSERT INTO users (name, email, password_hash, role, is_verified, otp_code, otp_expires_at)
                 VALUES ($1,$2,$3,$4, FALSE, $5, $6)`,
                [name.trim(), cleanEmail, passwordHash, finalRole, otp, expiry]
            );
        }

        if (finalRole === 'faculty') {
            await pool.query(
                `INSERT INTO faculty (email, name) VALUES ($1,$2)
                 ON CONFLICT (email) DO UPDATE SET name = $2`,
                [cleanEmail, name.trim()]
            );
        }

        await sendOtpEmail(cleanEmail, otp, 'verify your NEET CTK IGNITION account');

        return res.status(201).json({
            success: true,
            message: 'Registration successful. Please check your email for the OTP to verify your account.',
            email: cleanEmail
        });
    } catch (err) {
        console.error(err);
        return res.status(500).json({ error: 'Server error during registration.' });
    }
});

// ---------------------------------------------------------------------------
// VERIFY OTP — activates the account
// ---------------------------------------------------------------------------
app.post('/api/auth/verify-otp', async (req, res) => {
    const cleanEmail = (req.body.email || '').trim().toLowerCase();
    const { otp } = req.body;

    if (!cleanEmail || !otp) return res.status(400).json({ error: 'Email and OTP are required.' });

    try {
        const { rows: [user] } = await pool.query(`SELECT * FROM users WHERE email = $1`, [cleanEmail]);
        if (!user) return res.status(404).json({ error: 'No account found for this email.' });
        if (user.is_verified) return res.status(400).json({ error: 'This account is already verified. Please log in.' });

        if (isOtpExpired(user.otp_expires_at)) {
            return res.status(400).json({ error: 'OTP has expired. Please request a new one.' });
        }
        if (user.otp_code !== otp) {
            return res.status(400).json({ error: 'Incorrect OTP. Please try again.' });
        }

        await pool.query(
            `UPDATE users SET is_verified = TRUE, otp_code = NULL, otp_expires_at = NULL WHERE email = $1`,
            [cleanEmail]
        );

        return res.json({ success: true, message: 'Email verified successfully. You can now log in.' });
    } catch (err) {
        console.error(err);
        return res.status(500).json({ error: 'Server error during OTP verification.' });
    }
});

// ---------------------------------------------------------------------------
// RESEND OTP
// ---------------------------------------------------------------------------
app.post('/api/auth/resend-otp', async (req, res) => {
    const cleanEmail = (req.body.email || '').trim().toLowerCase();
    if (!cleanEmail) return res.status(400).json({ error: 'Email is required.' });

    try {
        const allowed = await checkRateLimit(pool, cleanEmail, 'otp', 5, 15);
        if (!allowed) return res.status(429).json({ error: 'Too many OTP requests. Please wait a few minutes and try again.' });

        const { rows: [user] } = await pool.query(`SELECT * FROM users WHERE email = $1`, [cleanEmail]);
        if (!user) return res.status(404).json({ error: 'No account found for this email.' });
        if (user.is_verified) return res.status(400).json({ error: 'This account is already verified. Please log in.' });

        const otp = generateOTP();
        const expiry = otpExpiry();
        await pool.query(`UPDATE users SET otp_code=$1, otp_expires_at=$2 WHERE email=$3`, [otp, expiry, cleanEmail]);
        await recordAttempt(pool, cleanEmail, 'otp');
        await sendOtpEmail(cleanEmail, otp, 'verify your NEET CTK IGNITION account');

        return res.json({ success: true, message: 'A new OTP has been sent to your email.' });
    } catch (err) {
        console.error(err);
        return res.status(500).json({ error: 'Server error while resending OTP.' });
    }
});

// ---------------------------------------------------------------------------
// LOGIN
// ---------------------------------------------------------------------------
app.post('/api/auth/login', async (req, res) => {
    const cleanEmail = (req.body.email || '').trim().toLowerCase();
    const { password } = req.body;

    if (!cleanEmail || !password) return res.status(400).json({ error: 'Email and password are required.' });

    try {
        const allowed = await checkRateLimit(pool, cleanEmail, 'login', 10, 15);
        if (!allowed) return res.status(429).json({ error: 'Too many login attempts. Please wait a few minutes and try again.' });

        const { rows: [user] } = await pool.query(`SELECT * FROM users WHERE email = $1`, [cleanEmail]);
        await recordAttempt(pool, cleanEmail, 'login');

        if (!user) return res.status(401).json({ error: 'Invalid email or password.' });

        const ok = await verifyPassword(password, user.password_hash);
        if (!ok) return res.status(401).json({ error: 'Invalid email or password.' });

        if (!user.is_verified) {
            return res.status(403).json({ error: 'Please verify your email with the OTP sent during registration before logging in.', needsVerification: true, email: cleanEmail });
        }

        const token = signToken(user);
        return res.json({
            success: true,
            token,
            user: { id: user.id, name: user.name, email: user.email, role: user.role, onboardingDone: user.onboarding_done }
        });
    } catch (err) {
        console.error(err);
        return res.status(500).json({ error: 'Server error during login.' });
    }
});

// ---------------------------------------------------------------------------
// FORGOT PASSWORD — sends a reset OTP
// ---------------------------------------------------------------------------
app.post('/api/auth/forgot-password', async (req, res) => {
    const cleanEmail = (req.body.email || '').trim().toLowerCase();
    if (!cleanEmail) return res.status(400).json({ error: 'Email is required.' });

    try {
        const allowed = await checkRateLimit(pool, cleanEmail, 'reset', 5, 15);
        if (!allowed) return res.status(429).json({ error: 'Too many reset requests. Please wait a few minutes and try again.' });

        const { rows: [user] } = await pool.query(`SELECT * FROM users WHERE email = $1`, [cleanEmail]);
        // Always respond success to avoid leaking which emails are registered.
        if (user) {
            const otp = generateOTP();
            const expiry = otpExpiry();
            await pool.query(`UPDATE users SET reset_otp_code=$1, reset_otp_expires_at=$2 WHERE email=$3`, [otp, expiry, cleanEmail]);
            await recordAttempt(pool, cleanEmail, 'reset');
            await sendOtpEmail(cleanEmail, otp, 'reset your NEET CTK IGNITION password');
        }

        return res.json({ success: true, message: 'If an account exists for this email, a password reset OTP has been sent.' });
    } catch (err) {
        console.error(err);
        return res.status(500).json({ error: 'Server error during password reset request.' });
    }
});

// ---------------------------------------------------------------------------
// RESET PASSWORD — verify OTP and set new password
// ---------------------------------------------------------------------------
app.post('/api/auth/reset-password', async (req, res) => {
    const cleanEmail = (req.body.email || '').trim().toLowerCase();
    const { otp, newPassword, confirmPassword } = req.body;

    if (!cleanEmail || !otp || !newPassword) return res.status(400).json({ error: 'Email, OTP and new password are required.' });
    if (newPassword.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters long.' });
    if (confirmPassword !== undefined && newPassword !== confirmPassword) return res.status(400).json({ error: 'Passwords do not match.' });

    try {
        const { rows: [user] } = await pool.query(`SELECT * FROM users WHERE email = $1`, [cleanEmail]);
        if (!user) return res.status(404).json({ error: 'No account found for this email.' });

        if (isOtpExpired(user.reset_otp_expires_at)) {
            return res.status(400).json({ error: 'OTP has expired. Please request a new one.' });
        }
        if (user.reset_otp_code !== otp) {
            return res.status(400).json({ error: 'Incorrect OTP. Please try again.' });
        }

        const passwordHash = await hashPassword(newPassword);
        await pool.query(
            `UPDATE users SET password_hash=$1, reset_otp_code=NULL, reset_otp_expires_at=NULL WHERE email=$2`,
            [passwordHash, cleanEmail]
        );

        return res.json({ success: true, message: 'Password reset successfully. You can now log in with your new password.' });
    } catch (err) {
        console.error(err);
        return res.status(500).json({ error: 'Server error during password reset.' });
    }
});

// ---------------------------------------------------------------------------
// CURRENT USER (session check)
// ---------------------------------------------------------------------------
app.get('/api/auth/me', authenticate, async (req, res) => {
    try {
        const { rows: [user] } = await pool.query(
            `SELECT id, name, email, role, onboarding_done FROM users WHERE id = $1`, [req.user.id]
        );
        if (!user) return res.status(404).json({ error: 'User not found.' });
        res.json({ user: { id: user.id, name: user.name, email: user.email, role: user.role, onboardingDone: user.onboarding_done } });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error.' });
    }
});

// ===========================================================================
// STUDENT ONBOARDING (post first-login questionnaire)
// Reuses the existing `students`/`progress`/`targets` tables and the
// existing /api/register logic, but is gated behind authentication and
// marks the user's onboarding as complete.
// ===========================================================================
app.post('/api/onboarding/student', authenticate, requireRole('student'), async (req, res) => {
    const {
        targetExam, targetInstitution, category, state,
        currentClass, examDate, dailyStudyHours, prepLevel
    } = req.body;

    const email = req.user.email;
    const name = req.user.name;

    const aim = targetInstitution || 'Government Medical College';
    const cat = category || 'General';

    try {
        const { rows: [existing] } = await pool.query(`SELECT email FROM students WHERE email = $1`, [email]);

        if (existing) {
            await pool.query(
                `UPDATE students SET name=$1, category=$2, aim=$3, exam_date=$4,
                        target_institution=$5, state=$6, current_class=$7,
                        daily_study_hours=$8, prep_level=$9, target_exam=$10
                 WHERE email=$11`,
                [name, cat, aim, examDate || null, aim, state || null, currentClass || null,
                 dailyStudyHours || null, prepLevel || 'Beginner', targetExam || 'NEET', email]
            );
        } else {
            await pool.query(
                `INSERT INTO students (email, name, phone, category, aim, exam_date,
                        target_institution, state, current_class, daily_study_hours, prep_level, target_exam)
                 VALUES ($1,$2,'',$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
                [email, name, cat, aim, examDate || null, aim, state || null, currentClass || null,
                 dailyStudyHours || null, prepLevel || 'Beginner', targetExam || 'NEET']
            );
            await pool.query(
                `INSERT INTO progress (email, bio_accuracy, phy_accuracy, chem_accuracy, quiz_count, weekly_history)
                 VALUES ($1, 40, 35, 38, 0, '[40,40,40,40,40,40,40]')`,
                [email]
            );
        }

        const t = computeTargets(aim, cat);
        await pool.query(
            `INSERT INTO targets (email, bio, phy, chem) VALUES ($1,$2,$3,$4)
             ON CONFLICT (email) DO UPDATE SET bio=$2, phy=$3, chem=$4`,
            [email, t.bio, t.phy, t.chem]
        );

        await pool.query(`UPDATE users SET onboarding_done = TRUE WHERE email = $1`, [email]);

        const bundle = await getStudentBundle(email);
        const cutoff = await predictCutoff(aim, cat, state, examDate, null);

        return res.status(201).json({ ...bundle, cutoffPrediction: cutoff });
    } catch (err) {
        console.error(err);
        return res.status(500).json({ error: 'Server error during onboarding.' });
    }
});

// ===========================================================================
// AI-BASED CUTOFF PREDICTION
// Returns Safe/Target/Stretch scores, rank band and admission probability
// computed from historical NEET cutoff trends (see db.js).
// ===========================================================================
app.get('/api/cutoff-prediction/:email', authenticate, async (req, res) => {
    try {
        const bundle = await getStudentBundle(req.params.email);
        if (!bundle) return res.status(404).json({ error: 'Student not found.' });

        const { student, progress } = bundle;
        const avgAccuracy = progress
            ? (progress.bio_accuracy + progress.phy_accuracy + progress.chem_accuracy) / 3
            : null;

        const prediction = await predictCutoff(
            student.aim || 'Government Medical College',
            student.category || 'General',
            student.state,
            student.exam_date,
            avgAccuracy
        );

        res.json(prediction);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error while computing cutoff prediction.' });
    }
});

// ---------------------------------------------------------------------------
// ADMIN: view / force-refresh the live cutoff data cache
// (real web search + free AI extraction — see research.js)
// ---------------------------------------------------------------------------
app.get('/api/admin/cutoff-cache', authenticate, requireRole('admin'), async (req, res) => {
    try {
        const { rows } = await pool.query(`SELECT * FROM cutoff_cache ORDER BY year DESC, category ASC`);
        res.json({ rows });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error while reading cutoff cache.' });
    }
});

app.post('/api/admin/cutoff-cache/refresh', authenticate, requireRole('admin'), async (req, res) => {
    const year = parseInt(req.body.year, 10) || (new Date().getFullYear() + 1);
    try {
        const result = await refreshCutoffCache(year);
        if (result.success) {
            res.json({ success: true, message: `Live cutoff data refreshed for ${year} from real web sources.`, rowCount: result.rowCount });
        } else {
            res.status(502).json({ success: false, error: `Could not fetch live data (${result.reason}). Existing cache / static baseline will continue to be used.` });
        }
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error while refreshing cutoff cache.' });
    }
});


async function getStudentBundle(email) {
    const { rows: [student] } = await pool.query(`SELECT * FROM students WHERE email = $1`, [email]);
    if (!student) return null;
    const { rows: [progress] } = await pool.query(`SELECT * FROM progress WHERE email = $1`, [email]);
    const { rows: [targets]  } = await pool.query(`SELECT * FROM targets  WHERE email = $1`, [email]);
    return { student, progress, targets };
}

// ---------------------------------------------------------------------------
// Resolves a chapterId (if provided) to its row, so callers can store both
// the canonical chapter_id link AND keep the legacy free-text `chapter`
// column populated with the current chapter name (for any older frontend
// code/queries that still read `.chapter` directly instead of joining).
// Returns null if chapterId is falsy or the chapter doesn't exist.
// ---------------------------------------------------------------------------
async function resolveChapter(chapterId) {
    if (!chapterId) return null;
    const { rows: [chapter] } = await pool.query(`SELECT * FROM chapters WHERE id = $1`, [chapterId]);
    return chapter || null;
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
// FETCH STUDENT PROFILE — registered further down (see "FETCH STUDENT
// PROFILE (moved)" below) so its single-segment :email param doesn't
// shadow more specific routes like /api/student/tests or
// /api/student/mistake-analysis. (Pre-existing route-ordering bug fixed
// here as part of the Physics Student Module work, since the assigned-
// tests feature depends on /api/student/tests actually being reachable.)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// EXAM DATE
// ---------------------------------------------------------------------------
app.get('/api/admin/exam-date', async (req, res) => {
    const { rows: [row] } = await pool.query(`SELECT value FROM settings WHERE key = 'exam_date'`);
    res.json({ examDate: row ? row.value : null });
});

app.post('/api/admin/exam-date', authenticate, requireRole('admin'), async (req, res) => {
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
app.get('/api/admin/pending-lectures', authenticate, requireRole('admin'), async (req, res) => {
    const { rows } = await pool.query(`SELECT * FROM lectures WHERE approved = 0 ORDER BY created_at ASC`);
    res.json(rows);
});

app.post('/api/admin/approve-lecture/:id', authenticate, requireRole('admin'), async (req, res) => {
    const { rowCount } = await pool.query(`UPDATE lectures SET approved = 1 WHERE id = $1`, [req.params.id]);
    if (rowCount === 0) return res.status(404).json({ error: 'Lecture not found.' });
    res.json({ success: true });
});

app.delete('/api/admin/reject-lecture/:id', authenticate, requireRole('admin'), async (req, res) => {
    const { rowCount } = await pool.query(`DELETE FROM lectures WHERE id = $1`, [req.params.id]);
    if (rowCount === 0) return res.status(404).json({ error: 'Lecture not found.' });
    res.json({ success: true });
});

// ===========================================================================
// FACULTY LECTURE LINK MANAGEMENT (chapter-wise) — additive alongside the
// pre-existing "submit for admin approval" Lecturer Hub flow above. An
// authenticated faculty member managing their own account's lectures gets
// instant publish (consistent with how Study Materials already work) plus
// full edit/delete control and chapter linkage. The original anonymous
// submit-for-approval endpoints (/api/lecturer/submit and the admin
// approve/reject queue) are untouched and keep working exactly as before.
// ===========================================================================
app.post('/api/faculty/lectures', authenticate, requireRole('faculty'), async (req, res) => {
    const { title, subject, url, chapterId } = req.body;
    if (!title?.trim() || !url?.trim()) return res.status(400).json({ error: 'Title and URL are required.' });
    if (!/^https?:\/\//i.test(url)) return res.status(400).json({ error: 'Please provide a valid video URL.' });

    try {
        const chapterRow = await resolveChapter(chapterId);
        const { rows: [lecture] } = await pool.query(
            `INSERT INTO lectures (title, subject, url, lecturer_name, lecturer_email, chapter_id, approved)
             VALUES ($1,$2,$3,$4,$5,$6,1) RETURNING *`,
            [title.trim(), subject || 'Physics', url.trim(), req.user.name, req.user.email, chapterRow ? chapterRow.id : null]
        );
        res.status(201).json({ success: true, lecture });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error while publishing the lecture link.' });
    }
});

app.get('/api/faculty/lectures', authenticate, requireRole('faculty'), async (req, res) => {
    try {
        const { rows } = await pool.query(
            `SELECT l.*, c.name AS chapter_name FROM lectures l
             LEFT JOIN chapters c ON l.chapter_id = c.id
             WHERE l.lecturer_email = $1 ORDER BY l.created_at DESC`,
            [req.user.email]
        );
        res.json(rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error while listing your lecture links.' });
    }
});

app.put('/api/faculty/lectures/:id', authenticate, requireRole('faculty'), async (req, res) => {
    const { title, subject, url, chapterId } = req.body;
    if (!title?.trim() || !url?.trim()) return res.status(400).json({ error: 'Title and URL are required.' });
    if (!/^https?:\/\//i.test(url)) return res.status(400).json({ error: 'Please provide a valid video URL.' });

    try {
        const chapterRow = await resolveChapter(chapterId);
        const { rowCount } = await pool.query(
            `UPDATE lectures SET title=$1, subject=$2, url=$3, chapter_id=$4 WHERE id=$5 AND lecturer_email=$6`,
            [title.trim(), subject || 'Physics', url.trim(), chapterRow ? chapterRow.id : null, req.params.id, req.user.email]
        );
        if (rowCount === 0) return res.status(404).json({ error: 'Lecture link not found or not owned by you.' });
        res.json({ success: true, message: 'Lecture link updated.' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error while updating the lecture link.' });
    }
});

app.delete('/api/faculty/lectures/:id', authenticate, requireRole('faculty'), async (req, res) => {
    try {
        const { rowCount } = await pool.query(
            `DELETE FROM lectures WHERE id = $1 AND lecturer_email = $2`, [req.params.id, req.user.email]
        );
        if (rowCount === 0) return res.status(404).json({ error: 'Lecture link not found or not owned by you.' });
        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error while deleting the lecture link.' });
    }
});

// ===========================================================================
// CHAPTER MANAGEMENT SYSTEM (Faculty Module enhancement)
// The whole platform is chapter-centric: materials, tests and lectures can
// all be linked to a chapter. Chapters are shared curriculum structure —
// any authenticated faculty member can create/edit/reorder/delete them
// (mirrors how the existing admin lecture-approval queue is shared across
// the whole faculty/admin team rather than owned by one account). Deleting
// a chapter never deletes the resources linked to it; it just unlinks them
// (ON DELETE SET NULL in the schema), so no faculty content is ever lost.
// ===========================================================================

// ---------------------------------------------------------------------------
// List chapters for a subject (any authenticated user — faculty use this to
// populate dropdowns when uploading materials/tests/lectures; students use
// it to browse chapter-wise).
// ---------------------------------------------------------------------------
app.get('/api/chapters', authenticate, async (req, res) => {
    const subject = req.query.subject || 'Physics';
    try {
        const { rows } = await pool.query(
            `SELECT c.*,
                    (SELECT COUNT(*) FROM materials m WHERE m.chapter_id = c.id) AS material_count,
                    (SELECT COUNT(*) FROM tests t WHERE t.chapter_id = c.id) AS test_count,
                    (SELECT COUNT(*) FROM lectures l WHERE l.chapter_id = c.id) AS lecture_count
             FROM chapters c WHERE c.subject = $1 ORDER BY c.position ASC, c.created_at ASC`,
            [subject]
        );
        res.json(rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error while listing chapters.' });
    }
});

// ---------------------------------------------------------------------------
// FACULTY: create a chapter
// ---------------------------------------------------------------------------
app.post('/api/faculty/chapters', authenticate, requireRole('faculty'), async (req, res) => {
    const { subject, name, description } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: 'Chapter name is required.' });
    const cleanSubject = subject?.trim() || 'Physics';

    try {
        const { rows: [maxPos] } = await pool.query(
            `SELECT COALESCE(MAX(position), -1) AS max_pos FROM chapters WHERE subject = $1`, [cleanSubject]
        );
        const { rows: [chapter] } = await pool.query(
            `INSERT INTO chapters (subject, name, description, position, created_by)
             VALUES ($1,$2,$3,$4,$5) RETURNING *`,
            [cleanSubject, name.trim(), description || null, parseInt(maxPos.max_pos, 10) + 1, req.user.email]
        );
        res.status(201).json({ success: true, chapter });
    } catch (err) {
        if (err.code === '23505') return res.status(409).json({ error: 'A chapter with this name already exists for this subject.' });
        console.error(err);
        res.status(500).json({ error: 'Server error while creating chapter.' });
    }
});

// ---------------------------------------------------------------------------
// FACULTY: edit a chapter's name/description
// ---------------------------------------------------------------------------
app.put('/api/faculty/chapters/:id', authenticate, requireRole('faculty'), async (req, res) => {
    const { name, description } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: 'Chapter name is required.' });

    try {
        const { rows: [chapter] } = await pool.query(
            `UPDATE chapters SET name = $1, description = $2 WHERE id = $3 RETURNING *`,
            [name.trim(), description || null, req.params.id]
        );
        if (!chapter) return res.status(404).json({ error: 'Chapter not found.' });

        // Keep the legacy free-text `chapter` display columns in sync on
        // anything still linked to this chapter, so older UI code that
        // reads `.chapter` (rather than joining on chapter_id) keeps
        // showing the up-to-date name after a rename.
        await pool.query(`UPDATE materials SET chapter = $1 WHERE chapter_id = $2`, [chapter.name, chapter.id]);
        await pool.query(`UPDATE tests SET chapter = $1 WHERE chapter_id = $2`, [chapter.name, chapter.id]);

        res.json({ success: true, chapter });
    } catch (err) {
        if (err.code === '23505') return res.status(409).json({ error: 'A chapter with this name already exists for this subject.' });
        console.error(err);
        res.status(500).json({ error: 'Server error while updating chapter.' });
    }
});

// ---------------------------------------------------------------------------
// FACULTY: delete a chapter (resources linked to it are unlinked, not deleted)
// ---------------------------------------------------------------------------
app.delete('/api/faculty/chapters/:id', authenticate, requireRole('faculty'), async (req, res) => {
    try {
        const { rowCount } = await pool.query(`DELETE FROM chapters WHERE id = $1`, [req.params.id]);
        if (rowCount === 0) return res.status(404).json({ error: 'Chapter not found.' });
        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error while deleting chapter.' });
    }
});

// ---------------------------------------------------------------------------
// FACULTY: reorder chapters — body: { order: [chapterId, chapterId, ...] }
// (the array's position determines the new `position` value for each id)
// ---------------------------------------------------------------------------
app.post('/api/faculty/chapters/reorder', authenticate, requireRole('faculty'), async (req, res) => {
    const { order } = req.body;
    if (!Array.isArray(order) || order.length === 0) return res.status(400).json({ error: 'order must be a non-empty array of chapter IDs.' });

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        for (let i = 0; i < order.length; i++) {
            await client.query(`UPDATE chapters SET position = $1 WHERE id = $2`, [i, order[i]]);
        }
        await client.query('COMMIT');
        res.json({ success: true });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error(err);
        res.status(500).json({ error: 'Server error while reordering chapters.' });
    } finally {
        client.release();
    }
});

// ===========================================================================
// STUDY MATERIALS (faculty share links only — Google Drive, YouTube, etc.)
// We intentionally do NOT accept direct file uploads here any more: storing
// files as bytea in Postgres was eating up the database's storage quota.
// A shared link keeps the material accessible to students without that cost.
// Published directly by the authenticated faculty member — no separate
// approval queue, since this is course material rather than open community
// video submissions.
// ===========================================================================

// ---------------------------------------------------------------------------
// FACULTY: publish a link-based material (e.g. Google Drive, YouTube, etc.)
// ---------------------------------------------------------------------------
app.post('/api/faculty/materials/link', authenticate, requireRole('faculty'), async (req, res) => {
    const { title, subject, chapter, chapterId, topic, description, externalUrl, term } = req.body;
    if (!title?.trim() || !subject?.trim() || !externalUrl?.trim())
        return res.status(400).json({ error: 'Title, subject and link are required.' });
    if (!/^https?:\/\//i.test(externalUrl))
        return res.status(400).json({ error: 'Please provide a valid link.' });

    const termNum = [1, 2, 3].includes(parseInt(term, 10)) ? parseInt(term, 10) : null;

    try {
        const chapterRow = await resolveChapter(chapterId);
        await pool.query(
            `INSERT INTO materials (title, subject, chapter, chapter_id, topic, material_type, external_url, description, uploaded_by, term)
             VALUES ($1,$2,$3,$4,$5,'link',$6,$7,$8,$9)`,
            [title.trim(), subject, chapterRow ? chapterRow.name : (chapter || null), chapterRow ? chapterRow.id : null,
             topic || null, externalUrl.trim(), description || null, req.user.email, termNum]
        );
        res.status(201).json({ success: true, message: 'Link published to students.' });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: 'Server error while saving the material link.' });
    }
});

// ---------------------------------------------------------------------------
// FACULTY: list own uploaded materials
// ---------------------------------------------------------------------------
app.get('/api/faculty/materials', authenticate, requireRole('faculty'), async (req, res) => {
    const { rows } = await pool.query(
        `SELECT id, title, subject, chapter, chapter_id, topic, material_type, file_name, mime_type, file_size, external_url, description, term, created_at
         FROM materials WHERE uploaded_by = $1 ORDER BY created_at DESC`,
        [req.user.email]
    );
    res.json(rows);
});

// ---------------------------------------------------------------------------
// FACULTY: edit a material's metadata (title, chapter, topic, term,
// description, and — for link-type materials only — the URL). Replacing
// the underlying file itself is not supported here; faculty can delete and
// re-upload if the file content needs to change, which keeps this edit
// path simple and avoids silently invalidating any cached downloads.
// ---------------------------------------------------------------------------
app.put('/api/faculty/materials/:id', authenticate, requireRole('faculty'), async (req, res) => {
    const { title, chapterId, topic, description, term, externalUrl } = req.body;
    if (!title?.trim()) return res.status(400).json({ error: 'Title is required.' });

    try {
        const { rows: [existing] } = await pool.query(
            `SELECT * FROM materials WHERE id = $1 AND uploaded_by = $2`, [req.params.id, req.user.email]
        );
        if (!existing) return res.status(404).json({ error: 'Material not found or not owned by you.' });

        const chapterRow = await resolveChapter(chapterId);
        const termNum = [1, 2, 3].includes(parseInt(term, 10)) ? parseInt(term, 10) : null;

        if (existing.material_type === 'link' && externalUrl) {
            if (!/^https?:\/\//i.test(externalUrl)) return res.status(400).json({ error: 'Please provide a valid URL.' });
            await pool.query(
                `UPDATE materials SET title=$1, chapter=$2, chapter_id=$3, topic=$4, description=$5, term=$6, external_url=$7 WHERE id=$8`,
                [title.trim(), chapterRow ? chapterRow.name : existing.chapter, chapterRow ? chapterRow.id : existing.chapter_id,
                 topic ?? existing.topic, description ?? existing.description, termNum ?? existing.term, externalUrl.trim(), req.params.id]
            );
        } else {
            await pool.query(
                `UPDATE materials SET title=$1, chapter=$2, chapter_id=$3, topic=$4, description=$5, term=$6 WHERE id=$7`,
                [title.trim(), chapterRow ? chapterRow.name : existing.chapter, chapterRow ? chapterRow.id : existing.chapter_id,
                 topic ?? existing.topic, description ?? existing.description, termNum ?? existing.term, req.params.id]
            );
        }
        res.json({ success: true, message: 'Material updated.' });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: 'Server error while updating the material.' });
    }
});

app.delete('/api/faculty/materials/:id', authenticate, requireRole('faculty'), async (req, res) => {
    const { rowCount } = await pool.query(
        `DELETE FROM materials WHERE id = $1 AND uploaded_by = $2`,
        [req.params.id, req.user.email]
    );
    if (rowCount === 0) return res.status(404).json({ error: 'Material not found or not owned by you.' });
    res.json({ success: true });
});

// ---------------------------------------------------------------------------
// STUDENT (and anyone authenticated): browse all published materials
// ---------------------------------------------------------------------------
app.get('/api/materials', authenticate, async (req, res) => {
    const { subject, term, topic, chapterId } = req.query;
    try {
        const { rows } = await pool.query(
            `SELECT m.id, m.title, m.subject, m.chapter, m.chapter_id, m.topic, m.material_type, m.file_name, m.mime_type,
                    m.file_size, m.external_url, m.description, m.term, m.created_at, f.name AS uploaded_by_name,
                    COALESCE(mp.viewed, FALSE) AS viewed, COALESCE(mp.downloaded, FALSE) AS downloaded,
                    COALESCE(mp.completed, FALSE) AS completed
             FROM materials m
             LEFT JOIN faculty f ON m.uploaded_by = f.email
             LEFT JOIN material_progress mp ON mp.material_id = m.id AND mp.student_email = $5
             WHERE ($1::text IS NULL OR m.subject = $1)
               AND ($2::int IS NULL OR m.term = $2)
               AND ($3::text IS NULL OR m.chapter = $3)
               AND ($4::int IS NULL OR m.chapter_id = $4)
             ORDER BY m.term ASC NULLS LAST, m.chapter ASC NULLS LAST, m.created_at DESC`,
            [subject || null, term ? parseInt(term, 10) : null, topic || null, chapterId ? parseInt(chapterId, 10) : null,
             req.user.role === 'student' ? req.user.email : null]
        );
        res.json(rows);
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: 'Server error while listing materials.' });
    }
});

// ---------------------------------------------------------------------------
// Download a file-based material (auth required so only registered users
// can pull course files)
// ---------------------------------------------------------------------------
app.get('/api/materials/:id/download', authenticate, async (req, res) => {
    try {
        const { rows: [m] } = await pool.query(
            `SELECT file_name, mime_type, file_data FROM materials WHERE id = $1 AND material_type = 'file'`,
            [req.params.id]
        );
        if (!m || !m.file_data) return res.status(404).json({ error: 'File not found.' });
        if (req.user.role === 'student') {
            pool.query(
                `INSERT INTO material_progress (student_email, material_id, downloaded, viewed, updated_at)
                 VALUES ($1,$2,TRUE,TRUE,NOW())
                 ON CONFLICT (student_email, material_id) DO UPDATE SET downloaded = TRUE, viewed = TRUE, updated_at = NOW()`,
                [req.user.email, req.params.id]
            ).catch(() => {}); // best-effort tracking, never blocks the download
        }
        res.setHeader('Content-Type', m.mime_type || 'application/octet-stream');
        res.setHeader('Content-Disposition', `attachment; filename="${m.file_name.replace(/"/g, '')}"`);
        res.send(m.file_data);
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: 'Server error while downloading material.' });
    }
});

app.get('/api/admin/analytics-summary', authenticate, requireRole('admin'), async (req, res) => {
    const { rows } = await pool.query(`
        SELECT s.email, s.name, s.category, s.aim,
               p.bio_accuracy, p.phy_accuracy, p.chem_accuracy, p.quiz_count
        FROM students s
        JOIN progress p ON s.email = p.email
        ORDER BY s.created_at DESC
    `);
    res.json(rows);
});

app.post('/api/admin/reset-all', authenticate, requireRole('admin'), async (req, res) => {
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

app.get('/api/admin/feedback', authenticate, requireRole('admin'), async (req, res) => {
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

// ===========================================================================
// TEST MANAGEMENT SYSTEM (Faculty creates, Students attempt)
// ===========================================================================

// ---------------------------------------------------------------------------
// FACULTY: create a test with MCQ / fill-in-the-blank questions
// ---------------------------------------------------------------------------
app.post('/api/faculty/tests', authenticate, requireRole('faculty'), async (req, res) => {
    const {
        title, subject, chapter, chapterId, difficulty, timeLimitMin,
        negativeMarking, randomize, scheduledAt, questions,
        assignedEmails, groupName
    } = req.body;

    if (!title?.trim() || !subject?.trim())
        return res.status(400).json({ error: 'Title and subject are required.' });
    if (!Array.isArray(questions) || questions.length === 0)
        return res.status(400).json({ error: 'At least one question is required.' });

    for (const q of questions) {
        if (!q.questionText?.trim() || !q.correctAnswer?.toString().trim()) {
            return res.status(400).json({ error: 'Every question needs text and a correct answer.' });
        }
        if (q.qType === 'mcq' && (!Array.isArray(q.options) || q.options.length < 2)) {
            return res.status(400).json({ error: 'MCQ questions need at least two options.' });
        }
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const chapterRow = await resolveChapter(chapterId);
        const { rows: [test] } = await client.query(
            `INSERT INTO tests (title, subject, chapter, chapter_id, difficulty, time_limit_min, negative_marking, randomize, scheduled_at, created_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
            [title.trim(), subject, chapterRow ? chapterRow.name : (chapter || null), chapterRow ? chapterRow.id : null, difficulty || 'Medium',
             timeLimitMin || 30, !!negativeMarking, !!randomize, scheduledAt || null, req.user.email]
        );

        for (let i = 0; i < questions.length; i++) {
            const q = questions[i];
            await client.query(
                `INSERT INTO test_questions (test_id, q_type, question_text, options, correct_answer, topic, subtopic, concept, difficulty, position, ocr_source)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
                [test.id, q.qType || 'mcq', q.questionText.trim(),
                 q.qType === 'mcq' ? JSON.stringify(q.options) : null,
                 q.correctAnswer.toString().trim(),
                 q.topic || null, q.subtopic || null, q.concept || null, q.difficulty || difficulty || 'Medium', i, !!q.ocrSource]
            );
        }

        // Optional assignment to specific students/groups (Section 4.1 of
        // the Physics Student Module spec). If no emails are given, the
        // test stays visible to every student — identical to prior behaviour.
        if (Array.isArray(assignedEmails) && assignedEmails.length > 0) {
            for (const email of assignedEmails) {
                const clean = (email || '').trim().toLowerCase();
                if (!clean) continue;
                await client.query(
                    `INSERT INTO test_assignments (test_id, student_email, group_name)
                     VALUES ($1,$2,$3) ON CONFLICT (test_id, student_email) DO NOTHING`,
                    [test.id, clean, groupName || null]
                );
            }
        }

        await client.query('COMMIT');
        res.status(201).json({ success: true, test });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error(err);
        res.status(500).json({ error: 'Server error while creating test.' });
    } finally {
        client.release();
    }
});

// ---------------------------------------------------------------------------
// FACULTY: fetch one of their own tests WITH correct answers, for editing
// (the student-facing GET /api/student/tests/:id deliberately omits
// correct_answer — this is the faculty/owner-only equivalent).
// ---------------------------------------------------------------------------
app.get('/api/faculty/tests/:id', authenticate, requireRole('faculty'), async (req, res) => {
    try {
        const { rows: [test] } = await pool.query(
            `SELECT * FROM tests WHERE id = $1 AND created_by = $2`, [req.params.id, req.user.email]
        );
        if (!test) return res.status(404).json({ error: 'Test not found or not owned by you.' });

        const { rows: questions } = await pool.query(
            `SELECT * FROM test_questions WHERE test_id = $1 ORDER BY position ASC`, [req.params.id]
        );
        const { rows: assignments } = await pool.query(
            `SELECT student_email, group_name FROM test_assignments WHERE test_id = $1`, [req.params.id]
        );
        res.json({ test, questions, assignments });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error while fetching the test.' });
    }
});

// ---------------------------------------------------------------------------
// FACULTY: edit an existing test — metadata + full question replacement.
// Replacing the question set wholesale (rather than diffing) keeps this
// consistent with the create flow and avoids partial-edit ambiguity; any
// past student attempts/mistake-log rows referencing this test_id are
// preserved (test_attempts/mistakes only reference test_id, not specific
// test_questions rows beyond a soft question_id pointer already used for
// historical reporting).
// ---------------------------------------------------------------------------
app.put('/api/faculty/tests/:id', authenticate, requireRole('faculty'), async (req, res) => {
    const {
        title, subject, chapter, chapterId, difficulty, timeLimitMin,
        negativeMarking, randomize, scheduledAt, questions
    } = req.body;

    if (!title?.trim() || !subject?.trim())
        return res.status(400).json({ error: 'Title and subject are required.' });
    if (!Array.isArray(questions) || questions.length === 0)
        return res.status(400).json({ error: 'At least one question is required.' });

    for (const q of questions) {
        if (!q.questionText?.trim() || !q.correctAnswer?.toString().trim()) {
            return res.status(400).json({ error: 'Every question needs text and a correct answer.' });
        }
        if (q.qType === 'mcq' && (!Array.isArray(q.options) || q.options.length < 2)) {
            return res.status(400).json({ error: 'MCQ questions need at least two options.' });
        }
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const { rows: [owned] } = await client.query(
            `SELECT id FROM tests WHERE id = $1 AND created_by = $2`, [req.params.id, req.user.email]
        );
        if (!owned) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Test not found or not owned by you.' });
        }

        const chapterRow = await resolveChapter(chapterId);
        const { rows: [test] } = await client.query(
            `UPDATE tests SET title=$1, subject=$2, chapter=$3, chapter_id=$4, difficulty=$5, time_limit_min=$6,
                    negative_marking=$7, randomize=$8, scheduled_at=$9
             WHERE id = $10 RETURNING *`,
            [title.trim(), subject, chapterRow ? chapterRow.name : (chapter || null), chapterRow ? chapterRow.id : null,
             difficulty || 'Medium', timeLimitMin || 30, !!negativeMarking, !!randomize, scheduledAt || null, req.params.id]
        );

        await client.query(`DELETE FROM test_questions WHERE test_id = $1`, [req.params.id]);
        for (let i = 0; i < questions.length; i++) {
            const q = questions[i];
            await client.query(
                `INSERT INTO test_questions (test_id, q_type, question_text, options, correct_answer, topic, subtopic, concept, difficulty, position, ocr_source)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
                [test.id, q.qType || 'mcq', q.questionText.trim(),
                 q.qType === 'mcq' ? JSON.stringify(q.options) : null,
                 q.correctAnswer.toString().trim(),
                 q.topic || null, q.subtopic || null, q.concept || null, q.difficulty || difficulty || 'Medium', i, !!q.ocrSource]
            );
        }

        await client.query('COMMIT');
        res.json({ success: true, test });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error(err);
        res.status(500).json({ error: 'Server error while updating the test.' });
    } finally {
        client.release();
    }
});

// ---------------------------------------------------------------------------
// FACULTY: bulk test-text extraction — the faculty pastes the whole test
// text in one go and AI (with a rule-based fallback when no AI key is
// configured) arranges it into individual questions/options. This returns a
// PREVIEW only (nothing is saved to the database here). Importantly, the
// correct answer is ALWAYS stripped from the AI/rule-based result before it
// reaches the client — the answer key is the faculty member's own call, not
// something OCR/AI should guess. The faculty reviews/edits the result in the
// UI and sets every correct answer themselves, then confirms by calling the
// normal POST /api/faculty/tests (or PUT /api/faculty/tests/:id) endpoint.
// ---------------------------------------------------------------------------
app.post('/api/faculty/tests/extract-questions', authenticate, requireRole('faculty'), async (req, res) => {
    const { rawText } = req.body;
    if (!rawText || rawText.trim().length < 20) {
        return res.status(400).json({ error: 'Please paste more of the test text before extracting questions.' });
    }

    try {
        let questions = await structureWithAI(rawText);
        let method = 'ai-assisted';
        if (!questions) {
            questions = parseQuestionsRuleBased(rawText);
            method = 'rule-based';
        }
        if (!questions || questions.length === 0) {
            return res.status(422).json({ error: 'No questions could be identified in this text. Please check the formatting, or add questions manually below.' });
        }

        // Never trust an AI/pattern-matched answer key — the faculty member
        // sets the correct option for every question themselves in the UI.
        const cleaned = questions.map(q => ({
            questionText: q.questionText,
            options: q.options,
            topic: q.topic,
            difficulty: q.difficulty,
            correctAnswerIndex: null,
            needsReview: true
        }));

        res.json({ success: true, method, questions: cleaned });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: 'Server error while arranging this text into questions. Please try again or add questions manually.' });
    }
});


// ---------------------------------------------------------------------------
// FACULTY: assign (or re-assign) an existing test to specific students
// ---------------------------------------------------------------------------
app.post('/api/faculty/tests/:id/assign', authenticate, requireRole('faculty'), async (req, res) => {
    const { emails, groupName } = req.body;
    if (!Array.isArray(emails) || emails.length === 0)
        return res.status(400).json({ error: 'Provide at least one student email.' });

    try {
        const { rows: [test] } = await pool.query(`SELECT id FROM tests WHERE id = $1 AND created_by = $2`, [req.params.id, req.user.email]);
        if (!test) return res.status(404).json({ error: 'Test not found or not owned by you.' });

        for (const email of emails) {
            const clean = (email || '').trim().toLowerCase();
            if (!clean) continue;
            await pool.query(
                `INSERT INTO test_assignments (test_id, student_email, group_name)
                 VALUES ($1,$2,$3) ON CONFLICT (test_id, student_email) DO UPDATE SET group_name = $3`,
                [test.id, clean, groupName || null]
            );
        }
        res.json({ success: true, assignedCount: emails.length });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error while assigning the test.' });
    }
});

// ---------------------------------------------------------------------------
// FACULTY: list own tests
// ---------------------------------------------------------------------------
app.get('/api/faculty/tests', authenticate, requireRole('faculty'), async (req, res) => {
    const { rows } = await pool.query(
        `SELECT t.*, (SELECT COUNT(*) FROM test_questions q WHERE q.test_id = t.id) AS question_count,
                (SELECT COUNT(*) FROM test_attempts a WHERE a.test_id = t.id) AS attempt_count
         FROM tests t WHERE t.created_by = $1 ORDER BY t.created_at DESC`,
        [req.user.email]
    );
    res.json(rows);
});

// ---------------------------------------------------------------------------
// STUDENT: list available tests (scheduled now or in the past, not yet attempted)
// ---------------------------------------------------------------------------
app.get('/api/student/tests', authenticate, requireRole('student'), async (req, res) => {
    const { rows } = await pool.query(
        `SELECT t.id, t.title, t.subject, t.chapter, t.difficulty, t.time_limit_min,
                t.negative_marking, t.scheduled_at,
                (SELECT COUNT(*) FROM test_questions q WHERE q.test_id = t.id) AS question_count,
                EXISTS(SELECT 1 FROM test_attempts a WHERE a.test_id = t.id AND a.student_email = $1) AS attempted
         FROM tests t
         WHERE (t.scheduled_at IS NULL OR t.scheduled_at <= NOW())
           AND (
                NOT EXISTS (SELECT 1 FROM test_assignments ta WHERE ta.test_id = t.id)
                OR EXISTS (SELECT 1 FROM test_assignments ta WHERE ta.test_id = t.id AND ta.student_email = $1)
           )
         ORDER BY t.created_at DESC`,
        [req.user.email]
    );
    res.json(rows);
});

// ---------------------------------------------------------------------------
// STUDENT: test history (Section 4.4 — scores, trends, comparative performance)
// ---------------------------------------------------------------------------
app.get('/api/student/tests/history', authenticate, requireRole('student'), async (req, res) => {
    try {
        const { rows } = await pool.query(
            `SELECT a.id, a.test_id, t.title, t.subject, t.chapter, a.score, a.total, a.submitted_at
             FROM test_attempts a JOIN tests t ON a.test_id = t.id
             WHERE a.student_email = $1
             ORDER BY a.submitted_at ASC`,
            [req.user.email]
        );

        const withAccuracy = rows.map(r => ({
            ...r,
            accuracy: r.total > 0 ? Math.round((r.score / r.total) * 1000) / 10 : null
        }));

        let improvementTrend = null;
        if (withAccuracy.length >= 2) {
            const first = withAccuracy[0].accuracy ?? 0;
            const last = withAccuracy[withAccuracy.length - 1].accuracy ?? 0;
            improvementTrend = Math.round((last - first) * 10) / 10;
        }

        // Comparative performance: how this student's average stacks up
        // against the average of everyone else who attempted the same tests.
        const { rows: cohort } = await pool.query(
            `SELECT AVG(a.score::float / NULLIF(a.total,0)) * 100 AS cohort_avg_accuracy
             FROM test_attempts a JOIN tests t ON a.test_id = t.id
             WHERE t.id IN (SELECT DISTINCT test_id FROM test_attempts WHERE student_email = $1)`,
            [req.user.email]
        );

        res.json({
            history: withAccuracy,
            improvementTrend,
            cohortAverageAccuracy: cohort[0]?.cohort_avg_accuracy != null
                ? Math.round(parseFloat(cohort[0].cohort_avg_accuracy) * 10) / 10
                : null
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error while fetching test history.' });
    }
});

// ---------------------------------------------------------------------------
// STUDENT: fetch a test for attempting (answers/correct values withheld)
// ---------------------------------------------------------------------------
app.get('/api/student/tests/:id', authenticate, requireRole('student'), async (req, res) => {
    const { rows: [test] } = await pool.query(`SELECT * FROM tests WHERE id = $1`, [req.params.id]);
    if (!test) return res.status(404).json({ error: 'Test not found.' });

    let { rows: questions } = await pool.query(
        `SELECT id, q_type, question_text, options, topic, subtopic, difficulty, position
         FROM test_questions WHERE test_id = $1 ORDER BY position ASC`,
        [req.params.id]
    );

    if (test.randomize) {
        questions = questions.slice().sort(() => Math.random() - 0.5);
    }

    res.json({ test, questions });
});

// ---------------------------------------------------------------------------
// STUDENT: submit attempt -> auto-grade + mistake analysis
// ---------------------------------------------------------------------------
app.post('/api/student/tests/:id/submit', authenticate, requireRole('student'), async (req, res) => {
    const testId = req.params.id;
    const { answers } = req.body; // [{ questionId, answer }]
    const email = req.user.email;

    if (!Array.isArray(answers)) return res.status(400).json({ error: 'answers must be an array.' });

    try {
        const { rows: [test] } = await pool.query(`SELECT * FROM tests WHERE id = $1`, [testId]);
        if (!test) return res.status(404).json({ error: 'Test not found.' });

        const { rows: questions } = await pool.query(`SELECT * FROM test_questions WHERE test_id = $1`, [testId]);
        const qMap = new Map(questions.map(q => [q.id, q]));

        let correctCount = 0;
        let attemptedCount = 0;
        const perQuestion = [];

        for (const a of answers) {
            const q = qMap.get(a.questionId);
            if (!q) continue;
            const given = (a.answer ?? '').toString().trim();
            const expected = q.correct_answer.toString().trim();
            const isCorrect = given !== '' && (
                q.q_type === 'mcq'
                    ? given === expected
                    : given.toLowerCase() === expected.toLowerCase()
            );
            if (given !== '') attemptedCount += 1;
            if (isCorrect) correctCount += 1;
            perQuestion.push({ question: q, given, isCorrect, attempted: given !== '' });
        }

        let rawScore = correctCount;
        if (test.negative_marking) {
            const incorrectAttempted = perQuestion.filter(p => p.attempted && !p.isCorrect).length;
            rawScore = correctCount - incorrectAttempted * 0.25;
        }

        await pool.query(
            `INSERT INTO test_attempts (test_id, student_email, answers, score, total)
             VALUES ($1,$2,$3,$4,$5)`,
            [testId, email, JSON.stringify(answers), rawScore, questions.length]
        );

        // ---- Mistake Analysis Engine ----
        for (const p of perQuestion) {
            if (p.isCorrect) continue;
            const mistakeType = !p.attempted ? 'unattempted'
                : (p.question.q_type === 'fill_blank' ? 'memory' : 'conceptual');
            await pool.query(
                `INSERT INTO mistakes (student_email, test_id, question_id, subject, topic, subtopic, concept, difficulty, mistake_type)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
                [email, testId, p.question.id, test.subject, p.question.topic, p.question.subtopic, p.question.concept, p.question.difficulty, mistakeType]
            );
        }

        // ---- Update subject accuracy in `progress` (reuses existing blend logic) ----
        const { rows: [progress] } = await pool.query(`SELECT * FROM progress WHERE email = $1`, [email]);
        if (progress && questions.length > 0) {
            const subjectKey = test.subject === 'Biology' ? 'bio' : test.subject === 'Physics' ? 'phy' : test.subject === 'Chemistry' ? 'chem' : null;
            if (subjectKey) {
                const attemptAcc = (correctCount / questions.length) * 100;
                const colMap = { bio: 'bio_accuracy', phy: 'phy_accuracy', chem: 'chem_accuracy' };
                const col = colMap[subjectKey];
                const oldVal = progress[col];
                const blended = Math.round((oldVal * 0.7 + attemptAcc * 0.3) * 10) / 10;
                let history = [];
                try { history = JSON.parse(progress.weekly_history); } catch (_) {}
                history.push(blended);
                if (history.length > 7) history = history.slice(-7);
                await pool.query(
                    `UPDATE progress SET ${col} = $1, quiz_count = quiz_count + 1, weekly_history = $2 WHERE email = $3`,
                    [blended, JSON.stringify(history), email]
                );
            }
        }

        res.json({
            score: rawScore,
            total: questions.length,
            correctCount,
            attemptedCount,
            accuracy: Math.round((correctCount / questions.length) * 100),
            results: perQuestion.map(p => ({
                questionId: p.question.id,
                questionText: p.question.question_text,
                yourAnswer: p.given,
                correctAnswer: p.question.correct_answer,
                isCorrect: p.isCorrect,
                topic: p.question.topic
            }))
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error while submitting test.' });
    }
});

// ---------------------------------------------------------------------------
// STUDENT: mistake analysis summary (per-topic breakdown + recommendations)
// ---------------------------------------------------------------------------
app.get('/api/student/mistake-analysis', authenticate, requireRole('student'), async (req, res) => {
    try {
        const { rows } = await pool.query(
            `SELECT subject, topic, mistake_type, COUNT(*) AS count
             FROM mistakes WHERE student_email = $1
             GROUP BY subject, topic, mistake_type
             ORDER BY count DESC`,
            [req.user.email]
        );

        const { rows: totals } = await pool.query(
            `SELECT subject, topic, COUNT(*) AS attempts
             FROM mistakes WHERE student_email = $1
             GROUP BY subject, topic`,
            [req.user.email]
        );
        const totalMap = new Map(totals.map(t => [`${t.subject}::${t.topic}`, parseInt(t.attempts, 10)]));

        const bySubject = {};
        for (const r of rows) {
            bySubject[r.subject] = bySubject[r.subject] || [];
            bySubject[r.subject].push({
                topic: r.topic,
                mistakeType: r.mistake_type,
                count: parseInt(r.count, 10)
            });
        }

        const topMistakes = rows.slice(0, 5).map(r => ({
            subject: r.subject, topic: r.topic, mistakeType: r.mistake_type, count: parseInt(r.count, 10)
        }));
        const recommendations = await generateRecommendations(topMistakes);

        res.json({ bySubject, recommendations });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error while computing mistake analysis.' });
    }
});

// ===========================================================================
// LECTURER ANALYTICS DASHBOARD
// ===========================================================================
app.get('/api/faculty/analytics', authenticate, requireRole('faculty'), async (req, res) => {
    try {
        // Subject/topic-wide weak-area detection across all students who
        // attempted this faculty member's tests.
        const { rows: weakTopics } = await pool.query(
            `SELECT m.subject, m.topic, COUNT(DISTINCT m.student_email) AS weak_student_count
             FROM mistakes m
             JOIN tests t ON m.test_id = t.id
             WHERE t.created_by = $1
             GROUP BY m.subject, m.topic
             ORDER BY weak_student_count DESC
             LIMIT 10`,
            [req.user.email]
        );

        const { rows: scores } = await pool.query(
            `SELECT s.email, s.name, s.category, s.aim,
                    a.test_id, t.title, a.score, a.total, a.submitted_at
             FROM test_attempts a
             JOIN tests t ON a.test_id = t.id
             JOIN students s ON a.student_email = s.email
             WHERE t.created_by = $1
             ORDER BY a.submitted_at DESC
             LIMIT 100`,
            [req.user.email]
        );

        const { rows: avgScores } = await pool.query(
            `SELECT t.id AS test_id, t.title, t.subject, AVG(a.score) AS avg_score, AVG(a.total) AS total, COUNT(*) AS attempts
             FROM test_attempts a JOIN tests t ON a.test_id = t.id
             WHERE t.created_by = $1
             GROUP BY t.id, t.title, t.subject
             ORDER BY t.created_at DESC`,
            [req.user.email]
        );

        res.json({
            weakTopics: weakTopics.map(w => ({
                subject: w.subject, topic: w.topic, weakStudentCount: parseInt(w.weak_student_count, 10),
                message: `${w.weak_student_count} student(s) are weak in ${w.topic}.`
            })),
            recentAttempts: scores,
            testAverages: avgScores.map(a => ({
                testId: a.test_id, title: a.title, subject: a.subject,
                avgScore: Math.round(parseFloat(a.avg_score) * 10) / 10,
                total: parseInt(a.total, 10), attempts: parseInt(a.attempts, 10)
            }))
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error while computing analytics.' });
    }
});


// ===========================================================================
// ERROR ATLAS — HOTSPOT ANALYSIS (Faculty Module enhancement #4)
// Chapter-wise breakdown of where students most often go wrong: the
// specific questions with the highest error rate, plus the concepts/topics
// that show up most often across all logged mistakes for this faculty
// member's tests. Error rate per question = (times logged as a mistake) /
// (number of attempts on that question's test) — the existing data model
// only logs INCORRECT/unattempted answers (see the Mistake Analysis Engine
// in the test-submission handler above), so this is the most accurate rate
// available without adding a new "every answer, right or wrong" log table.
// ===========================================================================
app.get('/api/faculty/error-atlas', authenticate, requireRole('faculty'), async (req, res) => {
    try {
        // Attempts-per-test, used as the denominator for error percentage.
        const { rows: attemptCounts } = await pool.query(
            `SELECT t.id AS test_id, COUNT(a.id) AS attempts
             FROM tests t LEFT JOIN test_attempts a ON a.test_id = t.id
             WHERE t.created_by = $1
             GROUP BY t.id`,
            [req.user.email]
        );
        const attemptsByTest = new Map(attemptCounts.map(r => [r.test_id, parseInt(r.attempts, 10)]));

        // Per-question mistake counts, with chapter/topic context.
        const { rows: questionMistakes } = await pool.query(
            `SELECT t.id AS test_id, t.title AS test_title, t.subject,
                    COALESCE(c.name, t.chapter, 'Uncategorized') AS chapter,
                    q.id AS question_id, q.question_text, q.topic, q.difficulty,
                    COUNT(m.id) AS mistake_count
             FROM tests t
             JOIN test_questions q ON q.test_id = t.id
             LEFT JOIN chapters c ON t.chapter_id = c.id
             LEFT JOIN mistakes m ON m.question_id = q.id
             WHERE t.created_by = $1
             GROUP BY t.id, t.title, t.subject, c.name, t.chapter, q.id, q.question_text, q.topic, q.difficulty
             HAVING COUNT(m.id) > 0
             ORDER BY chapter, mistake_count DESC`,
            [req.user.email]
        );

        // Most frequently mistaken concepts/topics, chapter-wise.
        const { rows: conceptFrequency } = await pool.query(
            `SELECT COALESCE(c.name, t.chapter, 'Uncategorized') AS chapter, m.topic, COUNT(*) AS count
             FROM mistakes m
             JOIN tests t ON m.test_id = t.id
             LEFT JOIN chapters c ON t.chapter_id = c.id
             WHERE t.created_by = $1 AND m.topic IS NOT NULL
             GROUP BY c.name, t.chapter, m.topic
             ORDER BY chapter, count DESC`,
            [req.user.email]
        );

        // Group everything by chapter.
        const chapterMap = new Map();
        const getChapter = (name) => {
            if (!chapterMap.has(name)) chapterMap.set(name, { chapter: name, totalAttempts: 0, hotspotQuestions: [], frequentConcepts: [] });
            return chapterMap.get(name);
        };

        for (const row of questionMistakes) {
            const entry = getChapter(row.chapter);
            const attempts = attemptsByTest.get(row.test_id) || 0;
            entry.totalAttempts = Math.max(entry.totalAttempts, attempts);
            const mistakeCount = parseInt(row.mistake_count, 10);
            entry.hotspotQuestions.push({
                testId: row.test_id,
                testTitle: row.test_title,
                questionId: row.question_id,
                questionText: row.question_text,
                topic: row.topic,
                difficulty: row.difficulty,
                mistakeCount,
                errorPercentage: attempts > 0 ? Math.round((mistakeCount / attempts) * 1000) / 10 : null
            });
        }

        const conceptSeen = new Map();
        for (const row of conceptFrequency) {
            const entry = getChapter(row.chapter);
            entry.frequentConcepts.push({ topic: row.topic, count: parseInt(row.count, 10) });
        }

        const chapters = Array.from(chapterMap.values()).map(c => ({
            ...c,
            hotspotQuestions: c.hotspotQuestions
                .sort((a, b) => (b.errorPercentage ?? b.mistakeCount) - (a.errorPercentage ?? a.mistakeCount))
                .slice(0, 10),
            frequentConcepts: c.frequentConcepts.slice(0, 8)
        })).sort((a, b) => {
            const aMax = a.hotspotQuestions[0]?.errorPercentage ?? 0;
            const bMax = b.hotspotQuestions[0]?.errorPercentage ?? 0;
            return bMax - aMax;
        });

        res.json({ chapters });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error while building the Error Atlas.' });
    }
});


// ===========================================================================
// INDIVIDUAL STUDENT ANALYTICS (Faculty Module enhancement #3)
// Lets a faculty member pick a specific student and see their complete
// performance history: tests attempted, average score, chapter-wise
// strengths/weaknesses, materials/lectures progress, and a unified recent
// activity feed.
// ===========================================================================

// List students who've interacted with this faculty member's content
// (attempted one of their tests, or has activity on one of their
// materials/lectures) — keeps the picker focused and relevant rather than
// dumping the entire student roster on every faculty account.
app.get('/api/faculty/students', authenticate, requireRole('faculty'), async (req, res) => {
    try {
        const { rows } = await pool.query(
            `SELECT DISTINCT s.email, s.name, s.category, s.aim
             FROM students s
             WHERE s.email IN (
                 SELECT a.student_email FROM test_attempts a JOIN tests t ON a.test_id = t.id WHERE t.created_by = $1
                 UNION
                 SELECT mp.student_email FROM material_progress mp JOIN materials m ON mp.material_id = m.id WHERE m.uploaded_by = $1
                 UNION
                 SELECT lp.student_email FROM lecture_progress lp JOIN lectures l ON lp.lecture_id = l.id WHERE l.lecturer_email = $1
             )
             ORDER BY s.name ASC`,
            [req.user.email]
        );
        res.json(rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error while listing students.' });
    }
});

app.get('/api/faculty/students/:email/analytics', authenticate, requireRole('faculty'), async (req, res) => {
    const studentEmail = req.params.email.toLowerCase();
    try {
        const { rows: [student] } = await pool.query(`SELECT email, name, category, aim FROM students WHERE email = $1`, [studentEmail]);
        if (!student) return res.status(404).json({ error: 'Student not found.' });

        const { rows: attempts } = await pool.query(
            `SELECT a.id, a.test_id, a.answers, a.score, a.total, a.submitted_at,
                    t.title, t.subject, COALESCE(c.name, t.chapter, 'Uncategorized') AS chapter
             FROM test_attempts a
             JOIN tests t ON a.test_id = t.id
             LEFT JOIN chapters c ON t.chapter_id = c.id
             WHERE a.student_email = $1
             ORDER BY a.submitted_at ASC`,
            [studentEmail]
        );

        // Batch-fetch every question referenced by these attempts, then
        // re-grade in memory (same comparison rule as the submit handler)
        // to get a true per-chapter correct/total breakdown — the
        // `mistakes` table alone only tells us about wrong answers, not the
        // denominator of questions attempted per chapter.
        const testIds = [...new Set(attempts.map(a => a.test_id))];
        let questionsByTest = new Map();
        if (testIds.length > 0) {
            const { rows: questions } = await pool.query(
                `SELECT * FROM test_questions WHERE test_id = ANY($1::int[])`, [testIds]
            );
            for (const q of questions) {
                if (!questionsByTest.has(q.test_id)) questionsByTest.set(q.test_id, []);
                questionsByTest.get(q.test_id).push(q);
            }
        }

        const chapterStats = new Map(); // chapter -> { correct, total }
        const progressOverTime = [];
        let totalScoreSum = 0, totalQuestionsSum = 0;

        for (const attempt of attempts) {
            const questions = questionsByTest.get(attempt.test_id) || [];
            const qMap = new Map(questions.map(q => [q.id, q]));
            let answers = [];
            if (Array.isArray(attempt.answers)) answers = attempt.answers;
            else if (typeof attempt.answers === 'string') {
                try { answers = JSON.parse(attempt.answers); } catch (_) {}
            }

            let correctCount = 0;
            for (const a of answers) {
                const q = qMap.get(a.questionId);
                if (!q) continue;
                const given = (a.answer ?? '').toString().trim();
                const expected = q.correct_answer.toString().trim();
                const isCorrect = given !== '' && (q.q_type === 'mcq' ? given === expected : given.toLowerCase() === expected.toLowerCase());
                if (isCorrect) correctCount += 1;

                const stat = chapterStats.get(attempt.chapter) || { correct: 0, total: 0 };
                stat.total += 1;
                if (isCorrect) stat.correct += 1;
                chapterStats.set(attempt.chapter, stat);
            }

            totalScoreSum += parseFloat(attempt.score) || 0;
            totalQuestionsSum += attempt.total || 0;
            progressOverTime.push({
                testId: attempt.test_id, title: attempt.title, subject: attempt.subject, chapter: attempt.chapter,
                score: attempt.score, total: attempt.total,
                accuracyPercent: questions.length > 0 ? Math.round((correctCount / questions.length) * 1000) / 10 : null,
                submittedAt: attempt.submitted_at
            });
        }

        const chapterWisePerformance = Array.from(chapterStats.entries()).map(([chapter, s]) => ({
            chapter, correct: s.correct, total: s.total,
            accuracyPercent: s.total > 0 ? Math.round((s.correct / s.total) * 1000) / 10 : null
        })).sort((a, b) => (b.accuracyPercent ?? 0) - (a.accuracyPercent ?? 0));

        const strongChapters = chapterWisePerformance.filter(c => c.total >= 2 && c.accuracyPercent >= 70);
        const weakChapters = chapterWisePerformance.filter(c => c.total >= 2 && c.accuracyPercent < 50);

        const { rows: materialStats } = await pool.query(
            `SELECT COUNT(*) FILTER (WHERE completed) AS completed, COUNT(*) FILTER (WHERE viewed OR downloaded) AS engaged, COUNT(*) AS total
             FROM material_progress WHERE student_email = $1`,
            [studentEmail]
        );
        const { rows: lectureStats } = await pool.query(
            `SELECT COUNT(*) FILTER (WHERE completed) AS completed, COUNT(*) AS total
             FROM lecture_progress WHERE student_email = $1`,
            [studentEmail]
        );

        // Unified recent activity feed across tests, materials and lectures.
        const { rows: recentMaterials } = await pool.query(
            `SELECT m.title, mp.updated_at, 'material' AS kind,
                    CASE WHEN mp.completed THEN 'completed' WHEN mp.downloaded THEN 'downloaded' ELSE 'viewed' END AS detail
             FROM material_progress mp JOIN materials m ON mp.material_id = m.id
             WHERE mp.student_email = $1 ORDER BY mp.updated_at DESC LIMIT 10`,
            [studentEmail]
        );
        const { rows: recentLectures } = await pool.query(
            `SELECT l.title, lp.updated_at, 'lecture' AS kind,
                    CASE WHEN lp.completed THEN 'completed' ELSE 'in progress' END AS detail
             FROM lecture_progress lp JOIN lectures l ON lp.lecture_id = l.id
             WHERE lp.student_email = $1 ORDER BY lp.updated_at DESC LIMIT 10`,
            [studentEmail]
        );
        const recentTests = attempts.slice(-10).reverse().map(a => ({
            title: a.title, updated_at: a.submitted_at, kind: 'test', detail: `scored ${a.score}/${a.total}`
        }));

        const recentActivity = [...recentMaterials, ...recentLectures, ...recentTests]
            .sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at))
            .slice(0, 15);

        res.json({
            student,
            testsAttempted: attempts.length,
            averageScore: attempts.length > 0 ? Math.round((totalScoreSum / attempts.length) * 10) / 10 : null,
            averageAccuracyPercent: totalQuestionsSum > 0 ? Math.round((progressOverTime.reduce((s, p) => s + (p.accuracyPercent || 0), 0) / progressOverTime.length) * 10) / 10 : null,
            chapterWisePerformance,
            strongChapters,
            weakChapters,
            materialsCompleted: parseInt(materialStats[0]?.completed || 0, 10),
            materialsEngaged: parseInt(materialStats[0]?.engaged || 0, 10),
            lecturesWatched: parseInt(lectureStats[0]?.completed || 0, 10),
            progressOverTime,
            recentActivity
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error while computing student analytics.' });
    }
});


app.get('/api/student/:email', async (req, res) => {
    const bundle = await getStudentBundle(req.params.email);
    if (!bundle) return res.status(404).json({ error: 'Student not found.' });
    res.json(bundle);
});


// ===========================================================================
// PHYSICS STUDENT MODULE (additive)
// Implements: entry-level diagnostics with proficiency classification,
// Term-organised materials, lecture/material progress tracking, topic-wise
// Physics analytics, personalised recommendations, and a dashboard summary.
// Mirrors the existing patterns above; does not modify any pre-existing
// Biology/Chemistry/general-Physics behaviour.
// ===========================================================================

// ---------------------------------------------------------------------------
// Shared helper: aggregate this student's Physics topic-wise accuracy from
// their entry-test attempts, plus raw mistake counts from any Physics test
// (entry or faculty-assigned) they've taken.
// ---------------------------------------------------------------------------
async function computePhysicsTopicAnalytics(email) {
    const { rows: attempts } = await pool.query(
        `SELECT topic_breakdown FROM physics_entry_attempts WHERE student_email = $1`,
        [email]
    );

    const agg = {}; // topic -> { correct, total }
    for (const a of attempts) {
        const breakdown = a.topic_breakdown || {};
        for (const topic of Object.keys(breakdown)) {
            agg[topic] = agg[topic] || { correct: 0, total: 0 };
            agg[topic].correct += breakdown[topic].correct || 0;
            agg[topic].total += breakdown[topic].total || 0;
        }
    }

    const topicAccuracy = Object.keys(agg).map(topic => ({
        topic,
        correct: agg[topic].correct,
        total: agg[topic].total,
        accuracy: agg[topic].total > 0 ? Math.round((agg[topic].correct / agg[topic].total) * 1000) / 10 : 0
    })).sort((a, b) => b.accuracy - a.accuracy);

    const strongTopics = topicAccuracy.filter(t => t.accuracy >= 70 && t.total >= 2);
    const weakTopics = topicAccuracy.filter(t => t.accuracy < 50 && t.total >= 1).sort((a, b) => a.accuracy - b.accuracy);

    const { rows: mistakeRows } = await pool.query(
        `SELECT topic, mistake_type, COUNT(*) AS count
         FROM mistakes WHERE student_email = $1 AND subject = 'Physics'
         GROUP BY topic, mistake_type ORDER BY count DESC`,
        [email]
    );
    const mistakeBreakdown = mistakeRows.map(r => ({ topic: r.topic, mistakeType: r.mistake_type, count: parseInt(r.count, 10) }));

    return { topicAccuracy, strongTopics, weakTopics, mistakeBreakdown };
}

// ---------------------------------------------------------------------------
// STUDENT: list the 3 entry-level Physics tests, with each one's mandatory
// flag and this student's attempt status (Section 1.1)
// ---------------------------------------------------------------------------
app.get('/api/physics/entry-tests', authenticate, requireRole('student'), async (req, res) => {
    try {
        const { rows: tests } = await pool.query(`SELECT * FROM physics_entry_tests ORDER BY test_number ASC`);
        const { rows: attempts } = await pool.query(
            `SELECT test_number, score, total, proficiency_level, submitted_at
             FROM physics_entry_attempts WHERE student_email = $1 ORDER BY submitted_at DESC`,
            [req.user.email]
        );
        const latestByTest = {};
        for (const a of attempts) if (!latestByTest[a.test_number]) latestByTest[a.test_number] = a;

        res.json(tests.map(t => ({
            testNumber: t.test_number,
            title: t.title,
            mandatory: t.mandatory,
            attempted: !!latestByTest[t.test_number],
            lastAttempt: latestByTest[t.test_number] || null
        })));
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error while listing entry tests.' });
    }
});

// ---------------------------------------------------------------------------
// STUDENT: fetch an entry test's questions (correct answers withheld)
// ---------------------------------------------------------------------------
app.get('/api/physics/entry-tests/:testNumber', authenticate, requireRole('student'), async (req, res) => {
    const testNumber = parseInt(req.params.testNumber, 10);
    if (![1, 2, 3].includes(testNumber)) return res.status(400).json({ error: 'Invalid test number.' });

    try {
        const { rows: [test] } = await pool.query(`SELECT * FROM physics_entry_tests WHERE test_number = $1`, [testNumber]);
        if (!test) return res.status(404).json({ error: 'Entry test not found.' });

        const { rows: questions } = await pool.query(
            `SELECT id, topic, question_text, options, position FROM physics_entry_questions
             WHERE test_number = $1 ORDER BY position ASC`,
            [testNumber]
        );
        res.json({ test, questions });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error while fetching the entry test.' });
    }
});

// ---------------------------------------------------------------------------
// STUDENT: submit an entry test -> grade, topic breakdown, proficiency
// classification (Sections 1.3 – 1.5)
// ---------------------------------------------------------------------------
app.post('/api/physics/entry-tests/:testNumber/submit', authenticate, requireRole('student'), async (req, res) => {
    const testNumber = parseInt(req.params.testNumber, 10);
    const { answers, timeTakenSeconds } = req.body; // [{ questionId, answer }] answer = option index
    const email = req.user.email;
    if (![1, 2, 3].includes(testNumber)) return res.status(400).json({ error: 'Invalid test number.' });
    if (!Array.isArray(answers)) return res.status(400).json({ error: 'answers must be an array.' });

    try {
        const { rows: questions } = await pool.query(
            `SELECT * FROM physics_entry_questions WHERE test_number = $1`, [testNumber]
        );
        if (questions.length === 0) return res.status(404).json({ error: 'Entry test not found.' });
        const qMap = new Map(questions.map(q => [q.id, q]));

        let correctCount = 0;
        const topicBreakdown = {}; // topic -> { correct, total }
        const mistakesToLog = [];

        for (const q of questions) {
            const given = answers.find(a => a.questionId === q.id);
            const givenAnswer = given && given.answer !== '' && given.answer !== null && given.answer !== undefined
                ? parseInt(given.answer, 10) : null;
            const isCorrect = givenAnswer !== null && givenAnswer === q.correct_answer;

            topicBreakdown[q.topic] = topicBreakdown[q.topic] || { correct: 0, total: 0 };
            topicBreakdown[q.topic].total += 1;
            if (isCorrect) {
                topicBreakdown[q.topic].correct += 1;
                correctCount += 1;
            } else {
                mistakesToLog.push({ topic: q.topic, mistakeType: givenAnswer === null ? 'unattempted' : 'conceptual' });
            }
        }

        const total = questions.length;
        const percent = Math.round((correctCount / total) * 1000) / 10;
        const proficiencyLevel = classifyPhysicsProficiency(percent);

        await pool.query(
            `INSERT INTO physics_entry_attempts (student_email, test_number, answers, score, total, topic_breakdown, proficiency_level, time_taken_seconds)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
            [email, testNumber, JSON.stringify(answers), correctCount, total, JSON.stringify(topicBreakdown), proficiencyLevel, timeTakenSeconds || null]
        );

        await pool.query(`UPDATE students SET physics_proficiency = $1 WHERE email = $2`, [proficiencyLevel, email]);

        // Feed the same mistakes table used by the existing Mistake Analysis
        // Engine, so faculty Physics analytics and the student's general
        // mistake-analysis view also reflect entry-test performance.
        for (const m of mistakesToLog) {
            await pool.query(
                `INSERT INTO mistakes (student_email, test_id, question_id, subject, topic, mistake_type)
                 VALUES ($1, NULL, NULL, 'Physics', $2, $3)`,
                [email, m.topic, m.mistakeType]
            );
        }

        res.json({
            score: correctCount,
            total,
            accuracy: percent,
            proficiencyLevel,
            topicBreakdown
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error while submitting the entry test.' });
    }
});

// ---------------------------------------------------------------------------
// STUDENT: current Physics proficiency + entry-test attempt history
// ---------------------------------------------------------------------------
app.get('/api/physics/proficiency', authenticate, requireRole('student'), async (req, res) => {
    try {
        const { rows: [student] } = await pool.query(`SELECT physics_proficiency FROM students WHERE email = $1`, [req.user.email]);
        const { rows: attempts } = await pool.query(
            `SELECT test_number, score, total, proficiency_level, submitted_at FROM physics_entry_attempts
             WHERE student_email = $1 ORDER BY submitted_at ASC`,
            [req.user.email]
        );
        res.json({
            currentLevel: student?.physics_proficiency || null,
            attempts
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error while fetching proficiency.' });
    }
});

// ---------------------------------------------------------------------------
// Physics materials, organised topic-wise and Term-wise (Section 2 & 3)
// ---------------------------------------------------------------------------
app.get('/api/physics/materials', authenticate, async (req, res) => {
    try {
        const { rows } = await pool.query(
            `SELECT m.id, m.title, m.chapter AS topic, m.term, m.material_type, m.file_name, m.mime_type,
                    m.file_size, m.external_url, m.description, m.created_at,
                    COALESCE(mp.viewed, FALSE) AS viewed, COALESCE(mp.downloaded, FALSE) AS downloaded,
                    COALESCE(mp.completed, FALSE) AS completed
             FROM materials m
             LEFT JOIN material_progress mp ON mp.material_id = m.id AND mp.student_email = $1
             WHERE m.subject = 'Physics'
             ORDER BY m.chapter ASC NULLS LAST, m.term ASC NULLS LAST, m.created_at ASC`,
            [req.user.role === 'student' ? req.user.email : null]
        );

        // Group into { topic -> { 1: [...], 2: [...], 3: [...], untagged: [...] } }
        const grouped = {};
        for (const topic of PHYSICS_TOPICS) grouped[topic] = { 1: [], 2: [], 3: [], untagged: [] };
        for (const m of rows) {
            const topicKey = grouped[m.topic] ? m.topic : '__other__';
            if (!grouped[topicKey]) grouped[topicKey] = { 1: [], 2: [], 3: [], untagged: [] };
            const bucket = [1, 2, 3].includes(m.term) ? m.term : 'untagged';
            grouped[topicKey][bucket].push(m);
        }
        res.json({ topics: PHYSICS_TOPICS, materialsByTopic: grouped });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error while listing Physics materials.' });
    }
});

// ---------------------------------------------------------------------------
// STUDENT: mark a material as viewed / completed (Section 5.2 tracking)
// ---------------------------------------------------------------------------
app.post('/api/physics/materials/:id/view', authenticate, requireRole('student'), async (req, res) => {
    await pool.query(
        `INSERT INTO material_progress (student_email, material_id, viewed, updated_at)
         VALUES ($1,$2,TRUE,NOW())
         ON CONFLICT (student_email, material_id) DO UPDATE SET viewed = TRUE, updated_at = NOW()`,
        [req.user.email, req.params.id]
    );
    res.json({ success: true });
});

app.post('/api/physics/materials/:id/complete', authenticate, requireRole('student'), async (req, res) => {
    await pool.query(
        `INSERT INTO material_progress (student_email, material_id, viewed, completed, updated_at)
         VALUES ($1,$2,TRUE,TRUE,NOW())
         ON CONFLICT (student_email, material_id) DO UPDATE SET completed = TRUE, viewed = TRUE, updated_at = NOW()`,
        [req.user.email, req.params.id]
    );
    res.json({ success: true });
});

// ---------------------------------------------------------------------------
// Physics lectures merged with this student's watch progress (Section 5.1)
// ---------------------------------------------------------------------------
app.get('/api/physics/lectures', authenticate, async (req, res) => {
    try {
        const { rows } = await pool.query(
            `SELECT l.id, l.title, l.subject, l.url, l.lecturer_name,
                    COALESCE(lp.percent_watched, 0) AS percent_watched,
                    COALESCE(lp.last_position_seconds, 0) AS last_position_seconds,
                    COALESCE(lp.completed, FALSE) AS completed
             FROM lectures l
             LEFT JOIN lecture_progress lp ON lp.lecture_id = l.id AND lp.student_email = $1
             WHERE l.subject = 'Physics' AND l.approved = 1
             ORDER BY l.created_at DESC`,
            [req.user.role === 'student' ? req.user.email : null]
        );
        res.json(rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error while listing Physics lectures.' });
    }
});

// ---------------------------------------------------------------------------
// STUDENT: update lecture watch progress (percent watched + resume position)
// ---------------------------------------------------------------------------
app.post('/api/physics/lectures/:id/progress', authenticate, requireRole('student'), async (req, res) => {
    const percentWatched = Math.max(0, Math.min(100, parseFloat(req.body.percentWatched) || 0));
    const lastPositionSeconds = Math.max(0, parseInt(req.body.lastPositionSeconds, 10) || 0);
    const completed = percentWatched >= 95;

    await pool.query(
        `INSERT INTO lecture_progress (student_email, lecture_id, percent_watched, last_position_seconds, completed, updated_at)
         VALUES ($1,$2,$3,$4,$5,NOW())
         ON CONFLICT (student_email, lecture_id) DO UPDATE SET
            percent_watched = GREATEST(lecture_progress.percent_watched, $3),
            last_position_seconds = $4,
            completed = lecture_progress.completed OR $5,
            updated_at = NOW()`,
        [req.user.email, req.params.id, percentWatched, lastPositionSeconds, completed]
    );
    res.json({ success: true });
});

// ---------------------------------------------------------------------------
// STUDENT: topic-wise Physics analytics — strengths, weaknesses, mistakes
// (Section 6)
// ---------------------------------------------------------------------------
app.get('/api/physics/analytics', authenticate, requireRole('student'), async (req, res) => {
    try {
        const analytics = await computePhysicsTopicAnalytics(req.user.email);
        res.json(analytics);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error while computing Physics analytics.' });
    }
});

// ---------------------------------------------------------------------------
// STUDENT: personalised Physics recommendations (Section 7)
// ---------------------------------------------------------------------------
app.get('/api/physics/recommendations', authenticate, requireRole('student'), async (req, res) => {
    try {
        const { weakTopics } = await computePhysicsTopicAnalytics(req.user.email);
        const recommendations = generatePhysicsRecommendations(weakTopics);
        res.json({ recommendations });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error while generating recommendations.' });
    }
});

// ---------------------------------------------------------------------------
// STUDENT: Physics dashboard summary (Section 8)
// ---------------------------------------------------------------------------
app.get('/api/physics/dashboard', authenticate, requireRole('student'), async (req, res) => {
    const email = req.user.email;
    try {
        const { rows: [student] } = await pool.query(`SELECT physics_proficiency FROM students WHERE email = $1`, [email]);

        const { rows: [lectureTotals] } = await pool.query(
            `SELECT COUNT(*) AS total FROM lectures WHERE subject = 'Physics' AND approved = 1`
        );
        const { rows: [lectureDone] } = await pool.query(
            `SELECT COUNT(*) AS done FROM lecture_progress lp JOIN lectures l ON lp.lecture_id = l.id
             WHERE lp.student_email = $1 AND l.subject = 'Physics' AND lp.completed = TRUE`,
            [email]
        );

        const { rows: [materialTotals] } = await pool.query(
            `SELECT COUNT(*) AS total FROM materials WHERE subject = 'Physics'`
        );
        const { rows: [materialDone] } = await pool.query(
            `SELECT COUNT(*) AS done FROM material_progress mp JOIN materials m ON mp.material_id = m.id
             WHERE mp.student_email = $1 AND m.subject = 'Physics' AND mp.completed = TRUE`,
            [email]
        );

        const { rows: [entryAgg] } = await pool.query(
            `SELECT COUNT(*) AS count, AVG(score::float / NULLIF(total,0)) * 100 AS avg_pct
             FROM physics_entry_attempts WHERE student_email = $1`,
            [email]
        );
        const { rows: [facultyAgg] } = await pool.query(
            `SELECT COUNT(*) AS count, AVG(a.score::float / NULLIF(a.total,0)) * 100 AS avg_pct
             FROM test_attempts a JOIN tests t ON a.test_id = t.id
             WHERE a.student_email = $1 AND t.subject = 'Physics'`,
            [email]
        );

        const entryCount = parseInt(entryAgg.count, 10) || 0;
        const facultyCount = parseInt(facultyAgg.count, 10) || 0;
        const testsAttempted = entryCount + facultyCount;
        const avgPcts = [entryAgg.avg_pct, facultyAgg.avg_pct].filter(v => v !== null).map(parseFloat);
        const averageScore = avgPcts.length ? Math.round((avgPcts.reduce((s, v) => s + v, 0) / avgPcts.length) * 10) / 10 : null;

        const { strongTopics, weakTopics } = await computePhysicsTopicAnalytics(email);

        const { rows: [test1] } = await pool.query(
            `SELECT 1 FROM physics_entry_attempts WHERE student_email = $1 AND test_number = 1 LIMIT 1`, [email]
        );

        res.json({
            currentLevel: student?.physics_proficiency || 'Not yet assessed',
            entryTest1Required: !test1,
            lecturesCompleted: parseInt(lectureDone.done, 10),
            lecturesTotal: parseInt(lectureTotals.total, 10),
            materialsCompleted: parseInt(materialDone.done, 10),
            materialsTotal: parseInt(materialTotals.total, 10),
            testsAttempted,
            averageScore,
            strongTopics: strongTopics.map(t => t.topic),
            weakTopics: weakTopics.map(t => t.topic)
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error while building the Physics dashboard.' });
    }
});


app.get(/^\/(?!api).*/, (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'frontend', 'index.html'));
});

// ---------------------------------------------------------------------------
// START
// ---------------------------------------------------------------------------
initSchema()
    .then(() => app.listen(PORT, () => {
        console.log(`🚀  NEET CTK IGNITION running on http://localhost:${PORT}`);

        // Kick off a background fetch of real, current NEET cutoff data
        // (free web search + free AI extraction) without blocking startup.
        // Refreshes the upcoming exam year, then re-checks every 24h —
        // refreshCutoffCache itself is cheap to call repeatedly since it
        // only does real work when the cache is missing/stale.
        const targetYear = new Date().getFullYear() + 1;
        refreshCutoffCache(targetYear).catch(() => {});
        setInterval(() => refreshCutoffCache(targetYear).catch(() => {}), 24 * 60 * 60 * 1000);
    }))
    .catch(err => { console.error('Failed to initialise database:', err); process.exit(1); });
