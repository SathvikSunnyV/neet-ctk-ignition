// auth.js — NEET CTK IGNITION
// Authentication helpers: JWT issuing/verification, OTP generation,
// password hashing, email dispatch, and route-protection middleware.
// Designed to be additive — does not touch any existing route logic.

const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const nodemailer = require('nodemailer');

const JWT_SECRET = process.env.JWT_SECRET || 'ctk-ignition-dev-secret-change-me';
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '7d';
const OTP_TTL_MINUTES = 10;
const BCRYPT_ROUNDS = 10;

// ---------------------------------------------------------------------------
// PASSWORD HASHING
// ---------------------------------------------------------------------------
async function hashPassword(plain) {
    return bcrypt.hash(plain, BCRYPT_ROUNDS);
}

async function verifyPassword(plain, hash) {
    return bcrypt.compare(plain, hash);
}

// ---------------------------------------------------------------------------
// JWT
// ---------------------------------------------------------------------------
function signToken(user) {
    return jwt.sign(
        { id: user.id, email: user.email, role: user.role, name: user.name },
        JWT_SECRET,
        { expiresIn: JWT_EXPIRES_IN }
    );
}

function verifyToken(token) {
    return jwt.verify(token, JWT_SECRET);
}

// ---------------------------------------------------------------------------
// OTP
// ---------------------------------------------------------------------------
function generateOTP() {
    return String(Math.floor(100000 + Math.random() * 900000)); // 6-digit
}

function otpExpiry() {
    return new Date(Date.now() + OTP_TTL_MINUTES * 60 * 1000);
}

function isOtpExpired(expiresAt) {
    if (!expiresAt) return true;
    return new Date(expiresAt).getTime() < Date.now();
}

// ---------------------------------------------------------------------------
// EMAIL
// Falls back to console logging if SMTP env vars are not configured —
// keeps the app fully functional in local/dev environments without
// requiring a real mail account.
// ---------------------------------------------------------------------------
let transporter = null;
function getTransporter() {
    if (transporter) return transporter;
    if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
        transporter = nodemailer.createTransport({
            host: process.env.SMTP_HOST,
            port: Number(process.env.SMTP_PORT) || 587,
            secure: Number(process.env.SMTP_PORT) === 465,
            auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
        });
    }
    return transporter;
}

async function sendEmail({ to, subject, html, text }) {
    const t = getTransporter();
    if (!t) {
        // Dev fallback: log to console so OTPs are visible during testing.
        console.log(`\n📧  [DEV EMAIL] To: ${to}\nSubject: ${subject}\n${text || html}\n`);
        return { devMode: true };
    }
    return t.sendMail({
        from: process.env.SMTP_FROM || `"NEET CTK IGNITION" <${process.env.SMTP_USER}>`,
        to, subject, html, text
    });
}

async function sendOtpEmail(to, otp, purpose = 'verify your account') {
    return sendEmail({
        to,
        subject: 'NEET CTK IGNITION — Your verification code',
        text: `Your OTP to ${purpose} is ${otp}. It is valid for ${OTP_TTL_MINUTES} minutes. Do not share this code with anyone.`,
        html: `<p>Your OTP to <strong>${purpose}</strong> is:</p>
               <h2 style="letter-spacing:4px;">${otp}</h2>
               <p>This code is valid for ${OTP_TTL_MINUTES} minutes. Do not share it with anyone.</p>`
    });
}

// ---------------------------------------------------------------------------
// MIDDLEWARE
// ---------------------------------------------------------------------------
function authenticate(req, res, next) {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'Authentication required.' });
    try {
        req.user = verifyToken(token);
        next();
    } catch (err) {
        return res.status(401).json({ error: 'Invalid or expired session. Please log in again.' });
    }
}

function requireRole(...roles) {
    return (req, res, next) => {
        if (!req.user) return res.status(401).json({ error: 'Authentication required.' });
        if (!roles.includes(req.user.role)) {
            return res.status(403).json({ error: 'You do not have permission to access this resource.' });
        }
        next();
    };
}

// Optional auth: attaches req.user if a valid token is present, but
// does not block the request if absent/invalid.
function optionalAuth(req, res, next) {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (token) {
        try { req.user = verifyToken(token); } catch (_) { /* ignore */ }
    }
    next();
}

// ---------------------------------------------------------------------------
// RATE LIMITING (DB-backed, simple sliding window)
// ---------------------------------------------------------------------------
async function checkRateLimit(pool, email, kind, maxAttempts, windowMinutes) {
    const { rows } = await pool.query(
        `SELECT COUNT(*) AS c FROM auth_attempts
         WHERE email = $1 AND kind = $2 AND created_at > NOW() - INTERVAL '${windowMinutes} minutes'`,
        [email, kind]
    );
    return parseInt(rows[0].c, 10) < maxAttempts;
}

async function recordAttempt(pool, email, kind) {
    await pool.query(`INSERT INTO auth_attempts (email, kind) VALUES ($1, $2)`, [email, kind]);
}

module.exports = {
    hashPassword, verifyPassword,
    signToken, verifyToken,
    generateOTP, otpExpiry, isOtpExpired,
    sendEmail, sendOtpEmail,
    authenticate, requireRole, optionalAuth,
    checkRateLimit, recordAttempt
};
