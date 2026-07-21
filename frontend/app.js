// app.js - CTK Bridge Course frontend logic
// Talks to the Express + PostgreSQL backend defined in /backend.

const API_BASE = window.location.origin;

// ---------------------------------------------------------------- auth state
let authToken = localStorage.getItem('ctk_bridge_token') || null;
let currentUser = JSON.parse(localStorage.getItem('ctk_bridge_user') || 'null'); // { id, name, email, role, onboardingDone }

// Legacy fields kept for backward compatibility with existing student-data code
let currentStudentEmail = currentUser?.role === 'student' ? currentUser.email : (localStorage.getItem('ctk_bridge_email') || null);
let globalStudentData = null;
let pendingVerifyEmail = null; // email awaiting OTP verification

function setSession(token, user) {
  authToken = token;
  currentUser = user;
  localStorage.setItem('ctk_bridge_token', token);
  localStorage.setItem('ctk_bridge_user', JSON.stringify(user));
  if (user.role === 'student') {
    currentStudentEmail = user.email;
    localStorage.setItem('ctk_bridge_email', user.email);
  }
}

function clearSession() {
  authToken = null;
  currentUser = null;
  currentStudentEmail = null;
  localStorage.removeItem('ctk_bridge_token');
  localStorage.removeItem('ctk_bridge_user');
  localStorage.removeItem('ctk_bridge_email');
  sessionStorage.removeItem('ctk_bridge_admin'); // retire any legacy passcode-unlocked admin session
}

// ---------------------------------------------------------------- toast
let toastTimer = null;
function showToast(message, type = '') {
  const el = document.getElementById('toast');
  el.textContent = message;
  el.className = 'show' + (type ? ' ' + type : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = ''; }, 3200);
}

// ---------------------------------------------------------------- fetch helper
async function api(path, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
  const res = await fetch(`${API_BASE}${path}`, { ...options, headers });
  let data = null;
  try { data = await res.json(); } catch (e) { /* no body */ }
  if (res.status === 401 && authToken) {
    // session expired
    clearSession();
    updateNavForAuth();
    showToast('Your session has expired — please log in again.', 'error');
  }
  if (!res.ok) {
    const msg = (data && data.error) ? data.error : `Request failed (${res.status})`;
    throw new Error(msg);
  }
  return data;
}

// ---------------------------------------------------------------- multipart upload helper
// (no Content-Type header — the browser sets the multipart boundary itself)
async function apiUpload(path, formData) {
  const headers = {};
  if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
  const res = await fetch(`${API_BASE}${path}`, { method: 'POST', headers, body: formData });
  let data = null;
  try { data = await res.json(); } catch (e) { /* no body */ }
  if (res.status === 401 && authToken) {
    clearSession();
    updateNavForAuth();
    showToast('Your session has expired — please log in again.', 'error');
  }
  if (!res.ok) {
    const msg = (data && data.error) ? data.error : `Request failed (${res.status})`;
    throw new Error(msg);
  }
  return data;
}

// ---------------------------------------------------------------- student data
async function loadStudentData(email) {
  if (!email) return null;
  try {
    const data = await api(`/api/student/${encodeURIComponent(email)}`);
    globalStudentData = data;
    return data;
  } catch (err) {
    globalStudentData = null;
    return null;
  }
}

// ====================================================================
// AUTHENTICATION
// ====================================================================
async function registerUser() {
  const btn = document.getElementById('registerBtn');
  const role = document.getElementById('authRole').value;
  const name = document.getElementById('authName').value.trim();
  const email = document.getElementById('authEmail').value.trim();
  const password = document.getElementById('authPassword').value;
  const confirmPassword = document.getElementById('authConfirmPassword').value;
  const msgEl = document.getElementById('regMessage');

  if (!name || !email || !password) {
    msgEl.innerHTML = `<span class="badge danger">Please fill in all required fields.</span>`;
    return;
  }
  if (password !== confirmPassword) {
    msgEl.innerHTML = `<span class="badge danger">Passwords do not match.</span>`;
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Creating account...';
  msgEl.innerHTML = '';

  try {
    const body = { name, email, password, confirmPassword, role };
    const data = await api('/api/auth/register', { method: 'POST', body: JSON.stringify(body) });
    msgEl.innerHTML = `<span class="badge success">✅ ${data.message}</span>`;
    showToast('Account created — check your email for the OTP.', 'success');
    pendingVerifyEmail = data.email;
    document.getElementById('verifyOtpEmailLabel').textContent = data.email;
    setTimeout(() => showPage('verifyOtp'), 600);
  } catch (err) {
    msgEl.innerHTML = `<span class="badge danger">${err.message}</span>`;
    showToast(err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Create account & send OTP';
  }
}

// ====================================================================
// ADMIN PORTAL — separate registration/login flow, kept apart from the
// student/faculty Register & Login pages so admin access never appears
// in the main nav for a logged-in student or faculty member.
// ====================================================================
async function adminPortalRegister() {
  const btn = document.getElementById('adminRegisterBtn');
  const adminCode = document.getElementById('adminRegAdminCode').value;
  const name = document.getElementById('adminRegName').value.trim();
  const email = document.getElementById('adminRegEmail').value.trim();
  const password = document.getElementById('adminRegPassword').value;
  const confirmPassword = document.getElementById('adminRegConfirmPassword').value;
  const msgEl = document.getElementById('adminRegMessage');

  if (!name || !email || !password) {
    msgEl.innerHTML = `<span class="badge danger">Please fill in all required fields.</span>`;
    return;
  }
  if (password !== confirmPassword) {
    msgEl.innerHTML = `<span class="badge danger">Passwords do not match.</span>`;
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Creating account...';
  msgEl.innerHTML = '';
  try {
    const body = { name, email, password, confirmPassword, role: 'admin', adminCode };
    const data = await api('/api/auth/register', { method: 'POST', body: JSON.stringify(body) });
    msgEl.innerHTML = `<span class="badge success">✅ ${data.message}</span>`;
    showToast('Admin account created — check your email for the OTP.', 'success');
    pendingVerifyEmail = data.email;
    document.getElementById('verifyOtpEmailLabel').textContent = data.email;
    setTimeout(() => showPage('verifyOtp'), 600);
  } catch (err) {
    msgEl.innerHTML = `<span class="badge danger">${err.message}</span>`;
    showToast(err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Create admin account & send OTP';
  }
}

async function adminPortalLogin() {
  const btn = document.getElementById('adminPortalLoginBtn');
  const email = document.getElementById('adminLoginEmail').value.trim();
  const password = document.getElementById('adminLoginPassword').value;
  const msgEl = document.getElementById('adminPortalLoginMessage');

  if (!email || !password) {
    msgEl.innerHTML = `<span class="badge danger">Please enter your email and password.</span>`;
    return;
  }

  btn.disabled = true; btn.textContent = 'Logging in...';
  try {
    const data = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) });
    if (data.user.role !== 'admin') {
      msgEl.innerHTML = `<span class="badge danger">This portal is for admin accounts only.</span>`;
      showToast('That account is not an admin account.', 'error');
      return;
    }
    setSession(data.token, data.user);
    updateNavForAuth();
    showToast(`Welcome back, ${data.user.name.split(' ')[0]}!`, 'success');
    setTimeout(() => showPage('admin'), 300);
  } catch (err) {
    if (err.message.includes('verify your email')) {
      pendingVerifyEmail = email;
      document.getElementById('verifyOtpEmailLabel').textContent = email;
      msgEl.innerHTML = `<span class="badge warn">${err.message}</span>`;
      setTimeout(() => showPage('verifyOtp'), 800);
    } else {
      msgEl.innerHTML = `<span class="badge danger">${err.message}</span>`;
    }
    showToast(err.message, 'error');
  } finally {
    btn.disabled = false; btn.textContent = 'Log in to Admin Portal';
  }
}

async function verifyOtp() {
  const btn = document.getElementById('verifyOtpBtn');
  const otp = document.getElementById('otpInput').value.trim();
  const msgEl = document.getElementById('verifyOtpMessage');
  const email = pendingVerifyEmail || document.getElementById('verifyOtpEmailLabel').textContent;

  if (!email) { msgEl.innerHTML = `<span class="badge danger">Missing email — please register again.</span>`; return; }
  if (!otp) { msgEl.innerHTML = `<span class="badge danger">Please enter the OTP sent to your email.</span>`; return; }

  btn.disabled = true; btn.textContent = 'Verifying...';
  try {
    const data = await api('/api/auth/verify-otp', { method: 'POST', body: JSON.stringify({ email, otp }) });
    msgEl.innerHTML = `<span class="badge success">${data.message}</span>`;
    showToast('Email verified — you can now log in.', 'success');
    document.getElementById('loginEmail').value = email;
    setTimeout(() => showPage('login'), 800);
  } catch (err) {
    msgEl.innerHTML = `<span class="badge danger">${err.message}</span>`;
    showToast(err.message, 'error');
  } finally {
    btn.disabled = false; btn.textContent = 'Verify & activate account';
  }
}

async function resendOtp() {
  const email = pendingVerifyEmail || document.getElementById('verifyOtpEmailLabel').textContent;
  const msgEl = document.getElementById('verifyOtpMessage');
  if (!email) { msgEl.innerHTML = `<span class="badge danger">Missing email — please register again.</span>`; return; }
  try {
    const data = await api('/api/auth/resend-otp', { method: 'POST', body: JSON.stringify({ email }) });
    msgEl.innerHTML = `<span class="badge success">${data.message}</span>`;
    showToast('A new OTP has been sent.', 'success');
  } catch (err) {
    msgEl.innerHTML = `<span class="badge danger">${err.message}</span>`;
    showToast(err.message, 'error');
  }
}

async function loginUser() {
  const btn = document.getElementById('loginBtn');
  const email = document.getElementById('loginEmail').value.trim();
  const password = document.getElementById('loginPassword').value;
  const msgEl = document.getElementById('loginMessage');

  if (!email || !password) {
    msgEl.innerHTML = `<span class="badge danger">Please enter your email and password.</span>`;
    return;
  }

  btn.disabled = true; btn.textContent = 'Logging in...';
  try {
    const data = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) });
    setSession(data.token, data.user);
    updateNavForAuth();
    showToast(`Welcome back, ${data.user.name.split(' ')[0]}!`, 'success');

    if (data.user.role === 'student') {
      if (!data.user.onboardingDone) {
        setTimeout(() => showPage('onboarding'), 400);
      } else {
        await loadStudentData(data.user.email);
        setTimeout(() => showPage('guidance'), 400);
      }
    } else if (data.user.role === 'faculty') {
      setTimeout(() => showPage('lecturer'), 400);
    } else {
      // Admin accounts shouldn't sign in from the general Login page —
      // send them to the dedicated Admin Portal instead.
      clearSession();
      updateNavForAuth();
      msgEl.innerHTML = `<span class="badge warn">Admin accounts sign in from the separate Admin Portal (see the footer link).</span>`;
      setTimeout(() => showPage('adminLogin'), 600);
      return;
    }
  } catch (err) {
    if (err.message.includes('verify your email')) {
      pendingVerifyEmail = email;
      document.getElementById('verifyOtpEmailLabel').textContent = email;
      msgEl.innerHTML = `<span class="badge warn">${err.message}</span>`;
      setTimeout(() => showPage('verifyOtp'), 800);
    } else {
      msgEl.innerHTML = `<span class="badge danger">${err.message}</span>`;
    }
    showToast(err.message, 'error');
  } finally {
    btn.disabled = false; btn.textContent = 'Log in';
  }
}

function logoutUser() {
  clearSession();
  updateNavForAuth();
  showToast('Logged out.', '');
  showPage('welcome');
}

async function sendResetOtp() {
  const email = document.getElementById('forgotEmail').value.trim();
  const msgEl = document.getElementById('forgotMessage');
  if (!email) { msgEl.innerHTML = `<span class="badge danger">Please enter your email.</span>`; return; }
  try {
    const data = await api('/api/auth/forgot-password', { method: 'POST', body: JSON.stringify({ email }) });
    msgEl.innerHTML = `<span class="badge success">${data.message}</span>`;
  } catch (err) {
    msgEl.innerHTML = `<span class="badge danger">${err.message}</span>`;
  }
}

async function resetPassword() {
  const email = document.getElementById('forgotEmail').value.trim();
  const otp = document.getElementById('resetOtpInput').value.trim();
  const newPassword = document.getElementById('resetNewPassword').value;
  const confirmPassword = document.getElementById('resetConfirmPassword').value;
  const msgEl = document.getElementById('resetMessage');

  if (!email || !otp || !newPassword) { msgEl.innerHTML = `<span class="badge danger">Please fill in all fields, including your email above.</span>`; return; }
  if (newPassword !== confirmPassword) { msgEl.innerHTML = `<span class="badge danger">Passwords do not match.</span>`; return; }

  try {
    const data = await api('/api/auth/reset-password', { method: 'POST', body: JSON.stringify({ email, otp, newPassword, confirmPassword }) });
    msgEl.innerHTML = `<span class="badge success">${data.message}</span>`;
    showToast('Password reset — please log in.', 'success');
    setTimeout(() => showPage('login'), 800);
  } catch (err) {
    msgEl.innerHTML = `<span class="badge danger">${err.message}</span>`;
  }
}

// ====================================================================
// ONBOARDING
// ====================================================================
async function submitOnboarding() {
  const btn = document.getElementById('onboardingBtn');
  const msgEl = document.getElementById('onboardingMessage');
  const payload = {
    targetExam: document.getElementById('obTargetExam').value,
    targetInstitution: document.getElementById('obTargetInstitution').value,
    category: document.getElementById('obCategory').value,
    state: document.getElementById('obState').value.trim(),
    currentClass: document.getElementById('obCurrentClass').value,
    dailyStudyHours: document.getElementById('obDailyHours').value ? parseFloat(document.getElementById('obDailyHours').value) : null,
    prepLevel: document.getElementById('obPrepLevel').value
  };

  btn.disabled = true; btn.textContent = 'Building your plan...';
  try {
    const data = await api('/api/onboarding/student', { method: 'POST', body: JSON.stringify(payload) });
    globalStudentData = data;
    currentUser.onboardingDone = true;
    localStorage.setItem('ctk_bridge_user', JSON.stringify(currentUser));
    msgEl.innerHTML = `<span class="badge success">✅ Profile saved — your personalised plan is ready.</span>`;
    showToast('Welcome aboard! Your personalised plan is ready.', 'success');
    setTimeout(() => showPage('guidance'), 600);
  } catch (err) {
    msgEl.innerHTML = `<span class="badge danger">${err.message}</span>`;
    showToast(err.message, 'error');
  } finally {
    btn.disabled = false; btn.textContent = 'Save & build my plan';
  }
}



async function prefillOnboarding() {
  if (!currentUser || currentUser.role !== 'student') return;
  renderObExamDateDisplay();
  const data = await loadStudentData(currentUser.email);
  if (!data || !data.student) return;
  const s = data.student;
  if (s.target_exam) document.getElementById('obTargetExam').value = s.target_exam;
  if (s.target_institution || s.aim) document.getElementById('obTargetInstitution').value = s.target_institution || s.aim;
  if (s.category) document.getElementById('obCategory').value = s.category;
  if (s.state) document.getElementById('obState').value = s.state;
  if (s.current_class) document.getElementById('obCurrentClass').value = s.current_class;
  if (s.daily_study_hours) document.getElementById('obDailyHours').value = s.daily_study_hours;
  if (s.prep_level) document.getElementById('obPrepLevel').value = s.prep_level;
}

// The exam date is set only by faculty/admin (see Lecturer Hub / Admin
// page) -- students see it here read-only, they can't change it.
async function renderObExamDateDisplay() {
  const el = document.getElementById('obExamDateDisplay');
  if (!el) return;
  try {
    const { examDate } = await api('/api/admin/exam-date');
    el.textContent = examDate
      ? `${new Date(examDate).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' })} (set by your institute)`
      : 'Not set yet by your institute.';
  } catch (err) {
    el.textContent = 'Could not load exam date.';
  }
}

// ====================================================================
// GUIDANCE PAGE
// ====================================================================
async function renderGuidance() {
  const container = document.getElementById('guidanceContent');

  if (!currentStudentEmail) {
    container.innerHTML = `
      <div class="empty-state">
        <span class="icon">🧭</span>
        <p>Register first to unlock your personalised Seven Hills plan.</p>
        <button class="btn btn-primary mt-2" onclick="showPage('register')">Go to registration</button>
      </div>`;
    return;
  }

  container.innerHTML = `<div class="loading-row"><div class="spinner"></div></div>`;

  try {
    const data = await loadStudentData(currentStudentEmail);
    if (!data) {
      container.innerHTML = `<div class="empty-state"><span class="icon">⚠️</span><p>We couldn't find your profile. Please register again.</p>
        <button class="btn btn-primary mt-2" onclick="showPage('register')">Register</button></div>`;
      return;
    }
    const plan = await api(`/api/plan/${encodeURIComponent(currentStudentEmail)}`);
    const cutoff = await api(`/api/cutoff-prediction/${encodeURIComponent(currentStudentEmail)}`).catch(() => null);
    const { student, progress, targets } = data;
    const { phases, daysLeft, progressPercent, focusSubject, strongSubject, message } = plan;

    container.innerHTML = `
      <div class="card">
        <h2>Your Seven Hills plan, ${student.name.split(' ')[0]}</h2>
        <p style="color:var(--ink-soft); margin-bottom:1rem;">${daysLeft} days remain until the platform exam date. Aim: <strong>${student.aim}</strong> · Category: <strong>${student.category}</strong>.</p>

        <div class="progress-bar"><div class="progress-fill" style="width:${progressPercent}%"></div></div>
        <p class="helper-text">Overall readiness: ${progressPercent}% of target accuracy reached.</p>

        ${cutoff ? renderCutoffSection(cutoff, student) : ''}

        <div class="grid-3 mt-2">
          <div class="card" style="background:var(--hill-2); border:none;">
            <h3>🏔️ Foundation</h3>
            <p style="font-weight:700; margin-bottom:0.3rem;">${phases.foundation.days} days</p>
            <p style="font-size:0.88rem; color:var(--ink-soft);">${phases.foundation.focus}</p>
          </div>
          <div class="card" style="background:var(--hill-3); border:none;">
            <h3>🌄 Consolidation</h3>
            <p style="font-weight:700; margin-bottom:0.3rem;">${phases.consolidation.days} days</p>
            <p style="font-size:0.88rem; color:var(--ink-soft);">${phases.consolidation.focus}</p>
          </div>
          <div class="card" style="background:var(--hill-4); border:none;">
            <h3>⛰️ Peak practice</h3>
            <p style="font-weight:700; margin-bottom:0.3rem;">${phases.peakPractice.days} days</p>
            <p style="font-size:0.88rem; color:var(--ink-soft);">${phases.peakPractice.focus}</p>
          </div>
        </div>

        <hr class="divider">

        <div class="grid-3">
          ${subjectTargetRow('Biology', progress.bio_accuracy, targets.bio)}
          ${subjectTargetRow('Physics', progress.phy_accuracy, targets.phy)}
          ${subjectTargetRow('Chemistry', progress.chem_accuracy, targets.chem)}
        </div>

        <div class="card mt-2" style="background:var(--cream-deep); border:none;">
          <p>🎯 ${message}</p>
        </div>

        <button id="regeneratePlanBtn" class="btn btn-outline mt-2">⟳ Regenerate plan</button>
      </div>`;

    document.getElementById('regeneratePlanBtn').onclick = renderGuidance;
  } catch (err) {
    container.innerHTML = `<div class="empty-state"><span class="icon">⚠️</span><p>${err.message}</p></div>`;
  }
}

function renderCutoffSection(cutoff, student) {
  if (cutoff.exam === 'BOTH') {
    return `
      <hr class="divider">
      ${renderSingleExamCutoff(cutoff.neet, student)}
      <hr class="divider">
      ${renderSingleExamCutoff(cutoff.jee, student)}`;
  }
  return `<hr class="divider">${renderSingleExamCutoff(cutoff, student)}`;
}

function renderSingleExamCutoff(cutoff, student) {
  const isLive = cutoff.modelInfo.dataSource === 'web-research-ai';
  const badge = `<span class="badge ${isLive ? 'success' : 'warn'}">${isLive ? '🌐 Live web data' : '📊 Historical trend estimate'}</span>`;

  if (cutoff.exam === 'JEE') {
    const subj = cutoff.subjectCutoffs;
    return `
      <div class="flex-between">
        <h3 style="margin-bottom:0;">🎯 JEE cutoff &amp; rank prediction (${cutoff.targetYear})</h3>
        ${badge}
      </div>
      <div class="grid-3 mt-1">
        <div class="card" style="background:var(--hill-1); border:none;">
          <div class="helper-text">Safe percentile</div>
          <p style="font-weight:700; font-size:1.4rem; margin:0;">${cutoff.safePercentile.toFixed(2)}</p>
        </div>
        <div class="card" style="background:var(--hill-3); border:none;">
          <div class="helper-text">Target percentile</div>
          <p style="font-weight:700; font-size:1.4rem; margin:0;">${cutoff.targetPercentile.toFixed(2)}</p>
        </div>
        <div class="card" style="background:var(--hill-5); border:none;">
          <div class="helper-text">Stretch percentile</div>
          <p style="font-weight:700; font-size:1.4rem; margin:0;">${cutoff.stretchPercentile.toFixed(2)}</p>
        </div>
      </div>
      <p class="helper-text mt-1">Estimated rank range: <strong>#${cutoff.estimatedRank.low.toLocaleString('en-IN')} – #${cutoff.estimatedRank.high.toLocaleString('en-IN')}</strong>
        ${cutoff.admissionProbability !== null ? ` · Admission probability at current pace: <strong>${cutoff.admissionProbability}%</strong>` : ''}
      </p>
      <p class="helper-text">Regressed from published JEE Main ${cutoff.category} category qualifying percentiles, forward to ${cutoff.targetYear}.</p>
      <p class="helper-text mt-1" style="font-weight:600;">Subject-wise accuracy targets to stay on pace:</p>
      <div class="grid-3 mt-1">
        <div class="card" style="border:1px solid var(--border);"><strong>Physics</strong><p class="helper-text">${subj.Physics.accuracyTargetPct}% accuracy</p></div>
        <div class="card" style="border:1px solid var(--border);"><strong>Chemistry</strong><p class="helper-text">${subj.Chemistry.accuracyTargetPct}% accuracy</p></div>
        <div class="card" style="border:1px solid var(--border);"><strong>Mathematics</strong><p class="helper-text">${subj.Mathematics.accuracyTargetPct}% accuracy</p></div>
      </div>`;
  }

  // NEET
  const subj = cutoff.subjectCutoffs;
  return `
    <div class="flex-between">
      <h3 style="margin-bottom:0;">🎯 NEET cutoff &amp; rank prediction (${cutoff.targetYear})</h3>
      ${badge}
    </div>
    <div class="grid-3 mt-1">
      <div class="card" style="background:var(--hill-1); border:none;">
        <div class="helper-text">Safe Score</div>
        <p style="font-weight:700; font-size:1.4rem; margin:0;">${cutoff.safeScore}/${cutoff.maxMarks}</p>
      </div>
      <div class="card" style="background:var(--hill-3); border:none;">
        <div class="helper-text">Target Score</div>
        <p style="font-weight:700; font-size:1.4rem; margin:0;">${cutoff.targetScore}/${cutoff.maxMarks}</p>
      </div>
      <div class="card" style="background:var(--hill-5); border:none;">
        <div class="helper-text">Stretch Goal</div>
        <p style="font-weight:700; font-size:1.4rem; margin:0;">${cutoff.stretchScore}/${cutoff.maxMarks}</p>
      </div>
    </div>
    <p class="helper-text mt-1">Estimated rank range: <strong>#${cutoff.estimatedRank.low.toLocaleString('en-IN')} – #${cutoff.estimatedRank.high.toLocaleString('en-IN')}</strong>
      ${cutoff.admissionProbability !== null ? ` · Admission probability at current pace: <strong>${cutoff.admissionProbability}%</strong>` : ''}
    </p>
    <p class="helper-text">${isLive
        ? `Based on real, recently fetched NEET cutoff trends for ${cutoff.category} category${student.state ? ` in ${student.state}` : ''}, regressed forward to ${cutoff.targetYear}.`
        : `Live data hasn't been fetched yet for this category — showing an estimate computed from historical trends. This updates automatically once the live data refresh completes.`}</p>
    <p class="helper-text mt-1" style="font-weight:600;">Subject-wise target scores:</p>
    <div class="grid-3 mt-1">
      ${Object.entries(subj).map(([name, s]) => `
        <div class="card" style="border:1px solid var(--border);">
          <strong>${name}</strong>
          <p class="helper-text">Safe ${s.safeScore} · Target ${s.targetScore} · Stretch ${s.stretchScore} <span style="opacity:.7;">(/${s.maxMarks})</span></p>
        </div>`).join('')}
    </div>`;
}

function subjectTargetRow(label, current, target) {
  const pct = Math.min(100, Math.round((current / target) * 100));
  return `
    <div class="card" style="margin-bottom:0; border:1px solid var(--border);">
      <div class="flex-between"><strong>${label}</strong><span class="badge">${current}% / ${target}%</span></div>
      <div class="progress-bar"><div class="progress-fill" style="width:${pct}%"></div></div>
    </div>`;
}

// ====================================================================
// PRACTICE PAGE
// ====================================================================
async function renderPractice() {
  // Prof lectures (lecturer_name = 'CTK Faculty') and community lectures both
  // come from the same approved-lectures API — no hardcoded data.
  const profContainer     = document.getElementById('profLecturesList');
  const approvedContainer = document.getElementById('approvedLecturesList');
  profContainer.innerHTML     = `<div class="loading-row"><div class="spinner"></div></div>`;
  approvedContainer.innerHTML = `<div class="loading-row"><div class="spinner"></div></div>`;
  try {
    const approved = await api('/api/approved-lectures');
    const profLectures  = approved.filter(l => l.lecturer_name === 'CTK Faculty');
    const communityLecs = approved.filter(l => l.lecturer_name !== 'CTK Faculty');

    const cardHtml = (l, showAuthor) => `
      <div class="video-card">
        <iframe src="${l.url}" allowfullscreen loading="lazy"></iframe>
        <div class="info">
          <strong>${l.title}</strong>
          <span class="meta">${showAuthor ? l.lecturer_name + ' · ' : ''}${l.subject}</span>
        </div>
      </div>`;

    profContainer.innerHTML = profLectures.length
      ? profLectures.map(l => cardHtml(l, false)).join('')
      : `<div class="empty-state"><span class="icon">🎓</span><p>No CTK Faculty lectures yet — check back soon.</p></div>`;

    approvedContainer.innerHTML = communityLecs.length
      ? communityLecs.map(l => cardHtml(l, true)).join('')
      : `<div class="empty-state"><span class="icon">📭</span><p>No approved faculty lectures yet — check back soon.</p></div>`;
  } catch (err) {
    profContainer.innerHTML     = `<div class="empty-state"><p>${err.message}</p></div>`;
    approvedContainer.innerHTML = `<div class="empty-state"><p>${err.message}</p></div>`;
  }

  renderMaterials();

  if (currentUser?.role === 'student') {
    renderStudentTests();
  }
}

// ====================================================================
// PROGRESS PAGE
// ====================================================================
async function renderProgress() {
  const container = document.getElementById('progressContent');

  if (!currentStudentEmail) {
    container.innerHTML = `
      <div class="empty-state">
        <span class="icon">📊</span>
        <p>Register and attempt a quiz to see your analytics here.</p>
        <button class="btn btn-primary mt-2" onclick="showPage('register')">Go to registration</button>
      </div>`;
    return;
  }

  container.innerHTML = `<div class="loading-row"><div class="spinner"></div></div>`;

  try {
    const data = await loadStudentData(currentStudentEmail);
    if (!data) {
      container.innerHTML = `<div class="empty-state"><p>We couldn't find your profile. Please register again.</p></div>`;
      return;
    }
    const { progress, targets } = data;
    const avgAcc = (progress.bio_accuracy + progress.phy_accuracy + progress.chem_accuracy + progress.zoo_accuracy + progress.math_accuracy) / 5;
    const targetAvg = (targets.bio + targets.phy + targets.chem + targets.zoo + targets.math) / 5;
    const overallPercent = Math.min(100, Math.round((avgAcc / targetAvg) * 100));

    const advancedUnlocked = progress.bio_accuracy >= 80 && progress.phy_accuracy >= 60 && progress.chem_accuracy >= 70;

    const mistakeData = await api('/api/student/mistake-analysis').catch(() => null);

    container.innerHTML = `
      <div class="card">
        <h2>Your progress analytics</h2>
        <div class="grid-2 mt-1">
          <div><canvas id="accuracyChart" height="220"></canvas></div>
          <div><canvas id="weeklyTrendChart" height="220"></canvas></div>
        </div>
        <div class="grid-2 mt-2">
          <div><canvas id="subjectDoughnutChart" height="220"></canvas></div>
          <div class="card" style="border:1px solid var(--border); display:flex; flex-direction:column; justify-content:center;">
            <span>📊 Current — Bio ${progress.bio_accuracy}% · Phy ${progress.phy_accuracy}% · Chem ${progress.chem_accuracy}% · Zoo ${progress.zoo_accuracy}% · Math ${progress.math_accuracy}%</span>
            <span class="mt-1">🎯 Target — Bio ${targets.bio}% · Phy ${targets.phy}% · Chem ${targets.chem}% · Zoo ${targets.zoo}% · Math ${targets.math}%</span>
            <div class="progress-bar mt-1"><div class="progress-fill" style="width:${overallPercent}%"></div></div>
            <span class="mt-1">⭐ Advanced mode: <span class="badge ${advancedUnlocked ? 'success' : 'warn'}">${advancedUnlocked ? 'Unlocked' : 'Locked'}</span></span>
          </div>
        </div>
        <p class="helper-text mt-1">${advancedUnlocked ? 'Great work — you have met the subject thresholds (Bio ≥ 80%, Phy ≥ 60%, Chem ≥ 70%) for Advanced Mode.' : 'Advanced Mode unlocks once Biology ≥ 80%, Physics ≥ 60% and Chemistry ≥ 70%.'}</p>
        <button id="refreshProgressBtn" class="btn btn-outline mt-2">Refresh data</button>
      </div>

      ${mistakeData ? `
      <div class="card">
        <h3>🔍 Mistake Analysis — from every test you've taken</h3>
        ${renderMistakeAnalysis(mistakeData)}
      </div>` : ''}`;

    document.getElementById('refreshProgressBtn').onclick = renderProgress;

    let history = [];
    try { history = JSON.parse(progress.weekly_history); } catch (e) { history = []; }
    const weeks = history.length ? history.map((_, i) => i === history.length - 1 ? 'This week' : `W-${history.length - 1 - i}`) : [];

    new Chart(document.getElementById('accuracyChart').getContext('2d'), {
      type: 'bar',
      data: {
        labels: ['Biology', 'Physics', 'Chemistry', 'Zoology', 'Mathematics'],
        datasets: [
          { label: 'Your %', data: [progress.bio_accuracy, progress.phy_accuracy, progress.chem_accuracy, progress.zoo_accuracy, progress.math_accuracy], backgroundColor: '#CFE3E6', borderRadius: 8 },
          { label: 'Target %', data: [targets.bio, targets.phy, targets.chem, targets.zoo, targets.math], backgroundColor: '#D98E5B', borderRadius: 8 }
        ]
      },
      options: { responsive: true, plugins: { legend: { position: 'bottom' } }, scales: { y: { beginAtZero: true, max: 100 } } }
    });

    new Chart(document.getElementById('weeklyTrendChart').getContext('2d'), {
      type: 'line',
      data: {
        labels: weeks,
        datasets: [{ label: 'Overall accuracy', data: history, borderColor: '#D98E5B', backgroundColor: 'rgba(217,142,91,0.15)', fill: true, tension: 0.35 }]
      },
      options: { responsive: true, plugins: { legend: { position: 'bottom' } }, scales: { y: { beginAtZero: true, max: 100 } } }
    });

    new Chart(document.getElementById('subjectDoughnutChart').getContext('2d'), {
      type: 'doughnut',
      data: {
        labels: ['Biology', 'Physics', 'Chemistry', 'Zoology', 'Mathematics'],
        datasets: [{
          data: [progress.bio_accuracy, progress.phy_accuracy, progress.chem_accuracy, progress.zoo_accuracy, progress.math_accuracy],
          backgroundColor: ['#CFE3E6', '#D98E5B', '#B6C77A', '#E3B23C', '#9C7FB0']
        }]
      },
      options: { responsive: true, plugins: { legend: { position: 'bottom' }, title: { display: true, text: 'Where your accuracy is concentrated' } } }
    });

  } catch (err) {
    container.innerHTML = `<div class="empty-state"><p>${err.message}</p></div>`;
  }
}

function renderMistakeAnalysis(data) {
  const subjects = Object.keys(data.bySubject || {});
  if (subjects.length === 0) {
    return `<div class="empty-state"><span class="icon">📝</span><p>No test attempts yet — your faculty-scheduled tests will populate this analysis.</p></div>`;
  }
  const typeLabel = { conceptual: 'Conceptual', calculation: 'Calculation', memory: 'Memory-based', unattempted: 'Unattempted' };
  let html = subjects.map(subj => `
    <div class="atlas-item">
      <div class="topic-row">${subj}</div>
      ${data.bySubject[subj].map(t => `
        <div style="margin: 0.4rem 0 0.4rem 0.5rem;">
          <div style="font-weight:600; font-size:0.92rem;">• ${t.topic}: ${t.count} ${typeLabel[t.mistakeType] || t.mistakeType} mistake(s)</div>
        </div>`).join('')}
    </div>`).join('');

  if (data.recommendations?.length) {
    html += `<div class="card mt-1" style="background:var(--cream-deep); border:none;">
      <strong>Recommendations</strong>
      ${data.recommendations.map(r => `<p class="helper-text mt-1">• ${r.recommendation}</p>`).join('')}
    </div>`;
  }
  return html;
}


// ====================================================================
// LECTURER HUB
// ====================================================================
async function submitLecture() {
  const title = document.getElementById('lectureTitle').value.trim();
  const subject = document.getElementById('lectureSubject').value;
  const url = document.getElementById('lectureUrl').value.trim();
  const lecturerName = document.getElementById('lecturerName').value.trim();
  const statusEl = document.getElementById('lecturerStatus');

  if (!title || !url || !lecturerName) {
    statusEl.innerHTML = `<span class="badge danger">Please fill in your name, the video title and the embed URL.</span>`;
    return;
  }

  const btn = document.getElementById('submitLectureBtn');
  btn.disabled = true; btn.textContent = 'Submitting...';
  try {
    await api('/api/lecturer/submit', { method: 'POST', body: JSON.stringify({ title, subject, url, lecturerName }) });
    statusEl.innerHTML = `<span class="badge success">Submitted — awaiting admin approval.</span>`;
    document.getElementById('lectureTitle').value = '';
    document.getElementById('lectureUrl').value = '';
    localStorage.setItem('neet_ctk_lecturer', lecturerName);
    renderMySubmissions();
  } catch (err) {
    statusEl.innerHTML = `<span class="badge danger">${err.message}</span>`;
  } finally {
    btn.disabled = false; btn.textContent = 'Submit for approval';
  }
}

async function renderMySubmissions() {
  const lecturerName = document.getElementById('lecturerName').value.trim() || localStorage.getItem('neet_ctk_lecturer') || '';
  const container = document.getElementById('mySubmissionsList');
  if (!lecturerName) {
    container.innerHTML = `<div class="empty-state"><p>Enter your name above, submit a lecture, then refresh to see its status here.</p></div>`;
    return;
  }
  if (!document.getElementById('lecturerName').value) {
    document.getElementById('lecturerName').value = lecturerName;
  }
  container.innerHTML = `<div class="loading-row"><div class="spinner"></div></div>`;
  try {
    const subs = await api(`/api/lecturer/submissions/${encodeURIComponent(lecturerName)}`);
    container.innerHTML = subs.length ? subs.map(s => `
      <div class="flex-between" style="padding:0.6rem 0; border-bottom:1px solid var(--border);">
        <span>${s.title} <span class="meta" style="color:var(--ink-soft); font-size:0.8rem;">· ${s.subject}</span></span>
        <span class="badge ${s.approved ? 'success' : 'warn'}">${s.approved ? '✅ Approved' : '⏳ Pending'}</span>
      </div>`).join('') : `<div class="empty-state"><p>No submissions yet.</p></div>`;
  } catch (err) {
    container.innerHTML = `<div class="empty-state"><p>${err.message}</p></div>`;
  }
}

// ====================================================================
// TEST MANAGEMENT — FACULTY (read-only history; creation now only via
// Grand Tests below -- Normal Test generation has been removed)
// ====================================================================

async function renderFacultyTests() {
  const container = document.getElementById('facultyTestsList');
  if (!container) return;
  container.innerHTML = `<div class="loading-row"><div class="spinner"></div></div>`;
  try {
    const tests = await api('/api/faculty/tests');
    container.innerHTML = tests.length ? tests.map(t => `
      <div class="flex-between" style="padding:0.6rem 0; border-bottom:1px solid var(--border);">
        <div>
          <strong>${t.title}</strong>
          <div class="helper-text">${t.subject}${t.chapter ? ' · ' + t.chapter : ''} · ${t.question_count} question(s) · ${t.attempt_count} attempt(s)</div>
        </div>
        <span class="badge ${t.scheduled_at && new Date(t.scheduled_at) > new Date() ? 'warn' : 'success'}">
          ${t.scheduled_at ? new Date(t.scheduled_at).toLocaleString() : 'Live now'}
        </span>
      </div>`).join('') : `<div class="empty-state"><p>No tests scheduled yet.</p></div>`;
  } catch (err) {
    container.innerHTML = `<div class="empty-state"><p>${err.message}</p></div>`;
  }
}

async function publishGrandTest() {
  const btn = document.getElementById('publishGrandTestBtn');
  const msgEl = document.getElementById('publishGrandTestMessage');
  const courseType = document.getElementById('grandTestCourseSelect').value;
  const label = document.getElementById('grandTestLabelInput').value.trim();
  btn.disabled = true; btn.textContent = 'Starting...';
  try {
    const res = await api('/api/bridge/faculty/tests/grand', {
      method: 'POST',
      body: JSON.stringify({ courseType, label: label || undefined })
    });
    msgEl.innerHTML = res.alreadyPublished
      ? `<span class="badge warn">A Grand Test with this course + label already exists: ${res.test.title}</span>`
      : `<span class="badge success">✅ Draft created: ${res.test.title} — review it below before publishing.</span>`;
    showToast(res.alreadyPublished ? 'Grand Test already exists.' : 'Draft created.', 'success');
    renderGrandTestsList();
    if (res.test.status === 'draft') openGrandTestEditor(res.test.id, res.test.title);
  } catch (err) {
    msgEl.innerHTML = `<span class="badge danger">${err.message}</span>`;
    showToast(err.message, 'error');
  } finally {
    btn.disabled = false; btn.textContent = 'Start Grand Test draft';
  }
}

async function renderGrandTestsList() {
  const container = document.getElementById('grandTestsList');
  if (!container) return;
  container.innerHTML = `<div class="loading-row"><div class="spinner"></div></div>`;
  try {
    const tests = await api('/api/bridge/faculty/tests/grand');
    container.innerHTML = tests.length ? tests.map(t => `
      <div class="flex-between" style="padding:0.6rem 0; border-bottom:1px solid var(--border);">
        <div>
          <strong>${t.title}</strong>
          <div class="helper-text">${t.course_type} · ${t.question_count} question(s) · ${t.attempt_count} attempt(s)</div>
        </div>
        <div class="flex-row" style="align-items:center; gap:0.5rem;">
          <span class="badge ${t.status === 'published' ? 'success' : 'warn'}">${t.status === 'published' ? 'Published' : 'Draft'}</span>
          <span class="helper-text">${new Date(t.created_at).toLocaleDateString()}</span>
          <button class="btn btn-outline" onclick="openGrandTestEditor(${t.id}, '${t.title.replace(/'/g, "\\'")}')">${t.status === 'draft' ? 'Review & Edit' : 'View'}</button>
        </div>
      </div>`).join('') : `<div class="empty-state"><p>No Grand Tests yet.</p></div>`;
  } catch (err) {
    container.innerHTML = `<div class="empty-state"><p>${err.message}</p></div>`;
  }
}

async function renderFacultyAnalytics() {
  const weakEl = document.getElementById('facultyWeakTopics');
  const avgEl = document.getElementById('facultyTestAverages');
  const recentEl = document.getElementById('facultyRecentAttempts');
  if (!weakEl) return;
  weakEl.innerHTML = avgEl.innerHTML = recentEl.innerHTML = `<div class="loading-row"><div class="spinner"></div></div>`;
  try {
    const data = await api('/api/faculty/analytics');

    weakEl.innerHTML = data.weakTopics.length ? data.weakTopics.map(w => `
      <div style="padding:0.4rem 0; border-bottom:1px solid var(--border);">
        <span class="badge warn">${w.subject}</span> ${w.message}
      </div>`).join('') : `<div class="empty-state"><p>No mistake data yet.</p></div>`;

    avgEl.innerHTML = data.testAverages.length ? `
      <div style="overflow-x:auto;"><table style="width:100%; border-collapse:collapse; font-size:0.9rem;">
        <thead><tr style="text-align:left; border-bottom:1px solid var(--border);">
          <th style="padding:0.5rem;">Test</th><th style="padding:0.5rem;">Subject</th><th style="padding:0.5rem;">Avg score</th><th style="padding:0.5rem;">Attempts</th>
        </tr></thead>
        <tbody>${data.testAverages.map(a => `
          <tr style="border-bottom:1px solid var(--border);">
            <td style="padding:0.5rem;">${a.title}</td>
            <td style="padding:0.5rem;">${a.subject}</td>
            <td style="padding:0.5rem;">${a.avgScore} / ${a.total}</td>
            <td style="padding:0.5rem;">${a.attempts}</td>
          </tr>`).join('')}</tbody>
      </table></div>` : `<div class="empty-state"><p>No attempts yet.</p></div>`;

    recentEl.innerHTML = data.recentAttempts.length ? data.recentAttempts.slice(0, 15).map(a => `
      <div class="flex-between" style="padding:0.4rem 0; border-bottom:1px solid var(--border);">
        <span><strong>${a.name}</strong> <span class="helper-text">(${a.category} · ${a.aim})</span> — ${a.title}</span>
        <span class="badge">${a.score}/${a.total}</span>
      </div>`).join('') : `<div class="empty-state"><p>No attempts yet.</p></div>`;
  } catch (err) {
    weakEl.innerHTML = avgEl.innerHTML = recentEl.innerHTML = `<div class="empty-state"><p>${err.message}</p></div>`;
  }
}

// ====================================================================
// CHAPTER MANAGEMENT — FACULTY
// ====================================================================
let lastChaptersBySubject = {};

async function populateChapterSelects() {
  const subject = document.getElementById('chapterSubjectSelect') ? document.getElementById('chapterSubjectSelect').value : 'Physics';
  try {
    const chapters = await api(`/api/chapters?subject=${encodeURIComponent(subject)}`);
    lastChaptersBySubject[subject] = chapters;
    const optionsHtml = `<option value="">— No chapter —</option>` + chapters.map(c => `<option value="${c.id}">${c.name}</option>`).join('');
    ['testChapter', 'materialChapter', 'facLectureChapter'].forEach(id => {
      const el = document.getElementById(id);
      if (!el) return;
      const prevValue = el.value;
      el.innerHTML = optionsHtml;
      if (chapters.some(c => String(c.id) === prevValue)) el.value = prevValue;
    });
    return chapters;
  } catch (err) {
    showToast(err.message, 'error');
    return [];
  }
}

async function renderChapterList() {
  const container = document.getElementById('chapterList');
  if (!container) return;
  const subject = document.getElementById('chapterSubjectSelect').value;
  container.innerHTML = `<div class="loading-row"><div class="spinner"></div></div>`;
  try {
    const chapters = await api(`/api/chapters?subject=${encodeURIComponent(subject)}`);
    lastChaptersBySubject[subject] = chapters;
    container.innerHTML = chapters.length ? chapters.map((c, i) => `
      <div class="flex-between" style="padding:0.55rem 0; border-bottom:1px solid var(--border);">
        <div>
          <strong>${c.name}</strong>
          ${c.description ? `<div class="helper-text">${c.description}</div>` : ''}
          <div class="helper-text">${c.material_count} material(s) · ${c.test_count} test(s) · ${c.lecture_count} lecture(s)</div>
        </div>
        <div class="flex-row">
          <button class="btn btn-outline" title="Move up" ${i === 0 ? 'disabled' : ''} onclick="moveChapter(${i},-1)">↑</button>
          <button class="btn btn-outline" title="Move down" ${i === chapters.length - 1 ? 'disabled' : ''} onclick="moveChapter(${i},1)">↓</button>
          <button class="btn btn-outline" onclick="renameChapter(${c.id}, '${c.name.replace(/'/g, "\\'")}')">Rename</button>
          <button class="btn btn-outline" onclick="removeChapter(${c.id})">Delete</button>
        </div>
      </div>`).join('') : `<div class="empty-state"><p>No chapters yet for ${subject} — add one above.</p></div>`;
  } catch (err) {
    container.innerHTML = `<div class="empty-state"><p>${err.message}</p></div>`;
  }
}

async function createChapter() {
  const btn = document.getElementById('createChapterBtn');
  const msgEl = document.getElementById('chapterMessage');
  const subject = document.getElementById('chapterSubjectSelect').value;
  const name = document.getElementById('newChapterName').value.trim();
  const description = document.getElementById('newChapterDesc').value.trim();
  if (!name) { msgEl.innerHTML = `<span class="badge danger">Please enter a chapter name.</span>`; return; }
  btn.disabled = true;
  try {
    await api('/api/faculty/chapters', { method: 'POST', body: JSON.stringify({ subject, name, description }) });
    msgEl.innerHTML = `<span class="badge success">✅ Chapter added.</span>`;
    document.getElementById('newChapterName').value = '';
    document.getElementById('newChapterDesc').value = '';
    showToast('Chapter added.', 'success');
    renderChapterList();
    populateChapterSelects();
  } catch (err) {
    msgEl.innerHTML = `<span class="badge danger">${err.message}</span>`;
    showToast(err.message, 'error');
  } finally {
    btn.disabled = false;
  }
}

window.renameChapter = async (id, currentName) => {
  const name = prompt('Rename chapter:', currentName);
  if (!name || name.trim() === currentName) return;
  try {
    await api(`/api/faculty/chapters/${id}`, { method: 'PUT', body: JSON.stringify({ name: name.trim() }) });
    showToast('Chapter renamed.', 'success');
    renderChapterList();
    populateChapterSelects();
    renderFacultyTests();
    renderFacultyMaterials();
  } catch (err) {
    showToast(err.message, 'error');
  }
};

window.removeChapter = async (id) => {
  if (!confirm('Delete this chapter? Materials, tests and lectures linked to it will stay, just unlinked.')) return;
  try {
    await api(`/api/faculty/chapters/${id}`, { method: 'DELETE' });
    showToast('Chapter deleted.', '');
    renderChapterList();
    populateChapterSelects();
  } catch (err) {
    showToast(err.message, 'error');
  }
};

window.moveChapter = async (index, direction) => {
  const subject = document.getElementById('chapterSubjectSelect').value;
  const chapters = lastChaptersBySubject[subject] || [];
  const target = index + direction;
  if (target < 0 || target >= chapters.length) return;
  const order = chapters.map(c => c.id);
  [order[index], order[target]] = [order[target], order[index]];
  try {
    await api('/api/faculty/chapters/reorder', { method: 'POST', body: JSON.stringify({ order }) });
    renderChapterList();
  } catch (err) {
    showToast(err.message, 'error');
  }
};

// ====================================================================
// GRAND TEST DRAFT EDITOR — FACULTY
// Faculty can preview every generated question, edit any of them, and
// paste extra questions (AI-arranged) to replace generated ones -- the
// total question count never changes. Only draft Grand Tests can be
// edited; publishing locks it in for students.
// ====================================================================
let grandDraftTestId = null;
let grandDraftQuestions = [];
let grandSelectedForRemoval = new Set();

async function openGrandTestEditor(testId, title) {
  grandDraftTestId = testId;
  grandSelectedForRemoval = new Set();
  document.getElementById('grandTestEditorCard').style.display = '';
  document.getElementById('grandTestEditorTitle').textContent = `Reviewing: ${title}`;
  document.getElementById('grandTestEditorCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
  await loadGrandDraftQuestions();
}
window.openGrandTestEditor = openGrandTestEditor;

async function loadGrandDraftQuestions() {
  const container = document.getElementById('grandTestQuestionsList');
  container.innerHTML = `<div class="loading-row"><div class="spinner"></div></div>`;
  try {
    const data = await api(`/api/bridge/faculty/tests/grand/${grandDraftTestId}/questions`);
    grandDraftQuestions = data.questions;
    renderGrandDraftQuestions();
  } catch (err) {
    container.innerHTML = `<div class="empty-state"><p>${err.message}</p></div>`;
  }
}

function renderGrandDraftQuestions() {
  const container = document.getElementById('grandTestQuestionsList');
  container.innerHTML = grandDraftQuestions.map(q => `
    <div class="card" style="background:var(--cream-deep); border:none; margin-bottom:0.6rem;" id="gq-${q.id}">
      <div class="flex-between">
        <label style="display:flex; align-items:center; gap:0.5rem;">
          <input type="checkbox" class="grand-remove-cb" data-id="${q.id}" ${grandSelectedForRemoval.has(q.id) ? 'checked' : ''}>
          <span class="helper-text">${q.subject} · ${q.chapter_name}${q.topic ? ' · ' + q.topic : ''} · ${q.difficulty}</span>
        </label>
        <button class="btn btn-outline" onclick="toggleGrandQuestionEdit(${q.id})">Edit</button>
      </div>
      <p class="mt-1" style="margin:0.4rem 0;">${q.question_text}</p>
      <div class="helper-text">A) ${q.option_a} &nbsp; B) ${q.option_b} &nbsp; C) ${q.option_c} &nbsp; D) ${q.option_d} &nbsp; — <strong>Correct: ${q.correct_answer}</strong></div>
      <div id="gq-edit-${q.id}" style="display:none;" class="mt-1">
        <textarea class="gq-edit-text" rows="2">${q.question_text}</textarea>
        <div class="grid-2 mt-1">
          <input type="text" class="gq-edit-opt" data-letter="A" value="${(q.option_a||'').replace(/"/g, '&quot;')}">
          <input type="text" class="gq-edit-opt" data-letter="B" value="${(q.option_b||'').replace(/"/g, '&quot;')}">
          <input type="text" class="gq-edit-opt" data-letter="C" value="${(q.option_c||'').replace(/"/g, '&quot;')}">
          <input type="text" class="gq-edit-opt" data-letter="D" value="${(q.option_d||'').replace(/"/g, '&quot;')}">
        </div>
        <div class="grid-2 mt-1">
          <select class="gq-edit-correct">
            ${['A','B','C','D'].map(l => `<option value="${l}" ${l === q.correct_answer ? 'selected' : ''}>${l}</option>`).join('')}
          </select>
          <button class="btn btn-primary" onclick="saveGrandQuestionEdit(${q.id})">Save</button>
        </div>
      </div>
    </div>`).join('');

  container.querySelectorAll('.grand-remove-cb').forEach(cb => {
    cb.onchange = () => {
      const id = parseInt(cb.dataset.id, 10);
      if (cb.checked) grandSelectedForRemoval.add(id); else grandSelectedForRemoval.delete(id);
      document.getElementById('grandSelectedCount').textContent = `${grandSelectedForRemoval.size} selected`;
    };
  });
  document.getElementById('grandSelectedCount').textContent = `${grandSelectedForRemoval.size} selected`;
}

window.toggleGrandQuestionEdit = (id) => {
  const el = document.getElementById(`gq-edit-${id}`);
  el.style.display = el.style.display === 'none' ? '' : 'none';
};

window.saveGrandQuestionEdit = async (id) => {
  const row = document.getElementById(`gq-edit-${id}`);
  const questionText = row.querySelector('.gq-edit-text').value.trim();
  const opts = {};
  row.querySelectorAll('.gq-edit-opt').forEach(el => { opts[el.dataset.letter] = el.value.trim(); });
  const correctAnswer = row.querySelector('.gq-edit-correct').value;
  try {
    await api(`/api/bridge/faculty/tests/grand/${grandDraftTestId}/questions/${id}`, {
      method: 'PUT',
      body: JSON.stringify({
        questionText, optionA: opts.A, optionB: opts.B, optionC: opts.C, optionD: opts.D, correctAnswer
      })
    });
    showToast('Question updated.', 'success');
    await loadGrandDraftQuestions();
  } catch (err) {
    showToast(err.message, 'error');
  }
};

async function addGrandQuestions() {
  const btn = document.getElementById('grandAddQuestionsBtn');
  const statusEl = document.getElementById('grandAddStatus');
  const rawText = document.getElementById('grandAddRawText').value.trim();
  const subject = document.getElementById('grandAddSubject').value;
  const chapterName = document.getElementById('grandAddChapter').value.trim();
  const removeQuestionIds = [...grandSelectedForRemoval];

  if (!rawText || rawText.length < 20) { statusEl.innerHTML = `<span class="badge danger">Please paste more of the question text first.</span>`; return; }
  if (!chapterName) { statusEl.innerHTML = `<span class="badge danger">Please enter a chapter name for the pasted batch.</span>`; return; }
  if (removeQuestionIds.length === 0) { statusEl.innerHTML = `<span class="badge danger">Tick at least one existing question above to replace.</span>`; return; }

  btn.disabled = true; btn.textContent = 'Arranging with AI...';
  statusEl.innerHTML = `<div class="loading-row"><div class="spinner"></div></div>`;
  try {
    const data = await api(`/api/bridge/faculty/tests/grand/${grandDraftTestId}/add-questions`, {
      method: 'POST',
      body: JSON.stringify({ rawText, subject, chapterName, removeQuestionIds })
    });
    statusEl.innerHTML = `<span class="badge success">✅ Added ${data.addedCount} question(s), replacing the ${removeQuestionIds.length} you selected. Total question count is unchanged.</span>`;
    showToast('Questions replaced.', 'success');
    document.getElementById('grandAddRawText').value = '';
    grandSelectedForRemoval = new Set();
    grandDraftQuestions = data.questions;
    renderGrandDraftQuestions();
  } catch (err) {
    statusEl.innerHTML = `<span class="badge danger">${err.message}</span>`;
    showToast(err.message, 'error');
  } finally {
    btn.disabled = false; btn.textContent = '✨ Arrange with AI & stage for replacement';
  }
}

async function publishGrandDraft() {
  const btn = document.getElementById('publishGrandDraftBtn');
  const msgEl = document.getElementById('grandPublishMessage');
  btn.disabled = true; btn.textContent = 'Publishing...';
  try {
    await api(`/api/bridge/faculty/tests/grand/${grandDraftTestId}/publish`, { method: 'POST' });
    msgEl.innerHTML = `<span class="badge success">✅ Published — students can now attempt this Grand Test.</span>`;
    showToast('Grand Test published.', 'success');
    renderGrandTestsList();
  } catch (err) {
    msgEl.innerHTML = `<span class="badge danger">${err.message}</span>`;
    showToast(err.message, 'error');
  } finally {
    btn.disabled = false; btn.textContent = '✅ Publish this Grand Test';
  }
}

function closeGrandTestEditor() {
  grandDraftTestId = null;
  document.getElementById('grandTestEditorCard').style.display = 'none';
}

// ====================================================================
// FACULTY LECTURE LINKS (chapter-wise CRUD, instant publish)
// ====================================================================
let facLectureEditingId = null;

function resetFacLectureForm() {
  facLectureEditingId = null;
  document.getElementById('facLectureEditingBanner').style.display = 'none';
  document.getElementById('facLectureSaveBtn').textContent = 'Publish lecture link';
  document.getElementById('facLectureTitle').value = '';
  document.getElementById('facLectureUrl').value = '';
  document.getElementById('facLectureChapter').value = '';
}

window.editFacLecture = (id, lectures) => {
  const l = lectures.find(x => x.id === id);
  if (!l) return;
  facLectureEditingId = id;
  document.getElementById('facLectureEditingBanner').style.display = '';
  document.getElementById('facLectureSaveBtn').textContent = 'Save changes';
  document.getElementById('facLectureTitle').value = l.title;
  document.getElementById('facLectureSubject').value = l.subject || 'Physics';
  document.getElementById('facLectureChapter').value = l.chapter_id || '';
  document.getElementById('facLectureUrl').value = l.url;
  document.getElementById('facLectureTitle').scrollIntoView({ behavior: 'smooth', block: 'center' });
};

window.deleteFacLecture = async (id) => {
  if (!confirm('Delete this lecture link?')) return;
  try {
    await api(`/api/faculty/lectures/${id}`, { method: 'DELETE' });
    showToast('Lecture link deleted.', '');
    renderFacLectures();
  } catch (err) {
    showToast(err.message, 'error');
  }
};

async function saveFacLecture() {
  const btn = document.getElementById('facLectureSaveBtn');
  const msgEl = document.getElementById('facLectureMessage');
  const title = document.getElementById('facLectureTitle').value.trim();
  const subject = document.getElementById('facLectureSubject').value;
  const chapterId = document.getElementById('facLectureChapter').value || null;
  const url = document.getElementById('facLectureUrl').value.trim();
  if (!title || !url) { msgEl.innerHTML = `<span class="badge danger">Please provide a title and URL.</span>`; return; }

  btn.disabled = true;
  try {
    if (facLectureEditingId) {
      await api(`/api/faculty/lectures/${facLectureEditingId}`, { method: 'PUT', body: JSON.stringify({ title, subject, chapterId, url }) });
      msgEl.innerHTML = `<span class="badge success">✅ Lecture link updated.</span>`;
    } else {
      await api('/api/faculty/lectures', { method: 'POST', body: JSON.stringify({ title, subject, chapterId, url }) });
      msgEl.innerHTML = `<span class="badge success">✅ Lecture link published.</span>`;
    }
    resetFacLectureForm();
    showToast('Saved.', 'success');
    renderFacLectures();
  } catch (err) {
    msgEl.innerHTML = `<span class="badge danger">${err.message}</span>`;
    showToast(err.message, 'error');
  } finally {
    btn.disabled = false;
  }
}

let lastFacLectures = [];

async function renderFacLectures() {
  const container = document.getElementById('facLectureList');
  if (!container) return;
  container.innerHTML = `<div class="loading-row"><div class="spinner"></div></div>`;
  try {
    const lectures = await api('/api/faculty/lectures');
    lastFacLectures = lectures;
    container.innerHTML = lectures.length ? lectures.map(l => `
      <div class="flex-between" style="padding:0.55rem 0; border-bottom:1px solid var(--border);">
        <div>
          <strong>${l.title}</strong>
          <div class="helper-text">${l.subject}${l.chapter_name ? ' · ' + l.chapter_name : ''}</div>
        </div>
        <div class="flex-row">
          <a class="btn btn-outline" href="${l.url}" target="_blank" rel="noopener">Open</a>
          <button class="btn btn-outline" onclick="editFacLecture(${l.id}, lastFacLectures)">Edit</button>
          <button class="btn btn-outline" onclick="deleteFacLecture(${l.id})">Delete</button>
        </div>
      </div>`).join('') : `<div class="empty-state"><p>No lecture links published yet.</p></div>`;
  } catch (err) {
    container.innerHTML = `<div class="empty-state"><p>${err.message}</p></div>`;
  }
}

// ====================================================================
// INDIVIDUAL STUDENT ANALYTICS — FACULTY
// ====================================================================
async function populateStudentAnalyticsSelect() {
  const select = document.getElementById('studentAnalyticsSelect');
  if (!select) return;
  try {
    const students = await api('/api/faculty/students');
    select.innerHTML = `<option value="">Select a student…</option>` + students.map(s => `<option value="${s.email}">${s.name} (${s.email})</option>`).join('');
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function loadStudentAnalytics() {
  const email = document.getElementById('studentAnalyticsSelect').value;
  const container = document.getElementById('studentAnalyticsResult');
  if (!email) { showToast('Please select a student first.', 'error'); return; }
  container.innerHTML = `<div class="loading-row"><div class="spinner"></div></div>`;
  try {
    const [d, bundle] = await Promise.all([
      api(`/api/faculty/students/${encodeURIComponent(email)}/analytics`),
      api(`/api/student/${encodeURIComponent(email)}`).catch(() => null)
    ]);
    container.innerHTML = `
      <div class="stat-tile-grid">
        <div class="stat-tile"><div class="stat-value">${d.testsAttempted}</div><div class="stat-label">Tests attempted</div></div>
        <div class="stat-tile"><div class="stat-value">${d.averageScore ?? '—'}</div><div class="stat-label">Avg score</div></div>
        <div class="stat-tile"><div class="stat-value">${d.averageAccuracyPercent ?? '—'}%</div><div class="stat-label">Avg accuracy</div></div>
        <div class="stat-tile"><div class="stat-value">${d.materialsCompleted}</div><div class="stat-label">Materials completed</div></div>
        <div class="stat-tile"><div class="stat-value">${d.lecturesWatched}</div><div class="stat-label">Lectures watched</div></div>
      </div>
      ${bundle ? `
      <h4 class="mt-2" style="margin-bottom:0.5rem;">Subject accuracy vs target (same view as the student's own Progress page)</h4>
      <div class="grid-2 mt-1">
        <div><canvas id="facStudentAccuracyChart" height="220"></canvas></div>
        <div><canvas id="facStudentWeeklyChart" height="220"></canvas></div>
      </div>` : ''}
      <h4 class="mt-2" style="margin-bottom:0.5rem;">Chapter-wise performance</h4>
      <div class="chart-box"><canvas id="studentAnalyticsChapterChart"></canvas></div>
      ${d.chapterWisePerformance.length ? d.chapterWisePerformance.map(c => `
        <div class="flex-between" style="padding:0.4rem 0; border-bottom:1px solid var(--border);">
          <span>${c.chapter} <span class="helper-text">(${c.correct}/${c.total})</span></span>
          <span class="badge ${c.accuracyPercent >= 70 ? 'success' : c.accuracyPercent < 50 ? 'danger' : 'warn'}">${c.accuracyPercent}%</span>
        </div>`).join('') : `<div class="empty-state"><p>No graded attempts yet.</p></div>`}
      <div class="grid-2 mt-2">
        <div>
          <h4 style="margin-bottom:0.5rem;">💪 Strong chapters</h4>
          ${d.strongChapters.length ? d.strongChapters.map(c => `<span class="badge success" style="margin:0.2rem;">${c.chapter} (${c.accuracyPercent}%)</span>`).join('') : `<p class="helper-text">None yet.</p>`}
        </div>
        <div>
          <h4 style="margin-bottom:0.5rem;">⚠️ Weak chapters</h4>
          ${d.weakChapters.length ? d.weakChapters.map(c => `<span class="badge danger" style="margin:0.2rem;">${c.chapter} (${c.accuracyPercent}%)</span>`).join('') : `<p class="helper-text">None yet.</p>`}
        </div>
      </div>
      <h4 class="mt-2" style="margin-bottom:0.5rem;">Recent activity</h4>
      ${d.recentActivity.length ? d.recentActivity.map(a => `
        <div style="padding:0.4rem 0; border-bottom:1px solid var(--border); font-size:0.88rem;">
          <span class="badge">${a.kind}</span> ${a.title} — ${a.detail} <span class="helper-text">· ${new Date(a.updated_at).toLocaleString()}</span>
        </div>`).join('') : `<div class="empty-state"><p>No recent activity.</p></div>`}
    `;
    renderStudentAnalyticsChart(d.chapterWisePerformance);
    if (bundle) renderFacultyStudentSubjectCharts(bundle);
  } catch (err) {
    container.innerHTML = `<div class="empty-state"><p>${err.message}</p></div>`;
  }
}

let facStudentAccuracyChartInstance = null;
let facStudentWeeklyChartInstance = null;
function renderFacultyStudentSubjectCharts(bundle) {
  const { progress, targets } = bundle;
  if (!progress || !targets) return;
  const accCanvas = document.getElementById('facStudentAccuracyChart');
  const weekCanvas = document.getElementById('facStudentWeeklyChart');
  if (!accCanvas || !weekCanvas || typeof Chart === 'undefined') return;

  if (facStudentAccuracyChartInstance) { facStudentAccuracyChartInstance.destroy(); facStudentAccuracyChartInstance = null; }
  if (facStudentWeeklyChartInstance) { facStudentWeeklyChartInstance.destroy(); facStudentWeeklyChartInstance = null; }

  facStudentAccuracyChartInstance = new Chart(accCanvas.getContext('2d'), {
    type: 'bar',
    data: {
      labels: ['Biology', 'Physics', 'Chemistry', 'Zoology', 'Mathematics'],
      datasets: [
        { label: 'Current %', data: [progress.bio_accuracy, progress.phy_accuracy, progress.chem_accuracy, progress.zoo_accuracy, progress.math_accuracy], backgroundColor: '#CFE3E6', borderRadius: 8 },
        { label: 'Target %', data: [targets.bio, targets.phy, targets.chem, targets.zoo, targets.math], backgroundColor: '#D98E5B', borderRadius: 8 }
      ]
    },
    options: { responsive: true, plugins: { legend: { position: 'bottom' } }, scales: { y: { beginAtZero: true, max: 100 } } }
  });

  let history = [];
  try { history = JSON.parse(progress.weekly_history); } catch (e) { history = []; }
  const weeks = history.length ? history.map((_, i) => i === history.length - 1 ? 'This week' : `W-${history.length - 1 - i}`) : [];

  facStudentWeeklyChartInstance = new Chart(weekCanvas.getContext('2d'), {
    type: 'line',
    data: {
      labels: weeks,
      datasets: [{ label: 'Overall accuracy', data: history, borderColor: '#D98E5B', backgroundColor: 'rgba(217,142,91,0.15)', fill: true, tension: 0.35 }]
    },
    options: { responsive: true, plugins: { legend: { position: 'bottom' } }, scales: { y: { beginAtZero: true, max: 100 } } }
  });
}

let studentAnalyticsChartInstance = null;
function renderStudentAnalyticsChart(chapterWisePerformance) {
  const canvas = document.getElementById('studentAnalyticsChapterChart');
  if (!canvas || typeof Chart === 'undefined') return;
  if (studentAnalyticsChartInstance) { studentAnalyticsChartInstance.destroy(); studentAnalyticsChartInstance = null; }
  if (!chapterWisePerformance || !chapterWisePerformance.length) {
    canvas.parentElement.innerHTML = `<div class="empty-state"><p>No graded attempts yet — a chart will appear once this student has results.</p></div>`;
    return;
  }
  studentAnalyticsChartInstance = new Chart(canvas.getContext('2d'), {
    type: 'bar',
    data: {
      labels: chapterWisePerformance.map(c => c.chapter),
      datasets: [{
        label: 'Accuracy %',
        data: chapterWisePerformance.map(c => c.accuracyPercent),
        backgroundColor: chapterWisePerformance.map(c => c.accuracyPercent >= 70 ? '#2e7d52' : c.accuracyPercent < 50 ? '#c0392b' : '#d4a017'),
        borderRadius: 4
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      scales: { y: { beginAtZero: true, max: 100, ticks: { callback: v => v + '%' } } },
      plugins: { legend: { display: false } }
    }
  });
}

// ====================================================================
// ERROR ATLAS — HOTSPOT ANALYSIS — FACULTY
// ====================================================================
async function renderErrorAtlas() {
  const container = document.getElementById('errorAtlasContainer');
  if (!container) return;
  container.innerHTML = `<div class="loading-row"><div class="spinner"></div></div>`;
  try {
    const data = await api('/api/faculty/error-atlas');
    container.innerHTML = data.chapters.length ? data.chapters.map(c => `
      <div class="topic-group">
        <div class="topic-group-header" onclick="this.parentElement.classList.toggle('open')">
          <span>🔥 ${c.chapter} <span class="helper-text">(${c.totalAttempts} attempt(s))</span></span>
          <span class="chevron">›</span>
        </div>
        <div class="topic-group-body">
          <h4 style="margin:0.8rem 0 0.5rem;">Hotspot questions</h4>
          ${c.hotspotQuestions.map(q => `
            <div class="atlas-item">
              <div class="topic-row flex-between">
                <span>${q.questionText}</span>
                <span class="badge ${q.errorPercentage >= 60 ? 'danger' : q.errorPercentage >= 30 ? 'warn' : ''}">${q.errorPercentage !== null ? q.errorPercentage + '%' : q.mistakeCount + ' miss(es)'}</span>
              </div>
              <div class="remedy">${q.testTitle}${q.topic ? ' · ' + q.topic : ''} · ${q.difficulty}</div>
            </div>`).join('')}
          <h4 style="margin:0.8rem 0 0.5rem;">Frequently misunderstood concepts</h4>
          ${c.frequentConcepts.map(fc => `<span class="badge warn" style="margin:0.2rem;">${fc.topic} (${fc.count})</span>`).join('') || '<p class="helper-text">No concept data yet.</p>'}
        </div>
      </div>`).join('') : `<div class="empty-state"><p>No mistakes logged yet for your tests.</p></div>`;
  } catch (err) {
    container.innerHTML = `<div class="empty-state"><p>${err.message}</p></div>`;
  }
}

// ====================================================================
// STUDY MATERIALS — FACULTY (link-only — no file uploads, to keep the
// database lean; faculty share a Drive/YouTube/etc. link instead)
// ====================================================================
function toggleMaterialTermField() {
  const subject = document.getElementById('materialSubject').value;
  document.getElementById('materialTermGroup').style.display = subject === 'Physics' ? '' : 'none';
}

let materialEditingId = null;

function resetMaterialForm() {
  materialEditingId = null;
  document.getElementById('materialEditingBanner').style.display = 'none';
  document.getElementById('uploadMaterialBtn').textContent = 'Publish to students';
  document.getElementById('materialTitle').value = '';
  document.getElementById('materialChapter').value = '';
  document.getElementById('materialTopic').value = '';
  document.getElementById('materialDescription').value = '';
  document.getElementById('materialTerm').value = '';
  document.getElementById('materialUrlInput').value = '';
}

window.editMaterial = async (id, materials) => {
  const m = materials.find(x => x.id === id);
  if (!m) return;
  materialEditingId = id;
  document.getElementById('materialEditingBanner').style.display = '';
  document.getElementById('uploadMaterialBtn').textContent = 'Save changes';
  document.getElementById('materialTitle').value = m.title || '';
  document.getElementById('materialSubject').value = m.subject || 'Physics';
  toggleMaterialTermField();
  document.getElementById('materialChapter').value = m.chapter_id || '';
  document.getElementById('materialTopic').value = m.topic || '';
  document.getElementById('materialDescription').value = m.description || '';
  document.getElementById('materialTerm').value = m.term || '';
  document.getElementById('materialUrlInput').value = m.external_url || '';
  if (m.material_type === 'file') {
    showToast('This was uploaded as a file under the old system — add a link to replace it (files are no longer stored).', '');
  }
  document.getElementById('materialTitle').scrollIntoView({ behavior: 'smooth', block: 'center' });
};

async function uploadMaterial() {
  const btn = document.getElementById('uploadMaterialBtn');
  const msgEl = document.getElementById('materialUploadMessage');
  const title = document.getElementById('materialTitle').value.trim();
  const subject = document.getElementById('materialSubject').value;
  const chapterId = document.getElementById('materialChapter').value || null;
  const topic = document.getElementById('materialTopic').value.trim();
  const description = document.getElementById('materialDescription').value.trim();
  const term = document.getElementById('materialTerm').value;
  const externalUrl = document.getElementById('materialUrlInput').value.trim();

  if (!title || !subject) {
    msgEl.innerHTML = `<span class="badge danger">Please provide a title and subject.</span>`;
    return;
  }
  if (!externalUrl) {
    msgEl.innerHTML = `<span class="badge danger">Please provide a link (e.g. a Google Drive share link).</span>`;
    return;
  }

  btn.disabled = true; btn.textContent = materialEditingId ? 'Saving...' : 'Publishing...';
  try {
    if (materialEditingId) {
      const data = await api(`/api/faculty/materials/${materialEditingId}`, {
        method: 'PUT',
        body: JSON.stringify({ title, chapterId, topic, description, term: term || null, externalUrl })
      });
      msgEl.innerHTML = `<span class="badge success">✅ ${data.message}</span>`;
    } else {
      const data = await api('/api/faculty/materials/link', {
        method: 'POST',
        body: JSON.stringify({ title, subject, chapterId, topic, description, externalUrl, term: term || null })
      });
      msgEl.innerHTML = `<span class="badge success">✅ ${data.message}</span>`;
    }
    resetMaterialForm();
    showToast(materialEditingId ? 'Material updated.' : 'Material published to students.', 'success');
    renderFacultyMaterials();
  } catch (err) {
    msgEl.innerHTML = `<span class="badge danger">${err.message}</span>`;
    showToast(err.message, 'error');
  } finally {
    btn.disabled = false; btn.textContent = materialEditingId ? 'Save changes' : 'Publish to students';
  }
}

function formatFileSize(bytes) {
  if (!bytes) return '';
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

let lastFacultyMaterials = [];

async function renderFacultyMaterials() {
  const container = document.getElementById('facultyMaterialsList');
  if (!container) return;
  container.innerHTML = `<div class="loading-row"><div class="spinner"></div></div>`;
  try {
    const materials = await api('/api/faculty/materials');
    lastFacultyMaterials = materials;
    container.innerHTML = materials.length ? materials.map(m => `
      <div class="flex-between" style="padding:0.6rem 0; border-bottom:1px solid var(--border);">
        <div>
          <strong>${m.title}</strong>
          <div class="helper-text">${m.subject}${m.chapter ? ' · ' + m.chapter : ''}${m.topic ? ' · ' + m.topic : ''}${m.term ? ' · Term ' + m.term : ''} · ${m.material_type === 'file' ? ('legacy file: ' + (m.file_name || '') + ' ' + formatFileSize(m.file_size)) : (m.material_type === 'note' ? 'Note' : 'Link')}</div>
        </div>
        <div class="flex-row">
          <button class="btn btn-outline" onclick="editMaterial(${m.id}, lastFacultyMaterials)">Edit</button>
          <button class="btn btn-outline" onclick="deleteMaterial(${m.id})">Remove</button>
        </div>
      </div>`).join('') : `<div class="empty-state"><p>No materials shared yet.</p></div>`;
  } catch (err) {
    container.innerHTML = `<div class="empty-state"><p>${err.message}</p></div>`;
  }
}

window.deleteMaterial = async (id) => {
  try {
    await api(`/api/faculty/materials/${id}`, { method: 'DELETE' });
    showToast('Material removed.', '');
    renderFacultyMaterials();
  } catch (err) {
    showToast(err.message, 'error');
  }
};

// ====================================================================
// STUDY MATERIALS — STUDENT (browse & download)
// ====================================================================
async function renderMaterials() {
  const container = document.getElementById('materialsList');
  if (!container) return;
  const filterEl = document.getElementById('materialsSubjectFilter');
  const subject = filterEl ? filterEl.value : '';
  container.innerHTML = `<div class="loading-row"><div class="spinner"></div></div>`;
  try {
    const query = subject ? `?subject=${encodeURIComponent(subject)}` : '';
    const materials = await api(`/api/materials${query}`);
    container.innerHTML = materials.length ? materials.map(m => `
      <div class="flex-between" style="padding:0.6rem 0; border-bottom:1px solid var(--border);">
        <div>
          <strong>${m.title}</strong>
          <div class="helper-text">${m.subject}${m.chapter ? ' · ' + m.chapter : ''} · ${m.uploaded_by_name || 'Faculty'}${m.description ? ' — ' + m.description : ''}</div>
        </div>
        ${m.material_type === 'file'
          ? `<a class="btn btn-outline" href="${API_BASE}/api/materials/${m.id}/download" target="_blank" rel="noopener">⬇ ${formatFileSize(m.file_size)}</a>`
          : `<a class="btn btn-outline" href="${m.external_url}" target="_blank" rel="noopener">🔗 Open</a>`}
      </div>`).join('') : `<div class="empty-state"><p>${subject ? `No ${subject} study materials published yet — check back soon.` : 'No study materials published yet — check back soon.'}</p></div>`;
  } catch (err) {
    container.innerHTML = `<div class="empty-state"><p>${err.message}</p></div>`;
  }
}



async function renderStudentTests() {
  const container = document.getElementById('studentTestsList');
  if (!container) return;
  container.innerHTML = `<div class="loading-row"><div class="spinner"></div></div>`;
  try {
    const tests = await api('/api/student/tests');
    container.innerHTML = tests.length ? tests.map(t => `
      <div class="flex-between" style="padding:0.6rem 0; border-bottom:1px solid var(--border);">
        <div>
          <strong>${t.title}</strong>
          <div class="helper-text">${t.subject}${t.chapter ? ' · ' + t.chapter : ''} · ${t.question_count} question(s) · ${t.time_limit_min} min${t.negative_marking ? ' · negative marking' : ''}</div>
        </div>
        ${t.attempted
          ? `<span class="badge success">✅ Completed</span>`
          : `<button class="btn btn-primary" onclick="startTest(${t.id})">Start test</button>`}
      </div>`).join('') : `<div class="empty-state"><p>No tests available right now — check back soon.</p></div>`;
  } catch (err) {
    container.innerHTML = `<div class="empty-state"><p>${err.message}</p></div>`;
  }
}

window.startTest = async (testId) => {
  const area = document.getElementById('testAttemptArea');
  area.innerHTML = `<div class="loading-row"><div class="spinner"></div></div>`;
  try {
    const { test, questions } = await api(`/api/student/tests/${testId}`);
    activeStudentTest = test;
    activeTestQuestions = questions;

    area.innerHTML = `
      <div class="card">
        <h3>${test.title}</h3>
        <p class="helper-text">${test.subject}${test.chapter ? ' · ' + test.chapter : ''} · Time limit: ${test.time_limit_min} min${test.negative_marking ? ' · Negative marking enabled' : ''}</p>
        <div id="testQuestionsArea" class="mt-2"></div>
        <button id="submitTestBtn" class="btn btn-primary mt-2">Submit test</button>
        <div id="testResultArea" class="mt-2"></div>
      </div>`;

    document.getElementById('testQuestionsArea').innerHTML = questions.map((q, idx) => `
      <div class="quiz-item">
        <div class="q-meta">${q.topic || ''}</div>
        <div class="q-text">${idx + 1}. ${q.question_text}</div>
        ${q.q_type === 'mcq'
          ? (q.options || []).map((opt, oi) => `
              <label class="quiz-option">
                <input type="radio" name="tq${q.id}" value="${oi}"> ${opt}
              </label>`).join('')
          : `<input type="text" class="tq-fill-input" data-qid="${q.id}" placeholder="Type your answer">`}
      </div>`).join('');

    document.getElementById('submitTestBtn').onclick = submitTest;
    window.scrollTo({ top: area.offsetTop, behavior: 'smooth' });
  } catch (err) {
    area.innerHTML = `<div class="empty-state"><p>${err.message}</p></div>`;
  }
};

async function submitTest() {
  if (!activeStudentTest) return;
  const btn = document.getElementById('submitTestBtn');
  const answers = activeTestQuestions.map(q => {
    if (q.q_type === 'mcq') {
      const selected = document.querySelector(`input[name="tq${q.id}"]:checked`);
      return { questionId: q.id, answer: selected ? selected.value : '' };
    } else {
      const input = document.querySelector(`.tq-fill-input[data-qid="${q.id}"]`);
      return { questionId: q.id, answer: input ? input.value.trim() : '' };
    }
  });

  btn.disabled = true; btn.textContent = 'Submitting...';
  try {
    const result = await api(`/api/student/tests/${activeStudentTest.id}/submit`, {
      method: 'POST', body: JSON.stringify({ answers })
    });
    document.getElementById('testResultArea').innerHTML = `
      <div class="card" style="background:var(--cream-deep); border:none;">
        <strong>Score: ${result.score} / ${result.total}</strong> (Accuracy: ${result.accuracy}%)
        <p class="helper-text mt-1">Correct: ${result.correctCount} · Attempted: ${result.attemptedCount}</p>
        ${result.results.filter(r => !r.isCorrect).map(r => `
          <div style="margin-top:0.5rem; padding-top:0.5rem; border-top:1px solid var(--border);">
            <div style="font-weight:600; font-size:0.9rem;">❌ ${r.questionText}</div>
            <div class="helper-text">Your answer: ${r.yourAnswer || '(unattempted)'} · Correct: ${r.correctAnswer}</div>
          </div>`).join('')}
      </div>`;
    showToast('Test submitted — progress updated.', 'success');
    btn.style.display = 'none';
    renderStudentTests();
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    btn.disabled = false; btn.textContent = 'Submit test';
  }
}


async function renderAdmin() {
  try {
    const { examDate } = await api('/api/admin/exam-date');
    document.getElementById('adminExamDate').value = examDate || '';

    const pending = await api('/api/admin/pending-lectures');
    document.getElementById('pendingLecturesAdmin').innerHTML = pending.length ? pending.map(s => `
      <div class="card" style="margin-bottom:0.75rem; background:var(--cream-deep); border:none;">
        <div class="flex-between">
          <div>
            <strong>${s.title}</strong>
            <div class="helper-text">by ${s.lecturer_name} · ${s.subject}</div>
          </div>
          <div class="flex-row">
            <a href="${s.url}" target="_blank" rel="noopener" class="btn btn-outline">Preview</a>
            <button class="btn btn-primary" onclick="approveLecture(${s.id})">Approve</button>
            <button class="btn btn-danger" onclick="rejectLecture(${s.id})">Reject</button>
          </div>
        </div>
      </div>`).join('') : `<div class="empty-state"><p>No pending submissions — all caught up!</p></div>`;

    const analytics = await api('/api/admin/analytics-summary');
    document.getElementById('adminAnalyticsSummary').innerHTML = analytics.length ? `
      <div style="overflow-x:auto;">
      <table style="width:100%; border-collapse:collapse; font-size:0.9rem;">
        <thead><tr style="text-align:left; border-bottom:1px solid var(--border);">
          <th style="padding:0.5rem;">Student</th><th style="padding:0.5rem;">Category / Aim</th>
          <th style="padding:0.5rem;">Bio</th><th style="padding:0.5rem;">Phy</th><th style="padding:0.5rem;">Chem</th><th style="padding:0.5rem;">Quizzes</th>
        </tr></thead>
        <tbody>
          ${analytics.map(s => `
            <tr style="border-bottom:1px solid var(--border);">
              <td style="padding:0.5rem;"><strong>${s.name}</strong><br><span class="helper-text">${s.email}</span></td>
              <td style="padding:0.5rem;">${s.category} · ${s.aim}</td>
              <td style="padding:0.5rem;">${s.bio_accuracy}%</td>
              <td style="padding:0.5rem;">${s.phy_accuracy}%</td>
              <td style="padding:0.5rem;">${s.chem_accuracy}%</td>
              <td style="padding:0.5rem;">${s.quiz_count}</td>
            </tr>`).join('')}
        </tbody>
      </table></div>` : `<div class="empty-state"><p>No students registered yet.</p></div>`;

    const feedback = await api('/api/admin/feedback');
    document.getElementById('adminFeedbackList').innerHTML = feedback.length ? feedback.map(f => `
      <div style="padding:0.6rem 0; border-bottom:1px solid var(--border);">
        <p>${f.message}</p>
        <span class="helper-text">${f.created_at}</span>
      </div>`).join('') : `<div class="empty-state"><p>No feedback submitted yet.</p></div>`;

  } catch (err) {
    showToast(err.message, 'error');
  }

  renderCutoffCacheTable();
}

async function renderCutoffCacheTable() {
  const tableEl = document.getElementById('cutoffCacheTable');
  if (!tableEl) return;
  if (!currentUser || currentUser.role !== 'admin') {
    tableEl.innerHTML = `<div class="empty-state"><p>Log in as Admin (via the Login page) to view and refresh live cutoff data.</p></div>`;
    return;
  }
  tableEl.innerHTML = `<div class="loading-row"><div class="spinner"></div></div>`;
  try {
    const { rows } = await api('/api/admin/cutoff-cache');
    tableEl.innerHTML = rows.length ? `
      <div style="overflow-x:auto;"><table style="width:100%; border-collapse:collapse; font-size:0.9rem;">
        <thead><tr style="text-align:left; border-bottom:1px solid var(--border);">
          <th style="padding:0.5rem;">Year</th><th style="padding:0.5rem;">Category</th>
          <th style="padding:0.5rem;">AIIMS-tier</th><th style="padding:0.5rem;">Govt</th><th style="padding:0.5rem;">Private</th>
          <th style="padding:0.5rem;">Fetched</th>
        </tr></thead>
        <tbody>${rows.map(r => `
          <tr style="border-bottom:1px solid var(--border);">
            <td style="padding:0.5rem;">${r.year}</td>
            <td style="padding:0.5rem;">${r.category}</td>
            <td style="padding:0.5rem;">${r.aiims}</td>
            <td style="padding:0.5rem;">${r.govt}</td>
            <td style="padding:0.5rem;">${r.private}</td>
            <td style="padding:0.5rem;">${new Date(r.fetched_at).toLocaleDateString()}</td>
          </tr>`).join('')}</tbody>
      </table></div>` : `<div class="empty-state"><p>No live data fetched yet — click "Refresh live cutoff data now".</p></div>`;
  } catch (err) {
    tableEl.innerHTML = `<div class="empty-state"><p>${err.message}</p></div>`;
  }
}

async function refreshCutoffCache() {
  const btn = document.getElementById('refreshCutoffCacheBtn');
  const msgEl = document.getElementById('cutoffCacheMessage');
  if (!currentUser || currentUser.role !== 'admin') {
    msgEl.innerHTML = `<span class="badge danger">Please log in as Admin via the Login page first.</span>`;
    return;
  }
  btn.disabled = true; btn.textContent = 'Searching the web & extracting data...';
  msgEl.innerHTML = '';
  try {
    const data = await api('/api/admin/cutoff-cache/refresh', { method: 'POST', body: JSON.stringify({ year: new Date().getFullYear() + 1 }) });
    msgEl.innerHTML = `<span class="badge success">✅ ${data.message}</span>`;
    showToast('Live cutoff data refreshed.', 'success');
    renderCutoffCacheTable();
  } catch (err) {
    msgEl.innerHTML = `<span class="badge danger">${err.message}</span>`;
    showToast(err.message, 'error');
  } finally {
    btn.disabled = false; btn.textContent = 'Refresh live cutoff data now';
  }
}


window.approveLecture = async (id) => {
  try {
    await api(`/api/admin/approve-lecture/${id}`, { method: 'POST' });
    showToast('Lecture approved — now visible in Practice.', 'success');
    renderAdmin();
  } catch (err) { showToast(err.message, 'error'); }
};

window.rejectLecture = async (id) => {
  if (!confirm('Reject and remove this lecture submission?')) return;
  try {
    await api(`/api/admin/reject-lecture/${id}`, { method: 'DELETE' });
    showToast('Submission rejected.', 'success');
    renderAdmin();
  } catch (err) { showToast(err.message, 'error'); }
};

async function setExamDate() {
  const newDate = document.getElementById('adminExamDate').value;
  if (!newDate) { showToast('Please choose a date.', 'error'); return; }
  try {
    await api('/api/admin/exam-date', { method: 'POST', body: JSON.stringify({ examDate: newDate }) });
    showToast('Platform exam date updated.', 'success');
  } catch (err) { showToast(err.message, 'error'); }
}

async function loadFacultyExamDate() {
  const el = document.getElementById('facExamDate');
  if (!el) return;
  try {
    const { examDate } = await api('/api/admin/exam-date');
    el.value = examDate ? examDate.split('T')[0] : '';
  } catch (err) { /* non-fatal */ }
}

async function setFacultyExamDate() {
  const newDate = document.getElementById('facExamDate').value;
  const msgEl = document.getElementById('facExamDateMessage');
  if (!newDate) { showToast('Please choose a date.', 'error'); return; }
  try {
    await api('/api/admin/exam-date', { method: 'POST', body: JSON.stringify({ examDate: newDate }) });
    msgEl.innerHTML = `<span class="badge success">✅ Exam date updated — every student's countdown will reflect this.</span>`;
    showToast('Exam date updated.', 'success');
  } catch (err) {
    msgEl.innerHTML = `<span class="badge danger">${err.message}</span>`;
    showToast(err.message, 'error');
  }
}

async function resetAllData() {
  if (!confirm('This will permanently delete ALL students, progress, lectures and feedback. Continue?')) return;
  if (!confirm('Are you absolutely sure? This cannot be undone.')) return;
  try {
    await api('/api/admin/reset-all', { method: 'POST' });
    localStorage.removeItem('ctk_bridge_email');
    localStorage.removeItem('neet_ctk_lecturer');
    showToast('All platform data has been reset.', 'success');
    setTimeout(() => location.reload(), 800);
  } catch (err) { showToast(err.message, 'error'); }
}

// ====================================================================
// FEEDBACK
// ====================================================================
// ====================================================================
// PHYSICS STUDENT MODULE
// A dedicated, Physics-curated student experience layered on top of the
// existing platform: entry-level diagnostics, Term-organised materials,
// lecture/material progress tracking, topic-wise analytics, and
// personalised recommendations. Mirrors the look & feel of the Practice
// and Progress pages above; doesn't touch their behaviour.
// ====================================================================
let activePhysicsEntryTest = null;
let activePhysicsEntryQuestions = null;
let physicsMaterialsCache = null;

const NEET_PAGE_SUBJECTS = ['Physics', 'Chemistry', 'Botany', 'Zoology'];
const JEE_PAGE_SUBJECTS = ['Physics', 'Chemistry', 'Mathematics'];

async function loadPhysicsModule() {
  const select = document.getElementById('subjectPageSelect');
  const data = await loadStudentData(currentStudentEmail).catch(() => null);
  const targetExam = data?.student?.target_exam || 'NEET';
  const subjects = targetExam === 'JEE' ? JEE_PAGE_SUBJECTS
    : targetExam === 'BOTH' ? [...new Set([...NEET_PAGE_SUBJECTS, ...JEE_PAGE_SUBJECTS])]
    : NEET_PAGE_SUBJECTS;

  const prevValue = select.value;
  select.innerHTML = subjects.map(s => `<option value="${s}">${s}</option>`).join('');
  select.value = subjects.includes(prevValue) ? prevValue : subjects[0];
  select.onchange = () => renderSubjectPage(select.value);

  renderSubjectPage(select.value);
}

function renderSubjectPage(subject) {
  document.getElementById('subjectPageHeading').textContent = `📖 Your ${subject} Journey`;
  const physicsContent = document.getElementById('subjectPagePhysicsContent');
  const genericContent = document.getElementById('subjectPageGenericContent');

  if (subject === 'Physics') {
    // Physics has its own dedicated diagnostics/analytics/recommendations
    // system with real backing data -- shown as-is when Physics is picked.
    physicsContent.style.display = '';
    genericContent.style.display = 'none';
    renderPhysicsDashboard();
    renderPhysicsMaterials();
    renderPhysicsLectures();
    renderPhysicsAnalytics();
    renderPhysicsRecommendations();
  } else {
    // Other subjects don't have a dedicated diagnostics backend (that only
    // exists for Physics), so they get materials + lectures for that
    // subject, plus a link into the Test Centre for subject-focused
    // practice via Chapter Combo Test.
    physicsContent.style.display = 'none';
    genericContent.style.display = '';
    document.getElementById('genericSubjectMaterialsHeading').textContent = `📘 ${subject} Learning Materials`;
    document.getElementById('genericSubjectLecturesHeading').textContent = `🎥 ${subject} Lectures`;
    renderGenericSubjectMaterials(subject);
    renderGenericSubjectLectures(subject);
  }
}

async function renderGenericSubjectMaterials(subject) {
  const container = document.getElementById('genericSubjectMaterialsContent');
  container.innerHTML = `<div class="loading-row"><div class="spinner"></div></div>`;
  try {
    const materials = await api(`/api/materials?subject=${encodeURIComponent(subject)}`);
    container.innerHTML = materials.length ? materials.map(m => `
      <div class="flex-between" style="padding:0.6rem 0; border-bottom:1px solid var(--border);">
        <div>
          <strong>${m.title}</strong>
          <div class="helper-text">${m.chapter ? m.chapter + ' · ' : ''}${m.uploaded_by_name || 'Faculty'}${m.description ? ' — ' + m.description : ''}</div>
        </div>
        ${m.material_type === 'file'
          ? `<a class="btn btn-outline" href="${API_BASE}/api/materials/${m.id}/download" target="_blank" rel="noopener">⬇ ${formatFileSize(m.file_size)}</a>`
          : `<a class="btn btn-outline" href="${m.external_url}" target="_blank" rel="noopener">🔗 Open</a>`}
      </div>`).join('') : `<div class="empty-state"><p>No ${subject} study materials published yet — check back soon.</p></div>`;
  } catch (err) {
    container.innerHTML = `<div class="empty-state"><p>${err.message}</p></div>`;
  }
}

async function renderGenericSubjectLectures(subject) {
  const container = document.getElementById('genericSubjectLecturesList');
  container.innerHTML = `<div class="loading-row"><div class="spinner"></div></div>`;
  try {
    const lectures = (await api('/api/approved-lectures')).filter(l => l.subject === subject);
    container.innerHTML = lectures.length ? lectures.map(l => `
      <div class="video-card">
        <iframe src="${l.url}" allowfullscreen loading="lazy"></iframe>
        <div class="video-card-title">${l.title}</div>
      </div>`).join('') : `<div class="empty-state"><p>No ${subject} lectures published yet.</p></div>`;
  } catch (err) {
    container.innerHTML = `<div class="empty-state"><p>${err.message}</p></div>`;
  }
}

function proficiencyBadge(level) {
  if (!level || level === 'Not yet assessed') return `<span class="badge">Not yet assessed</span>`;
  return `<span class="badge proficiency-badge ${level}">${level}</span>`;
}

async function renderPhysicsDashboard() {
  const el = document.getElementById('physicsDashboardContent');
  if (!el) return;
  el.innerHTML = `<div class="loading-row"><div class="spinner"></div></div>`;
  try {
    const d = await api('/api/physics/dashboard');
    el.innerHTML = `
      <div class="flex-between mt-1">
        <span>Current level</span>
        ${proficiencyBadge(d.currentLevel)}
      </div>
      <div class="stat-tile-grid">
        <div class="stat-tile"><div class="stat-value">${d.lecturesCompleted}/${d.lecturesTotal}</div><div class="stat-label">Lectures completed</div></div>
        <div class="stat-tile"><div class="stat-value">${d.materialsCompleted}/${d.materialsTotal}</div><div class="stat-label">Materials completed</div></div>
        <div class="stat-tile"><div class="stat-value">${d.testsAttempted}</div><div class="stat-label">Tests attempted</div></div>
        <div class="stat-tile"><div class="stat-value">${d.averageScore != null ? d.averageScore + '%' : '—'}</div><div class="stat-label">Average score</div></div>
      </div>
      <div class="grid-2 mt-2">
        <div>
          <strong>Strong topics</strong>
          <div class="mt-1">${d.strongTopics.length ? d.strongTopics.map(t => `<span class="badge success" style="margin:0 0.3rem 0.3rem 0;">✓ ${t}</span>`).join('') : `<span class="helper-text">None yet — keep practicing!</span>`}</div>
        </div>
        <div>
          <strong>Weak topics</strong>
          <div class="mt-1">${d.weakTopics.length ? d.weakTopics.map(t => `<span class="badge danger" style="margin:0 0.3rem 0.3rem 0;">✗ ${t}</span>`).join('') : `<span class="helper-text">No weak topics identified yet.</span>`}</div>
        </div>
      </div>`;
  } catch (err) {
    el.innerHTML = `<div class="empty-state"><p>${err.message}</p></div>`;
  }
}

async function renderPhysicsEntryTests() {
  const el = document.getElementById('physicsEntryTestsList');
  if (!el) return;
  el.innerHTML = `<div class="loading-row"><div class="spinner"></div></div>`;
  try {
    const tests = await api('/api/physics/entry-tests');
    el.innerHTML = tests.map(t => `
      <div class="flex-between" style="padding:0.6rem 0; border-bottom:1px solid var(--border);">
        <div>
          <strong>${t.title}</strong> ${t.mandatory ? `<span class="badge warn">Mandatory</span>` : `<span class="badge">Optional</span>`}
          ${t.attempted ? `<div class="helper-text mt-1">Last attempt: ${t.lastAttempt.score}/${t.lastAttempt.total} · ${t.lastAttempt.proficiency_level}</div>` : ''}
        </div>
        <button class="btn ${t.attempted ? 'btn-outline' : 'btn-primary'}" onclick="startPhysicsEntryTest(${t.testNumber})">
          ${t.attempted ? 'Retake test' : 'Start test'}
        </button>
      </div>`).join('');
  } catch (err) {
    el.innerHTML = `<div class="empty-state"><p>${err.message}</p></div>`;
  }
}

window.startPhysicsEntryTest = async (testNumber) => {
  const area = document.getElementById('physicsEntryTestArea');
  area.innerHTML = `<div class="loading-row"><div class="spinner"></div></div>`;
  try {
    const { test, questions } = await api(`/api/physics/entry-tests/${testNumber}`);
    activePhysicsEntryTest = test;
    activePhysicsEntryQuestions = questions;
    physicsEntryTestStartedAt = Date.now();

    area.innerHTML = `
      <div class="card">
        <h3>${test.title}</h3>
        <div id="physicsEntryQuestionsArea" class="mt-2"></div>
        <button id="submitPhysicsEntryTestBtn" class="btn btn-primary mt-2">Submit test</button>
        <div id="physicsEntryResultArea" class="mt-2"></div>
      </div>`;

    document.getElementById('physicsEntryQuestionsArea').innerHTML = questions.map((q, idx) => `
      <div class="quiz-item">
        <div class="q-meta">${q.topic}</div>
        <div class="q-text">${idx + 1}. ${q.question_text}</div>
        ${q.options.map((opt, oi) => `
          <label class="quiz-option">
            <input type="radio" name="peq${q.id}" value="${oi}"> ${opt}
          </label>`).join('')}
      </div>`).join('');

    document.getElementById('submitPhysicsEntryTestBtn').onclick = submitPhysicsEntryTest;
    window.scrollTo({ top: area.offsetTop, behavior: 'smooth' });
  } catch (err) {
    area.innerHTML = `<div class="empty-state"><p>${err.message}</p></div>`;
  }
};

let physicsEntryTestStartedAt = null;

async function submitPhysicsEntryTest() {
  if (!activePhysicsEntryTest) return;
  const btn = document.getElementById('submitPhysicsEntryTestBtn');
  const answers = activePhysicsEntryQuestions.map(q => {
    const selected = document.querySelector(`input[name="peq${q.id}"]:checked`);
    return { questionId: q.id, answer: selected ? selected.value : '' };
  });
  const timeTakenSeconds = physicsEntryTestStartedAt ? Math.round((Date.now() - physicsEntryTestStartedAt) / 1000) : null;

  btn.disabled = true; btn.textContent = 'Submitting...';
  try {
    const result = await api(`/api/physics/entry-tests/${activePhysicsEntryTest.test_number}/submit`, {
      method: 'POST', body: JSON.stringify({ answers, timeTakenSeconds })
    });
    document.getElementById('physicsEntryResultArea').innerHTML = `
      <div class="card" style="background:var(--cream-deep); border:none;">
        <strong>Score: ${result.score} / ${result.total}</strong> (Accuracy: ${result.accuracy}%)
        <div class="mt-1">Proficiency: ${proficiencyBadge(result.proficiencyLevel)}</div>
      </div>`;
    showToast('Entry test submitted.', 'success');
    btn.style.display = 'none';
    renderPhysicsEntryTests();
    renderPhysicsDashboard();
    renderPhysicsAnalytics();
    renderPhysicsRecommendations();
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    btn.disabled = false; btn.textContent = 'Submit test';
  }
}

const PHYSICS_TERM_LABELS = { 1: 'Term 1 · Conceptual Understanding', 2: 'Term 2 · Definitions & Formulae', 3: 'Term 3 · Advanced Applications' };

function physicsMaterialRow(m) {
  const action = m.material_type === 'file'
    ? `<a class="btn btn-outline" href="${API_BASE}/api/materials/${m.id}/download" target="_blank" onclick="markPhysicsMaterialViewed(${m.id}, true)">Download</a>`
    : (m.material_type === 'link'
        ? `<a class="btn btn-outline" href="${m.external_url}" target="_blank" onclick="markPhysicsMaterialViewed(${m.id})">Open link</a>`
        : `<button class="btn btn-outline" onclick="markPhysicsMaterialViewed(${m.id})">${m.viewed ? 'Viewed' : 'Mark as viewed'}</button>`);
  return `
    <div class="material-row">
      <div>
        <div class="material-title">${m.title} ${m.completed ? '<span class="badge success">✓ Completed</span>' : ''}</div>
        ${m.description ? `<div class="material-desc">${m.description}</div>` : ''}
      </div>
      <div class="flex-row">
        ${action}
        ${!m.completed ? `<button class="btn btn-outline" onclick="markPhysicsMaterialComplete(${m.id})">Mark complete</button>` : ''}
      </div>
    </div>`;
}

async function renderPhysicsMaterials() {
  const el = document.getElementById('physicsMaterialsContent');
  if (!el) return;
  el.innerHTML = `<div class="loading-row"><div class="spinner"></div></div>`;
  try {
    const data = await api('/api/physics/materials');
    physicsMaterialsCache = data;

    // Populate the topic jump-to filter once
    const filterEl = document.getElementById('physicsTopicFilter');
    if (filterEl && filterEl.options.length <= 1) {
      data.topics.forEach(topic => {
        const opt = document.createElement('option');
        opt.value = topic; opt.textContent = topic;
        filterEl.appendChild(opt);
      });
    }

    el.innerHTML = data.topics.map((topic, idx) => {
      const buckets = data.materialsByTopic[topic] || { 1: [], 2: [], 3: [], untagged: [] };
      const totalCount = buckets[1].length + buckets[2].length + buckets[3].length + buckets.untagged.length;
      return `
        <div class="topic-group" id="physicsTopicGroup-${idx}" data-topic="${topic}">
          <div class="topic-group-header" onclick="togglePhysicsTopicGroup(${idx})">
            <span>${topic} <span class="helper-text">(${totalCount} item${totalCount === 1 ? '' : 's'})</span></span>
            <span class="chevron">▸</span>
          </div>
          <div class="topic-group-body">
            <div class="term-tabs">
              ${[1, 2, 3].map(term => `<button class="term-tab ${term === 1 ? 'active' : ''}" onclick="showPhysicsTerm(${idx}, ${term}, this)">${PHYSICS_TERM_LABELS[term]}</button>`).join('')}
            </div>
            ${[1, 2, 3].map(term => `
              <div class="physics-term-panel" data-term="${term}" style="${term === 1 ? '' : 'display:none;'}">
                ${buckets[term].length ? buckets[term].map(physicsMaterialRow).join('') : `<p class="helper-text">No Term ${term} material published for this topic yet.</p>`}
              </div>`).join('')}
            ${buckets.untagged.length ? `<div class="mt-2"><strong style="font-size:0.85rem;">Additional resources</strong>${buckets.untagged.map(physicsMaterialRow).join('')}</div>` : ''}
          </div>
        </div>`;
    }).join('');
  } catch (err) {
    el.innerHTML = `<div class="empty-state"><p>${err.message}</p></div>`;
  }
}

window.togglePhysicsTopicGroup = (idx) => {
  document.getElementById(`physicsTopicGroup-${idx}`).classList.toggle('open');
};

window.showPhysicsTerm = (idx, term, btn) => {
  const group = document.getElementById(`physicsTopicGroup-${idx}`);
  group.querySelectorAll('.term-tab').forEach(t => t.classList.remove('active'));
  btn.classList.add('active');
  group.querySelectorAll('.physics-term-panel').forEach(p => {
    p.style.display = parseInt(p.getAttribute('data-term'), 10) === term ? '' : 'none';
  });
};

window.markPhysicsMaterialViewed = async (id, silent) => {
  try {
    await api(`/api/physics/materials/${id}/view`, { method: 'POST' });
    if (!silent) showToast('Marked as viewed.', '');
    renderPhysicsMaterials();
    renderPhysicsDashboard();
  } catch (err) {
    if (!silent) showToast(err.message, 'error');
  }
};

window.markPhysicsMaterialComplete = async (id) => {
  try {
    await api(`/api/physics/materials/${id}/complete`, { method: 'POST' });
    showToast('Marked as completed.', 'success');
    renderPhysicsMaterials();
    renderPhysicsDashboard();
  } catch (err) {
    showToast(err.message, 'error');
  }
};

function jumpToPhysicsTopic(topic) {
  if (!topic) return;
  document.querySelectorAll('.topic-group').forEach(g => g.classList.remove('open'));
  const group = document.querySelector(`.topic-group[data-topic="${topic}"]`);
  if (group) {
    group.classList.add('open');
    group.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

async function renderPhysicsLectures() {
  const el = document.getElementById('physicsLecturesList');
  if (!el) return;
  el.innerHTML = `<div class="loading-row"><div class="spinner"></div></div>`;
  try {
    const lectures = await api('/api/physics/lectures');
    el.innerHTML = lectures.length ? lectures.map(l => `
      <div class="video-card">
        <iframe src="${l.url}" allowfullscreen></iframe>
        <div class="info">
          <strong>${l.title}</strong>
          <div class="meta">${l.lecturer_name || ''}</div>
          <div class="progress-bar"><div class="progress-fill" style="width:${l.percent_watched}%"></div></div>
          <div class="flex-between mt-1">
            <span class="helper-text">${Math.round(l.percent_watched)}% watched${l.completed ? ' · ✓ Completed' : ''}</span>
          </div>
          <div class="flex-row mt-1">
            <input type="range" min="0" max="100" value="${Math.round(l.percent_watched)}" id="physicsLectureSlider-${l.id}" style="flex:1;">
            <button class="btn btn-outline" onclick="savePhysicsLectureProgress(${l.id})">Save</button>
          </div>
        </div>
      </div>`).join('') : `<div class="empty-state"><p>No approved Physics lectures yet — check back soon.</p></div>`;
  } catch (err) {
    el.innerHTML = `<div class="empty-state"><p>${err.message}</p></div>`;
  }
}

window.savePhysicsLectureProgress = async (lectureId) => {
  const slider = document.getElementById(`physicsLectureSlider-${lectureId}`);
  const percentWatched = parseInt(slider.value, 10);
  try {
    await api(`/api/physics/lectures/${lectureId}/progress`, {
      method: 'POST', body: JSON.stringify({ percentWatched, lastPositionSeconds: 0 })
    });
    showToast('Lecture progress saved.', 'success');
    renderPhysicsLectures();
    renderPhysicsDashboard();
  } catch (err) {
    showToast(err.message, 'error');
  }
};

async function renderPhysicsAnalytics() {
  const el = document.getElementById('physicsAnalyticsContent');
  if (!el) return;
  el.innerHTML = `<div class="loading-row"><div class="spinner"></div></div>`;
  try {
    const a = await api('/api/physics/analytics');
    if (!a.topicAccuracy.length) {
      el.innerHTML = `<div class="empty-state"><p>Take an entry-level test to unlock your topic-wise analytics.</p></div>`;
      return;
    }
    el.innerHTML = `
      ${a.topicAccuracy.map(t => `
        <div class="mt-1">
          <div class="flex-between"><span style="font-size:0.88rem;">${t.topic}</span><span class="badge">${t.accuracy}%</span></div>
          <div class="progress-bar"><div class="progress-fill" style="width:${t.accuracy}%"></div></div>
        </div>`).join('')}
      ${a.mistakeBreakdown.length ? `
        <hr class="divider">
        <strong style="font-size:0.9rem;">Mistake patterns</strong>
        ${a.mistakeBreakdown.map(m => `<div class="atlas-item"><div class="topic-row">${m.topic}</div><div class="remedy">${m.count} ${m.mistakeType} mistake(s)</div></div>`).join('')}
      ` : ''}`;
  } catch (err) {
    el.innerHTML = `<div class="empty-state"><p>${err.message}</p></div>`;
  }
}

async function renderPhysicsRecommendations() {
  const el = document.getElementById('physicsRecommendationsContent');
  if (!el) return;
  el.innerHTML = `<div class="loading-row"><div class="spinner"></div></div>`;
  try {
    const { recommendations } = await api('/api/physics/recommendations');
    el.innerHTML = recommendations.length ? recommendations.map(r => `
      <div class="rec-item">
        <div class="rec-msg">${r.message}</div>
        <ul>${r.actions.map(a => `<li>${a}</li>`).join('')}</ul>
      </div>`).join('') : `<div class="empty-state"><p>No weak topics flagged yet — nice work! Take an entry-level test to refresh this.</p></div>`;
  } catch (err) {
    el.innerHTML = `<div class="empty-state"><p>${err.message}</p></div>`;
  }
}

// ====================================================================
// NAVIGATION
// ====================================================================
const AUTH_REQUIRED_PAGES = {
  guidance: 'student', practice: 'student', progress: 'student', physics: 'student',
  onboarding: 'student', lecturer: 'faculty', facultyDashboard: 'faculty', admin: 'admin'
};

function showPage(pageId) {
  // Gate role-specific pages
  const requiredRole = AUTH_REQUIRED_PAGES[pageId];
  if (requiredRole) {
    if (!currentUser) {
      showToast('Please log in to continue.', 'error');
      pageId = 'login';
    } else if (currentUser.role !== requiredRole) {
      showToast(`This area is for ${requiredRole}s.`, 'error');
      pageId = 'welcome';
    }
  }

  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  const target = document.getElementById(pageId + 'Page');
  if (!target) { console.warn('Unknown page', pageId); return; }
  target.classList.add('active');
  document.querySelectorAll('.nav-btn').forEach(btn => btn.classList.remove('active'));
  const navBtn = document.querySelector(`.nav-btn[data-page="${pageId}"]`);
  if (navBtn) navBtn.classList.add('active');

  if (pageId === 'guidance') renderGuidance();
  if (pageId === 'practice') renderPractice();
  if (pageId === 'progress') renderProgress();
  if (pageId === 'physics') loadPhysicsModule();
  if (pageId === 'lecturer') {
    renderMySubmissions(); renderFacultyTests(); renderFacultyAnalytics(); renderFacultyMaterials();
    populateChapterSelects(); renderChapterList(); renderFacLectures();
    populateStudentAnalyticsSelect(); renderErrorAtlas(); renderGrandTestsList();
    loadFacultyExamDate();
  }
  if (pageId === 'onboarding') prefillOnboarding();
  if (pageId === 'admin') {
    renderAdmin();
  }
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// Toggle nav links based on auth state / role
function updateNavForAuth() {
  const loggedIn = !!currentUser;
  const role = currentUser?.role;

  document.getElementById('navLogin').style.display    = loggedIn ? 'none' : '';
  document.getElementById('navRegister').style.display = loggedIn ? 'none' : '';
  document.getElementById('navLogout').style.display   = loggedIn ? '' : 'none';

  document.getElementById('navOnboarding').style.display = (loggedIn && role === 'student' && !currentUser.onboardingDone) ? '' : 'none';
  document.getElementById('navGuidance').style.display    = (loggedIn && role === 'student') ? '' : 'none';
  document.getElementById('navPractice').style.display    = (loggedIn && role === 'student') ? '' : 'none';
  document.getElementById('navProgress').style.display    = (loggedIn && role === 'student') ? '' : 'none';
  document.getElementById('navPhysics').style.display     = (loggedIn && role === 'student') ? '' : 'none';
  document.getElementById('navBridge').style.display      = (loggedIn && role === 'student') ? '' : 'none';
  document.getElementById('navQBank').style.display       = (loggedIn && (role === 'faculty' || role === 'admin')) ? '' : 'none';
  document.getElementById('navLecturer').style.display    = (loggedIn && role === 'faculty') ? '' : 'none';
  // The Admin tab only ever appears for a verified admin-role session — it
  // is never shown to students or faculty, and admins reach it only via
  // the separate Admin Portal login (see footer), never the main Login page.
  document.getElementById('navAdmin').style.display       = (loggedIn && role === 'admin') ? '' : 'none';
  const footerAdminLink = document.getElementById('footerAdminLink');
  if (footerAdminLink) footerAdminLink.style.display = loggedIn ? 'none' : '';
}

window.showPage = showPage;

// ====================================================================
// INIT
// ====================================================================
window.onload = () => {
  // Auth
  document.getElementById('registerBtn').onclick = registerUser;
  document.getElementById('loginBtn').onclick = loginUser;
  document.getElementById('verifyOtpBtn').onclick = verifyOtp;
  document.getElementById('resendOtpBtn').onclick = resendOtp;
  document.getElementById('sendResetOtpBtn').onclick = sendResetOtp;
  document.getElementById('resetPasswordBtn').onclick = resetPassword;
  document.getElementById('onboardingBtn').onclick = submitOnboarding;
  document.getElementById('navLogout').onclick = logoutUser;

  document.getElementById('goToLoginLink').onclick = (e) => { e.preventDefault(); showPage('login'); };
  document.getElementById('goToRegisterLink').onclick = (e) => { e.preventDefault(); showPage('register'); };
  document.getElementById('goToForgotLink').onclick = (e) => { e.preventDefault(); showPage('forgotPassword'); };

  // Admin Portal — kept entirely separate from the student/faculty auth flow
  document.getElementById('footerAdminLink').onclick = (e) => { e.preventDefault(); showPage('adminLogin'); };
  document.getElementById('adminPortalLoginBtn').onclick = adminPortalLogin;
  document.getElementById('adminRegisterBtn').onclick = adminPortalRegister;
  document.getElementById('goToAdminRegisterLink').onclick = (e) => { e.preventDefault(); showPage('adminRegister'); };
  document.getElementById('goToAdminLoginLink').onclick = (e) => { e.preventDefault(); showPage('adminLogin'); };
  document.getElementById('setExamDateBtn').onclick = setExamDate;
  document.getElementById('resetAllDataBtn').onclick = resetAllData;
  document.getElementById('refreshCutoffCacheBtn').onclick = refreshCutoffCache;

  // Existing app features
  document.getElementById('submitLectureBtn').onclick = submitLecture;
  document.getElementById('refreshSubmissionsBtn').onclick = renderMySubmissions;
  document.getElementById('refreshFacultyTestsBtn').onclick = renderFacultyTests;
  document.getElementById('publishGrandTestBtn').onclick = publishGrandTest;
  document.getElementById('facSetExamDateBtn').onclick = setFacultyExamDate;
  document.getElementById('closeGrandTestEditorBtn').onclick = closeGrandTestEditor;
  document.getElementById('grandAddQuestionsBtn').onclick = addGrandQuestions;
  document.getElementById('publishGrandDraftBtn').onclick = publishGrandDraft;
  document.getElementById('refreshStudentTestsBtn').onclick = renderStudentTests;
  document.getElementById('uploadMaterialBtn').onclick = uploadMaterial;
  document.getElementById('refreshFacultyMaterialsBtn').onclick = renderFacultyMaterials;
  document.getElementById('refreshMaterialsBtn').onclick = renderMaterials;
  document.getElementById('materialsSubjectFilter').onchange = renderMaterials;
  document.getElementById('materialSubject').onchange = toggleMaterialTermField;
  document.getElementById('refreshPhysicsMaterialsBtn').onclick = renderPhysicsMaterials;
  document.getElementById('physicsTopicFilter').onchange = (e) => jumpToPhysicsTopic(e.target.value);

  // Faculty Module: chapters, faculty lecture links, individual student
  // analytics, Error Atlas.
  document.getElementById('chapterSubjectSelect').onchange = () => { populateChapterSelects(); renderChapterList(); };
  document.getElementById('createChapterBtn').onclick = createChapter;
  document.getElementById('cancelMaterialEditBtn').onclick = resetMaterialForm;
  document.getElementById('facLectureSaveBtn').onclick = saveFacLecture;
  document.getElementById('cancelFacLectureEditBtn').onclick = resetFacLectureForm;
  document.getElementById('loadStudentAnalyticsBtn').onclick = loadStudentAnalytics;
  document.getElementById('refreshErrorAtlasBtn').onclick = renderErrorAtlas;
  document.getElementById('startNowBtn').onclick = () => showPage(currentUser ? (currentUser.role === 'student' ? 'guidance' : 'lecturer') : 'register');

  document.querySelectorAll('.nav-btn').forEach(btn =>
    btn.addEventListener('click', () => {
      const page = btn.getAttribute('data-page');
      if (page) showPage(page);
    })
  );

  // Faculty sub-navigation — splits the Lecturer Hub into separate tracks
  // (Overview, Chapters, Tests, Materials, Student Analytics, Error Atlas,
  // Class Analytics) so faculty aren't scrolling through one giant page.
  document.querySelectorAll('.subnav-btn').forEach(btn =>
    btn.addEventListener('click', () => showFacultySection(btn.getAttribute('data-fsec')))
  );

  updateNavForAuth();

  if (currentUser?.role === 'student' && currentStudentEmail) {
    loadStudentData(currentStudentEmail).then(() => showPage('welcome'));
  } else {
    showPage('welcome');
  }
};

function showFacultySection(sectionId) {
  document.querySelectorAll('.faculty-section').forEach(sec => sec.classList.toggle('active', sec.id === sectionId));
  document.querySelectorAll('.subnav-btn').forEach(btn => btn.classList.toggle('active', btn.getAttribute('data-fsec') === sectionId));
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// ====================================================================
// BRIDGE COURSE TEST CENTRE
// ====================================================================

let bridgeActiveCourseType = 'NEET';
let bridgeActiveTestId = null;
let bridgeTestQuestions = [];
let bridgeTestAnswers = {};
let bridgeTimerInterval = null;
let bridgeTimeRemaining = 0;
let bridgeCurriculumData = null;

async function loadBridgeCurriculum() {
    if (bridgeCurriculumData) return bridgeCurriculumData;
    try {
        bridgeCurriculumData = await api('/api/bridge/curriculum');
        return bridgeCurriculumData;
    } catch (err) {
        return {};
    }
}

async function initBridgePage() {
    bridgeActiveCourseType = document.getElementById('bridgeCourseSelect').value || 'NEET';

    // Load entry tests. Entry Test 1 is mandatory: every other test in the
    // Test Centre stays locked until it's completed.
    let entryTest1Done = false;
    try {
        const entries = await api(`/api/bridge/entry-tests?courseType=${bridgeActiveCourseType}`);
        const container = document.getElementById('bridgeEntryTests');
        container.innerHTML = entries.map(et => `
            <div class="card" style="text-align:center;">
                <h4>${et.title} ${et.test_number === 1 ? '<span class="badge warn">Mandatory</span>' : ''}</h4>
                <p style="font-size:.85rem; color:var(--ink-soft);">90 Questions · 3 hours</p>
                ${et.submitted_at
                    ? `<p style="color:green; font-size:.85rem;">✅ Completed — Score: ${et.score}/${et.total}</p>`
                    : `<button class="btn btn-outline" onclick="startEntryTest('${bridgeActiveCourseType}', ${et.test_number})">Take Entry Test ${et.test_number}</button>`
                }
            </div>
        `).join('');
        const test1 = entries.find(e => e.test_number === 1);
        entryTest1Done = !test1 || !!test1.submitted_at;
    } catch (err) {
        document.getElementById('bridgeEntryTests').innerHTML = '<p style="color:var(--ink-soft);">Entry tests not available yet.</p>';
    }

    const lockNotice = '<p style="font-size:.85rem; color:var(--ink-soft);">🔒 Complete mandatory Entry Test 1 above to unlock this.</p>';

    // Daily
    const dailyBtn = document.getElementById('startDailyBtn');
    if (!entryTest1Done) {
        document.getElementById('bridgeDailyInfo').innerHTML = lockNotice;
        dailyBtn.disabled = true; dailyBtn.onclick = null;
    } else {
        dailyBtn.disabled = false;
        try {
            const daily = await api(`/api/bridge/tests/daily?courseType=${bridgeActiveCourseType}`);
            document.getElementById('bridgeDailyInfo').innerHTML = daily.alreadyAttempted
                ? `<p style="color:green; font-size:.9rem;">✅ Completed today</p>`
                : `<p style="font-size:.85rem; color:var(--ink-soft);">${daily.test.title}</p>`;
            dailyBtn.onclick = () => startGeneratedTest(daily.test.id, daily.test.title, daily.alreadyAttempted);
        } catch (err) { document.getElementById('bridgeDailyInfo').innerHTML = '<p style="font-size:.85rem;">Loading...</p>'; }
    }

    // Weekly
    const weeklyBtn = document.getElementById('startWeeklyBtn');
    if (!entryTest1Done) {
        document.getElementById('bridgeWeeklyInfo').innerHTML = lockNotice;
        weeklyBtn.disabled = true; weeklyBtn.onclick = null;
    } else {
        weeklyBtn.disabled = false;
        try {
            const weekly = await api(`/api/bridge/tests/weekly?courseType=${bridgeActiveCourseType}`);
            document.getElementById('bridgeWeeklyInfo').innerHTML = weekly.alreadyAttempted
                ? `<p style="color:green; font-size:.9rem;">✅ Completed this week</p>`
                : `<p style="font-size:.85rem; color:var(--ink-soft);">${weekly.test.title}</p>`;
            weeklyBtn.onclick = () => startGeneratedTest(weekly.test.id, weekly.test.title, weekly.alreadyAttempted);
        } catch (err) { document.getElementById('bridgeWeeklyInfo').innerHTML = '<p style="font-size:.85rem;">Loading...</p>'; }
    }

    // Monthly
    const monthlyBtn = document.getElementById('startMonthlyBtn');
    if (!entryTest1Done) {
        document.getElementById('bridgeMonthlyInfo').innerHTML = lockNotice;
        monthlyBtn.disabled = true; monthlyBtn.onclick = null;
    } else {
        monthlyBtn.disabled = false;
        try {
            const monthly = await api(`/api/bridge/tests/monthly?courseType=${bridgeActiveCourseType}`);
            document.getElementById('bridgeMonthlyInfo').innerHTML = monthly.alreadyAttempted
                ? `<p style="color:green; font-size:.9rem;">✅ Completed this month</p>`
                : `<p style="font-size:.85rem; color:var(--ink-soft);">${monthly.test.title}</p>`;
            monthlyBtn.onclick = () => startGeneratedTest(monthly.test.id, monthly.test.title, monthly.alreadyAttempted);
        } catch (err) { document.getElementById('bridgeMonthlyInfo').innerHTML = '<p style="font-size:.85rem;">Loading...</p>'; }
    }

    // Mock test button
    const mockBtn = document.getElementById('startMockBtn');
    const mockSelect = document.getElementById('mockDifficultySelect');
    if (!entryTest1Done) {
        mockBtn.disabled = true; mockBtn.onclick = null;
        mockSelect.disabled = true;
    } else {
        mockBtn.disabled = false; mockSelect.disabled = false;
        mockBtn.onclick = async () => {
            const diff = mockSelect.value;
            try {
                const res = await api('/api/bridge/tests/mock', {
                    method: 'POST',
                    body: JSON.stringify({ courseType: bridgeActiveCourseType, difficultyMode: diff })
                });
                startGeneratedTest(res.test.id, res.test.title, false);
            } catch (err) { showToast('Error generating mock test: ' + err.message, 'error'); }
        };
    }

    // Chapter combo setup
    const comboBtn = document.getElementById('startComboBtn');
    const comboSelect = document.getElementById('comboSubjectSelect');
    if (!entryTest1Done) {
        comboBtn.disabled = true;
        comboSelect.disabled = true;
        document.getElementById('comboChapterList').innerHTML = lockNotice;
    } else {
        comboBtn.disabled = false;
        comboSelect.disabled = false;
        await setupChapterComboUI();
    }

    // Grand test — published by faculty, students just take it.
    const grandBtn = document.getElementById('startGrandBtn');
    if (!entryTest1Done) {
        grandBtn.disabled = true; grandBtn.onclick = null;
        if (document.getElementById('bridgeGrandInfo'))
            document.getElementById('bridgeGrandInfo').innerHTML = lockNotice;
    } else {
        try {
            const grand = await api(`/api/bridge/tests/grand?courseType=${bridgeActiveCourseType}`);
            if (!grand.available) {
                grandBtn.disabled = true;
                grandBtn.style.display = 'none';
                if (document.getElementById('bridgeGrandInfo'))
                    document.getElementById('bridgeGrandInfo').innerHTML = '<p style="font-size:.9rem; color:var(--ink-soft);">No test available at the moment.</p>';
            } else {
                grandBtn.disabled = false;
                grandBtn.style.display = '';
                grandBtn.textContent = grand.alreadyAttempted ? 'Already completed' : 'Attempt Test';
                if (document.getElementById('bridgeGrandInfo'))
                    document.getElementById('bridgeGrandInfo').innerHTML = grand.alreadyAttempted
                        ? `<p style="color:green; font-size:.9rem;">✅ Completed — ${grand.test.title}</p>`
                        : `<p style="font-size:.85rem; color:var(--ink-soft);">${grand.test.title}</p>`;
                grandBtn.onclick = () => startGeneratedTest(grand.test.id, grand.test.title, grand.alreadyAttempted);
            }
        } catch (err) { showToast('Error loading grand test: ' + err.message, 'error'); }
    }

    // Test history
    await loadBridgeHistory();
}

async function setupChapterComboUI() {
    const curriculum = await loadBridgeCurriculum();
    const subjects = Object.keys(curriculum[bridgeActiveCourseType] || {});
    const subjectSelect = document.getElementById('comboSubjectSelect');
    subjectSelect.innerHTML = subjects.map(s => `<option value="${s}">${s}</option>`).join('');

    const updateChapters = () => {
        const subject = subjectSelect.value;
        const chapters = (curriculum[bridgeActiveCourseType] || {})[subject] || [];
        document.getElementById('comboChapterList').innerHTML = chapters.map(ch =>
            `<label style="display:block; font-size:.88rem; margin:.2rem 0;">
                <input type="checkbox" value="${ch}" class="combo-chapter-cb"> ${ch}
            </label>`
        ).join('');
    };

    subjectSelect.onchange = updateChapters;
    updateChapters();

    document.getElementById('startComboBtn').onclick = async () => {
        const selected = [...document.querySelectorAll('.combo-chapter-cb:checked')].map(cb => cb.value);
        if (selected.length === 0) return showToast('Select at least one chapter.', 'error');
        try {
            const res = await api('/api/bridge/tests/chapter-combo', {
                method: 'POST',
                body: JSON.stringify({ courseType: bridgeActiveCourseType, subject: subjectSelect.value, chapters: selected })
            });
            startGeneratedTest(res.test.id, res.test.title, false);
        } catch (err) { showToast('Error generating combo test: ' + err.message, 'error'); }
    };
}

async function startEntryTest(courseType, testNumber) {
    try {
        const data = await api(`/api/bridge/entry-tests/${courseType}/${testNumber}`);
        if (data.alreadyAttempted) return showToast('You have already taken this entry test.', 'error');
        openTestModal(data.testId, data.title, data.questions, data.timeLimitMin);
    } catch (err) {
        showToast(err.message, 'error');
    }
}

async function startGeneratedTest(testId, title, alreadyAttempted) {
    if (alreadyAttempted) return showToast('You have already attempted this test.', 'error');
    try {
        const data = await api(`/api/bridge/tests/${testId}/questions`);
        openTestModal(testId, data.test.title, data.questions, data.test.time_limit_min);
    } catch (err) {
        showToast(err.message, 'error');
    }
}

function openTestModal(testId, title, questions, timeLimitMin) {
    bridgeActiveTestId = testId;
    bridgeTestQuestions = questions;
    bridgeTestAnswers = {};
    bridgeTimeRemaining = (timeLimitMin || 180) * 60;

    document.getElementById('bridgeTestTitle').textContent = title;
    updateBridgeTestProgress();

    const container = document.getElementById('bridgeTestQuestionsContainer');
    container.innerHTML = questions.map((q, idx) => `
        <div class="test-question-card" id="tqcard_${q.id}">
            <div class="test-question-meta">
                <span>${q.subject}</span><span>${q.chapter_name}</span><span>${q.difficulty}</span>
            </div>
            <p class="test-question-text">Q${idx+1}. ${q.question_text}</p>
            <div class="test-options">
                ${['A','B','C','D'].map(opt => `
                    <label class="test-option-row" id="topt_${q.id}_${opt}">
                        <input type="radio" name="q_${q.id}" value="${opt}" onchange="bridgeSelectAnswer(${q.id}, '${opt}')">
                        <span class="opt-letter">${opt}.</span>
                        <span class="opt-text">${q['option_' + opt.toLowerCase()]}</span>
                    </label>
                `).join('')}
            </div>
        </div>
    `).join('');

    // Timer
    clearInterval(bridgeTimerInterval);
    bridgeTimerInterval = setInterval(() => {
        bridgeTimeRemaining--;
        const m = Math.floor(bridgeTimeRemaining / 60);
        const s = bridgeTimeRemaining % 60;
        document.getElementById('bridgeTestTimer').textContent =
            `⏱ ${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
        if (bridgeTimeRemaining <= 0) { clearInterval(bridgeTimerInterval); submitBridgeTest(); }
    }, 1000);

    document.getElementById('submitTestBtn').onclick = submitBridgeTest;
    document.getElementById('bridgeTestModal').style.display = '';
}

function updateBridgeTestProgress() {
    const total = bridgeTestQuestions.length;
    const answered = Object.keys(bridgeTestAnswers).length;
    const el = document.getElementById('bridgeTestProgress');
    if (el) el.textContent = `${answered} of ${total} answered`;
}

window.bridgeSelectAnswer = (qId, opt) => {
    bridgeTestAnswers[qId] = opt;
    const card = document.getElementById(`tqcard_${qId}`);
    if (card) {
        card.classList.add('answered');
        card.querySelectorAll('.test-option-row').forEach(row => row.classList.remove('selected'));
        const selectedRow = document.getElementById(`topt_${qId}_${opt}`);
        if (selectedRow) selectedRow.classList.add('selected');
    }
    updateBridgeTestProgress();
};

async function submitBridgeTest() {
    clearInterval(bridgeTimerInterval);
    if (!confirm('Submit this test? You cannot change your answers after submission.')) return;
    document.getElementById('bridgeTestModal').style.display = 'none';

    try {
        const result = await api(`/api/bridge/tests/${bridgeActiveTestId}/submit`, {
            method: 'POST',
            body: JSON.stringify({ answers: bridgeTestAnswers })
        });
        showBridgeResult(result);
    } catch (err) {
        showToast('Submission error: ' + err.message, 'error');
    }
}

function showBridgeResult(r) {
    document.getElementById('bridgeResultContent').innerHTML = `
        <div style="display:grid; grid-template-columns:1fr 1fr; gap:1rem; text-align:left;">
            <div class="card" style="text-align:center;"><div style="font-size:2rem; font-weight:700; color:var(--accent);">${r.score}/${r.total}</div><div>Raw Score</div></div>
            <div class="card" style="text-align:center;"><div style="font-size:2rem; font-weight:700; color:var(--accent);">${r.percentage}%</div><div>Percentage</div></div>
            <div class="card" style="text-align:center;"><div style="font-size:1.8rem; font-weight:700; color:green;">${r.correct}</div><div>Correct</div></div>
            <div class="card" style="text-align:center;"><div style="font-size:1.8rem; font-weight:700; color:red;">${r.wrong}</div><div>Wrong</div></div>
            <div class="card" style="text-align:center;"><div style="font-size:1.5rem; font-weight:700;">${r.skipped}</div><div>Skipped</div></div>
            <div class="card" style="text-align:center;"><div style="font-size:1.5rem; font-weight:700; color:var(--accent);">${r.neetEquivScore}/720</div><div>Equiv. Score</div></div>
        </div>
        <p style="margin-top:1rem; text-align:center; font-size:.9rem; color:var(--ink-soft);">Estimated Percentile: <strong>${r.percentileEst}%</strong></p>
    `;
    document.getElementById('closeResultBtn').onclick = () => {
        document.getElementById('bridgeResultModal').style.display = 'none';
        initBridgePage(); // refresh history
    };
    document.getElementById('bridgeResultModal').style.display = '';
}

async function loadBridgeHistory() {
    try {
        const history = await api(`/api/bridge/tests/history?courseType=${bridgeActiveCourseType}`);
        const container = document.getElementById('bridgeTestHistory');
        if (!history.length) { container.innerHTML = '<p style="color:var(--ink-soft);">No tests attempted yet.</p>'; return; }
        container.innerHTML = `
            <table style="width:100%; border-collapse:collapse; font-size:.9rem;">
                <thead>
                    <tr style="text-align:left; border-bottom:2px solid var(--border);">
                        <th style="padding:.5rem;">Test</th>
                        <th>Type</th>
                        <th>Score</th>
                        <th>%</th>
                        <th>Correct</th>
                        <th>Wrong</th>
                        <th>Date</th>
                    </tr>
                </thead>
                <tbody>
                    ${history.map(h => `
                        <tr style="border-bottom:1px solid var(--border);">
                            <td style="padding:.4rem;">${h.title}</td>
                            <td><span style="font-size:.8rem; padding:.2rem .5rem; border-radius:.25rem; background:var(--pastel);">${h.test_type}</span></td>
                            <td>${h.score}/${h.total}</td>
                            <td>${Math.round(h.score/h.total*100)}%</td>
                            <td style="color:green;">${h.correct_count}</td>
                            <td style="color:red;">${h.wrong_count}</td>
                            <td style="font-size:.8rem; color:var(--ink-soft);">${new Date(h.submitted_at).toLocaleDateString()}</td>
                        </tr>
                    `).join('')}
                </tbody>
            </table>
        `;
    } catch (err) {
        document.getElementById('bridgeTestHistory').innerHTML = '<p style="color:var(--ink-soft);">Could not load history.</p>';
    }
}

document.addEventListener('DOMContentLoaded', () => {
    const courseSelect = document.getElementById('bridgeCourseSelect');
    if (courseSelect) {
        courseSelect.onchange = () => {
            bridgeActiveCourseType = courseSelect.value;
            initBridgePage();
        };
    }
});

// ====================================================================
// QUESTION BANK (Faculty/Admin)
// ====================================================================

async function initQBankPage() {
    const role = currentUser?.role;
    document.getElementById('qbankSubmitSection').style.display = (role === 'faculty') ? '' : 'none';
    document.getElementById('qbankChapterSection').style.display = (role === 'faculty') ? '' : 'none';
    document.getElementById('qbankApprovalSection').style.display = (role === 'faculty' || role === 'admin') ? '' : 'none';

    // Load curriculum for dropdowns
    const curriculum = await loadBridgeCurriculum();

    if (role === 'faculty') initChapterManagement(curriculum);

    const courseSelect = document.getElementById('qbSubmitCourse');
    const subjectSelect = document.getElementById('qbSubmitSubject');
    const chapterSelect = document.getElementById('qbSubmitChapter');

    const updateSubjects = () => {
        const ct = courseSelect.value;
        const subjects = Object.keys(curriculum[ct] || {});
        subjectSelect.innerHTML = subjects.map(s => `<option>${s}</option>`).join('');
        updateChapters();
    };
    const updateChapters = () => {
        const ct = courseSelect.value;
        const subject = subjectSelect.value;
        const chapters = (curriculum[ct] || {})[subject] || [];
        chapterSelect.innerHTML = chapters.map(ch => `<option>${ch}</option>`).join('');
    };

    courseSelect.onchange = updateSubjects;
    subjectSelect.onchange = updateChapters;
    updateSubjects();

    // Submit handler
    document.getElementById('qbSubmitBtn').onclick = async () => {
        const payload = {
            courseType: courseSelect.value,
            subject: subjectSelect.value,
            chapterName: chapterSelect.value,
            difficulty: document.getElementById('qbSubmitDifficulty').value,
            questionText: document.getElementById('qbSubmitText').value.trim(),
            optionA: document.getElementById('qbOptA').value.trim(),
            optionB: document.getElementById('qbOptB').value.trim(),
            optionC: document.getElementById('qbOptC').value.trim(),
            optionD: document.getElementById('qbOptD').value.trim(),
            correctAnswer: document.getElementById('qbCorrect').value,
            explanation: document.getElementById('qbExplanation').value.trim()
        };
        if (!payload.questionText || !payload.optionA || !payload.optionB || !payload.optionC || !payload.optionD)
            return showToast('Please fill all question fields.', 'error');
        try {
            await api('/api/qbank/questions', { method: 'POST', body: JSON.stringify(payload) });
            showToast('Question submitted for approval!', 'success');
            document.getElementById('qbSubmitText').value = '';
            ['qbOptA','qbOptB','qbOptC','qbOptD','qbExplanation'].forEach(id => document.getElementById(id).value = '');
        } catch (err) { showToast('Error: ' + err.message, 'error'); }
    };

    // Load approval queue
    if (role === 'faculty' || role === 'admin') {
        await loadApprovalQueue();
        document.getElementById('qbRefreshQueueBtn').onclick = loadApprovalQueue;
    }

    // Load stats
    await loadQBankStats();

    // Search button
    document.getElementById('qbSearchBtn').onclick = searchQBank;
    await searchQBank();
}

// ====================================================================
// CENTRALIZED CHAPTER MANAGEMENT (Question Bank — course aware)
// ====================================================================

async function refreshBridgeCurriculum() {
    bridgeCurriculumData = null;
    return loadBridgeCurriculum();
}

function initChapterManagement(curriculum) {
    const courseSelect = document.getElementById('qbChapterCourse');
    const subjectSelect = document.getElementById('qbChapterSubject');

    const updateSubjects = () => {
        const subjects = Object.keys(curriculum[courseSelect.value] || {});
        subjectSelect.innerHTML = subjects.map(s => `<option>${s}</option>`).join('');
        renderQbChapterList();
    };

    courseSelect.onchange = updateSubjects;
    subjectSelect.onchange = renderQbChapterList;
    updateSubjects();

    document.getElementById('addQbChapterBtn').onclick = async () => {
        const name = document.getElementById('newQbChapterName').value.trim();
        const description = document.getElementById('newQbChapterDesc').value.trim();
        const msgEl = document.getElementById('qbChapterMessage');
        if (!name) { msgEl.innerHTML = `<span class="badge danger">Please enter a chapter name.</span>`; return; }
        try {
            await api('/api/qbank/chapters', {
                method: 'POST',
                body: JSON.stringify({ courseType: courseSelect.value, subject: subjectSelect.value, name, description })
            });
            document.getElementById('newQbChapterName').value = '';
            document.getElementById('newQbChapterDesc').value = '';
            msgEl.innerHTML = `<span class="badge success">✅ Chapter added.</span>`;
            showToast('Chapter added.', 'success');
            const fresh = await refreshBridgeCurriculum();
            initChapterManagement(fresh);
        } catch (err) {
            msgEl.innerHTML = `<span class="badge danger">${err.message}</span>`;
            showToast(err.message, 'error');
        }
    };
}

async function renderQbChapterList() {
    const container = document.getElementById('qbChapterList');
    const courseType = document.getElementById('qbChapterCourse').value;
    const subject = document.getElementById('qbChapterSubject').value;
    if (!container || !subject) return;
    container.innerHTML = `<div class="loading-row"><div class="spinner"></div></div>`;
    try {
        const chapters = await api(`/api/qbank/chapters?courseType=${courseType}&subject=${encodeURIComponent(subject)}`);
        container.innerHTML = chapters.length ? chapters.map(c => `
            <div class="flex-between" style="padding:0.55rem 0; border-bottom:1px solid var(--border);">
                <div>
                    <strong>${c.name}</strong>
                    ${c.description ? `<div class="helper-text">${c.description}</div>` : ''}
                </div>
                <div class="flex-row">
                    <button class="btn btn-outline" onclick="renameQbChapter(${c.id}, '${c.name.replace(/'/g, "\\'")}')">Rename</button>
                    <button class="btn btn-outline" onclick="removeQbChapter(${c.id})">Delete</button>
                </div>
            </div>`).join('') : `<div class="empty-state"><p>No chapters yet for ${courseType} · ${subject} — add one above.</p></div>`;
    } catch (err) {
        container.innerHTML = `<div class="empty-state"><p>${err.message}</p></div>`;
    }
}

window.renameQbChapter = async (id, currentName) => {
    const name = prompt('Rename chapter:', currentName);
    if (!name || name.trim() === currentName) return;
    try {
        await api(`/api/qbank/chapters/${id}`, { method: 'PUT', body: JSON.stringify({ name: name.trim() }) });
        showToast('Chapter renamed.', 'success');
        await refreshBridgeCurriculum();
        renderQbChapterList();
    } catch (err) {
        showToast(err.message, 'error');
    }
};

window.removeQbChapter = async (id) => {
    if (!confirm(`Delete this chapter? Its questions stay in the bank, just unlinked from this chapter entry.`)) return;
    try {
        await api(`/api/qbank/chapters/${id}`, { method: 'DELETE' });
        showToast('Chapter deleted.', '');
        await refreshBridgeCurriculum();
        renderQbChapterList();
    } catch (err) {
        showToast(err.message, 'error');
    }
};

async function loadApprovalQueue() {
    try {
        const questions = await api('/api/bridge/faculty/pending-questions');
        const container = document.getElementById('qbApprovalQueue');
        if (!questions.length) { container.innerHTML = '<p style="color:var(--ink-soft); font-size:.9rem;">No pending questions. ✅</p>'; return; }
        container.innerHTML = questions.map(q => `
            <div style="border:1px solid var(--border); border-radius:.5rem; padding:1rem; margin-bottom:.75rem;">
                <div style="font-size:.8rem; color:var(--ink-soft); margin-bottom:.5rem;">
                    ${q.course_type} · ${q.subject} · ${q.chapter_name} · ${q.difficulty}
                    ${q.submitted_by_name ? ` · by ${q.submitted_by_name}` : ''}
                </div>
                <p style="margin-bottom:.5rem;">${q.question_text}</p>
                <div style="font-size:.88rem;">
                    <strong>A.</strong> ${q.option_a} &nbsp;
                    <strong>B.</strong> ${q.option_b} &nbsp;
                    <strong>C.</strong> ${q.option_c} &nbsp;
                    <strong>D.</strong> ${q.option_d}
                    <br><strong style="color:green;">Answer: ${q.correct_answer}</strong>
                </div>
                <div style="margin-top:.75rem; display:flex; gap:.5rem;">
                    <button class="btn btn-outline" style="background:green; color:white;" onclick="approveQuestion(${q.id}, 'approve')">✅ Approve</button>
                    <button class="btn btn-outline" style="background:red; color:white;" onclick="approveQuestion(${q.id}, 'reject')">❌ Reject</button>
                </div>
            </div>
        `).join('');
    } catch (err) {
        document.getElementById('qbApprovalQueue').innerHTML = '<p style="color:red; font-size:.9rem;">Could not load queue.</p>';
    }
}

window.approveQuestion = async (id, action) => {
    try {
        await api(`/api/qbank/questions/${id}/approve`, {
            method: 'POST',
            body: JSON.stringify({ action })
        });
        showToast(`Question ${action}d!`, 'success');
        await loadApprovalQueue();
        await loadQBankStats();
    } catch (err) { showToast('Error: ' + err.message, 'error'); }
};

async function loadQBankStats() {
    try {
        const stats = await api('/api/qbank/stats');
        document.getElementById('qbankStats').innerHTML = `
            <div class="grid-3" style="margin-top:1rem;">
                <div class="card" style="text-align:center;">
                    <div style="font-size:2rem; font-weight:700; color:green;">${stats.counts.approved}</div>
                    <div>Approved</div>
                </div>
                <div class="card" style="text-align:center;">
                    <div style="font-size:2rem; font-weight:700; color:orange;">${stats.counts.pending}</div>
                    <div>Pending</div>
                </div>
                <div class="card" style="text-align:center;">
                    <div style="font-size:2rem; font-weight:700; color:red;">${stats.counts.rejected}</div>
                    <div>Rejected</div>
                </div>
            </div>
            <div style="margin-top:1rem;">
                <h4>By Course & Subject</h4>
                <table style="width:100%; border-collapse:collapse; font-size:.88rem; margin-top:.5rem;">
                    <thead>
                        <tr style="text-align:left; border-bottom:2px solid var(--border);">
                            <th style="padding:.4rem;">Course</th><th>Subject</th><th>Count</th><th>Avg Usage</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${(stats.byCourse || []).map(r => `
                            <tr style="border-bottom:1px solid var(--border);">
                                <td style="padding:.3rem;">${r.course_type}</td>
                                <td>${r.subject}</td>
                                <td>${r.count}</td>
                                <td>${parseFloat(r.avg_usage||0).toFixed(1)}</td>
                            </tr>
                        `).join('')}
                    </tbody>
                </table>
            </div>
        `;
    } catch (err) { }
}

async function searchQBank() {
    const params = new URLSearchParams({
        courseType: document.getElementById('qbFilterCourse').value,
        subject:    document.getElementById('qbFilterSubject').value,
        difficulty: document.getElementById('qbFilterDiff').value,
        status:     document.getElementById('qbFilterStatus').value,
        limit: '20'
    });
    try {
        const data = await api(`/api/qbank/questions?${params}`);
        const container = document.getElementById('qbankBrowserResult');
        if (!data.questions.length) { container.innerHTML = '<p style="color:var(--ink-soft);">No questions found.</p>'; return; }
        const role = currentUser?.role;
        const email = currentUser?.email;
        container.innerHTML = `
            <p style="font-size:.85rem; color:var(--ink-soft);">Showing ${data.questions.length} of ${data.total} questions</p>
            ${data.questions.map(q => {
                const isOwner = q.submitted_by === email;
                const canEdit = role === 'faculty' && isOwner && q.status !== 'approved';
                const canDelete = role === 'admin' || (role === 'faculty' && isOwner && q.status !== 'approved');
                return `
                <div style="border:1px solid var(--border); border-radius:.5rem; padding:.75rem; margin-bottom:.5rem;">
                    <div style="font-size:.78rem; color:var(--ink-soft);">
                        ${q.course_type} · ${q.subject} · ${q.chapter_name} ·
                        <span style="color:${q.difficulty==='Easy'?'green':q.difficulty==='Moderate'?'orange':'red'}">${q.difficulty}</span> ·
                        <span style="color:${q.status==='approved'?'green':q.status==='pending'?'orange':'red'}">${q.status}</span>
                        · Used ${q.usage_count}×
                    </div>
                    <p style="margin:.4rem 0; font-size:.92rem;">${q.question_text}</p>
                    <div style="font-size:.85rem; color:var(--ink-soft);">
                        A. ${q.option_a} &nbsp; B. ${q.option_b} &nbsp; C. ${q.option_c} &nbsp; D. ${q.option_d}
                        &nbsp;→ <strong style="color:green;">${q.correct_answer}</strong>
                    </div>
                    ${(canEdit || canDelete) ? `
                    <div style="margin-top:.6rem; display:flex; gap:.5rem;">
                        ${canEdit ? `<button class="btn btn-outline" onclick="editQbQuestion(${q.id})">Edit</button>` : ''}
                        ${canDelete ? `<button class="btn btn-outline" onclick="deleteQbQuestion(${q.id})">Delete</button>` : ''}
                    </div>` : ''}
                </div>`;
            }).join('')}
        `;
    } catch (err) {
        document.getElementById('qbankBrowserResult').innerHTML = '<p style="color:red;">Error loading questions.</p>';
    }
}

window.editQbQuestion = async (id) => {
    try {
        const q = await api(`/api/qbank/questions/${id}`);
        const questionText = prompt('Edit question text:', q.question_text);
        if (questionText === null) return;
        const optionA = prompt('Option A:', q.option_a); if (optionA === null) return;
        const optionB = prompt('Option B:', q.option_b); if (optionB === null) return;
        const optionC = prompt('Option C:', q.option_c); if (optionC === null) return;
        const optionD = prompt('Option D:', q.option_d); if (optionD === null) return;
        const correctAnswer = (prompt('Correct answer (A/B/C/D):', q.correct_answer) || q.correct_answer).toUpperCase();
        await api(`/api/qbank/questions/${id}`, {
            method: 'PUT',
            body: JSON.stringify({ questionText, optionA, optionB, optionC, optionD, correctAnswer })
        });
        showToast('Question updated — sent back for approval.', 'success');
        searchQBank();
    } catch (err) {
        showToast(err.message, 'error');
    }
};

window.deleteQbQuestion = async (id) => {
    if (!confirm('Delete this question permanently?')) return;
    try {
        await api(`/api/qbank/questions/${id}`, { method: 'DELETE' });
        showToast('Question deleted.', '');
        searchQBank();
        loadQBankStats();
    } catch (err) {
        showToast(err.message, 'error');
    }
};

// Hook into showPage
const _origShowPage = window.showPage;
window.showPage = function(page) {
    if (_origShowPage) _origShowPage(page);
    if (page === 'bridge') {
        initBridgePage().catch(err => console.error('Bridge page error:', err));
    }
    if (page === 'qbank') {
        initQBankPage().catch(err => console.error('QBank page error:', err));
    }
};
