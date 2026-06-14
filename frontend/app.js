// app.js - NEET CTK IGNITION frontend logic
// Talks to the Express + PostgreSQL backend defined in /backend.

const API_BASE = window.location.origin;
const ADMIN_PASSCODE = 'ctk-admin'; // legacy demo gate for the old Admin tab UI

// ---------------------------------------------------------------- auth state
let authToken = localStorage.getItem('neet_ctk_token') || null;
let currentUser = JSON.parse(localStorage.getItem('neet_ctk_user') || 'null'); // { id, name, email, role, onboardingDone }

// Legacy fields kept for backward compatibility with existing student-data code
let currentStudentEmail = currentUser?.role === 'student' ? currentUser.email : (localStorage.getItem('neet_ctk_email') || null);
let globalStudentData = null;
let cachedQuestions = null;
let pendingVerifyEmail = null; // email awaiting OTP verification

function setSession(token, user) {
  authToken = token;
  currentUser = user;
  localStorage.setItem('neet_ctk_token', token);
  localStorage.setItem('neet_ctk_user', JSON.stringify(user));
  if (user.role === 'student') {
    currentStudentEmail = user.email;
    localStorage.setItem('neet_ctk_email', user.email);
  }
}

function clearSession() {
  authToken = null;
  currentUser = null;
  currentStudentEmail = null;
  localStorage.removeItem('neet_ctk_token');
  localStorage.removeItem('neet_ctk_user');
  localStorage.removeItem('neet_ctk_email');
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
  const adminCode = document.getElementById('authAdminCode').value;
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
    if (role === 'admin') body.adminCode = adminCode;
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
      setTimeout(() => showPage('admin'), 400);
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
    examDate: document.getElementById('obExamDate').value,
    dailyStudyHours: document.getElementById('obDailyHours').value ? parseFloat(document.getElementById('obDailyHours').value) : null,
    prepLevel: document.getElementById('obPrepLevel').value
  };

  btn.disabled = true; btn.textContent = 'Building your plan...';
  try {
    const data = await api('/api/onboarding/student', { method: 'POST', body: JSON.stringify(payload) });
    globalStudentData = data;
    currentUser.onboardingDone = true;
    localStorage.setItem('neet_ctk_user', JSON.stringify(currentUser));
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
  const data = await loadStudentData(currentUser.email);
  if (!data || !data.student) return;
  const s = data.student;
  if (s.target_exam) document.getElementById('obTargetExam').value = s.target_exam;
  if (s.target_institution || s.aim) document.getElementById('obTargetInstitution').value = s.target_institution || s.aim;
  if (s.category) document.getElementById('obCategory').value = s.category;
  if (s.state) document.getElementById('obState').value = s.state;
  if (s.current_class) document.getElementById('obCurrentClass').value = s.current_class;
  if (s.exam_date) document.getElementById('obExamDate').value = s.exam_date.split('T')[0];
  if (s.daily_study_hours) document.getElementById('obDailyHours').value = s.daily_study_hours;
  if (s.prep_level) document.getElementById('obPrepLevel').value = s.prep_level;
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

        ${cutoff ? `
        <hr class="divider">
        <h3>🎯 AI cutoff &amp; rank prediction (${cutoff.targetYear})</h3>
        <div class="grid-3 mt-1">
          <div class="card" style="background:var(--hill-1); border:none;">
            <div class="helper-text">Safe Score</div>
            <p style="font-weight:700; font-size:1.4rem; margin:0;">${cutoff.safeScore}/720</p>
          </div>
          <div class="card" style="background:var(--hill-3); border:none;">
            <div class="helper-text">Target Score</div>
            <p style="font-weight:700; font-size:1.4rem; margin:0;">${cutoff.targetScore}/720</p>
          </div>
          <div class="card" style="background:var(--hill-5); border:none;">
            <div class="helper-text">Stretch Goal</div>
            <p style="font-weight:700; font-size:1.4rem; margin:0;">${cutoff.stretchScore}/720</p>
          </div>
        </div>
        <p class="helper-text mt-1">Estimated rank range: <strong>#${cutoff.estimatedRank.low.toLocaleString('en-IN')} – #${cutoff.estimatedRank.high.toLocaleString('en-IN')}</strong>
          ${cutoff.admissionProbability !== null ? ` · Admission probability at current pace: <strong>${cutoff.admissionProbability}%</strong>` : ''}
        </p>
        <p class="helper-text">Based on ${cutoff.modelInfo.trainingPoints}-year historical cutoff trends for ${cutoff.category} category${student.state ? ` in ${student.state}` : ''}, regressed forward to ${cutoff.targetYear}.</p>
        ` : ''}

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

  const quizContainer = document.getElementById('quizContainer');
  quizContainer.innerHTML = `<div class="loading-row"><div class="spinner"></div></div>`;
  try {
    const questions = await api('/api/questions');
    cachedQuestions = questions;
    document.getElementById('quizCountBadge').textContent = `${questions.length} questions`;
    quizContainer.innerHTML = questions.map((q, idx) => `
      <div class="quiz-item">
        <div class="q-meta">${q.subject} · ${q.topic}</div>
        <div class="q-text">${idx + 1}. ${q.text}</div>
        <div>
          ${q.options.map((opt, oi) => `
            <label class="quiz-option">
              <input type="radio" name="q${idx}" value="${oi}"> ${opt}
            </label>`).join('')}
        </div>
      </div>`).join('');
  } catch (err) {
    quizContainer.innerHTML = `<div class="empty-state"><p>${err.message}</p></div>`;
  }

  if (currentUser?.role === 'student') {
    renderStudentTests();
  }
}

async function submitQuiz() {
  if (!currentStudentEmail) {
    showToast('Please register before attempting a quiz.', 'error');
    showPage('register');
    return;
  }
  const btn = document.getElementById('submitQuizBtn');
  const questions = cachedQuestions || await api('/api/questions');
  const answers = questions.map((_, idx) => {
    const selected = document.querySelector(`input[name="q${idx}"]:checked`);
    return selected ? parseInt(selected.value, 10) : -1;
  });

  if (answers.every(a => a === -1)) {
    showToast('Please answer at least one question before submitting.', 'error');
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Submitting...';
  try {
    const result = await api('/api/submit-quiz', {
      method: 'POST',
      body: JSON.stringify({ email: currentStudentEmail, answers })
    });
    showToast(`Quiz submitted — ${result.score}/${result.total} correct (${result.accuracy}%). Progress updated!`, 'success');
    await renderGuidance();
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Submit quiz';
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
    const avgAcc = (progress.bio_accuracy + progress.phy_accuracy + progress.chem_accuracy) / 3;
    const targetAvg = (targets.bio + targets.phy + targets.chem) / 3;
    const overallPercent = Math.min(100, Math.round((avgAcc / targetAvg) * 100));

    let rank = Math.floor(15000 - (avgAcc - 40) * 150);
    rank = Math.max(1000, Math.min(150000, rank));

    const advancedUnlocked = progress.bio_accuracy >= 80 && progress.phy_accuracy >= 60 && progress.chem_accuracy >= 70;

    const atlasData = await api(`/api/error-atlas/${encodeURIComponent(currentStudentEmail)}`);
    const mistakeData = await api('/api/student/mistake-analysis').catch(() => null);

    container.innerHTML = `
      <div class="card">
        <h2>Your progress analytics</h2>
        <div class="grid-2 mt-1">
          <div><canvas id="accuracyChart" height="220"></canvas></div>
          <div><canvas id="weeklyTrendChart" height="220"></canvas></div>
        </div>
        <hr class="divider">
        <div class="flex-between">
          <span>📊 Current — Bio ${progress.bio_accuracy}% · Phy ${progress.phy_accuracy}% · Chem ${progress.chem_accuracy}%</span>
          <span>🎯 Target — Bio ${targets.bio}% · Phy ${targets.phy}% · Chem ${targets.chem}%</span>
        </div>
        <div class="progress-bar"><div class="progress-fill" style="width:${overallPercent}%"></div></div>
        <div class="flex-between mt-1">
          <span>📅 Probable rank estimate: <strong>#${rank.toLocaleString('en-IN')}</strong></span>
          <span>⭐ Advanced mode: <span class="badge ${advancedUnlocked ? 'success' : 'warn'}">${advancedUnlocked ? 'Unlocked' : 'Locked'}</span></span>
        </div>
        <p class="helper-text mt-1">${advancedUnlocked ? 'Great work — you have met the subject thresholds (Bio ≥ 80%, Phy ≥ 60%, Chem ≥ 70%) for Advanced Mode.' : 'Advanced Mode unlocks once Biology ≥ 80%, Physics ≥ 60% and Chemistry ≥ 70%.'}</p>
        <button id="refreshProgressBtn" class="btn btn-outline mt-2">Refresh data</button>
      </div>

      <div class="card">
        <h3>⚠️ Error Atlas &amp; Remedial Ladder</h3>
        ${renderAtlas(atlasData.atlas)}
      </div>

      ${mistakeData ? `
      <div class="card">
        <h3>🔍 Mistake Analysis — from your test attempts</h3>
        ${renderMistakeAnalysis(mistakeData)}
      </div>` : ''}`;

    document.getElementById('refreshProgressBtn').onclick = renderProgress;

    let history = [];
    try { history = JSON.parse(progress.weekly_history); } catch (e) { history = []; }
    const weeks = history.length ? history.map((_, i) => i === history.length - 1 ? 'This week' : `W-${history.length - 1 - i}`) : [];

    new Chart(document.getElementById('accuracyChart').getContext('2d'), {
      type: 'bar',
      data: {
        labels: ['Biology', 'Physics', 'Chemistry'],
        datasets: [
          { label: 'Your %', data: [progress.bio_accuracy, progress.phy_accuracy, progress.chem_accuracy], backgroundColor: '#CFE3E6', borderRadius: 8 },
          { label: 'Target %', data: [targets.bio, targets.phy, targets.chem], backgroundColor: '#D98E5B', borderRadius: 8 }
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

  } catch (err) {
    container.innerHTML = `<div class="empty-state"><p>${err.message}</p></div>`;
  }
}

function renderAtlas(atlas) {
  if (!atlas || atlas.length === 0) {
    return `<div class="empty-state"><span class="icon">🎉</span><p>You're meeting or exceeding all your subject targets. Keep up the rhythm!</p></div>`;
  }
  return atlas.map(subj => `
    <div class="atlas-item">
      <div class="topic-row">${subj.subject} — ${subj.gap}% below target</div>
      ${subj.topics.map(t => `
        <div style="margin: 0.4rem 0 0.4rem 0.5rem;">
          <div style="font-weight:600; font-size:0.92rem;">• ${t.topic}</div>
          <div class="remedy">${t.remedy}</div>
        </div>`).join('')}
    </div>`).join('');
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
// TEST MANAGEMENT — FACULTY (create/schedule tests)
// ====================================================================
let testQuestionCount = 0;

function addTestQuestionRow() {
  const idx = testQuestionCount++;
  const container = document.getElementById('testQuestionsContainer');
  const row = document.createElement('div');
  row.className = 'card';
  row.style = 'background:var(--cream-deep); border:none; margin-bottom:0.75rem;';
  row.id = `tq-${idx}`;
  row.innerHTML = `
    <div class="flex-between">
      <strong>Question ${idx + 1}</strong>
      <button class="btn btn-outline" onclick="document.getElementById('tq-${idx}').remove()">Remove</button>
    </div>
    <div class="grid-2 mt-1">
      <div class="field-group">
        <label class="field-label">Type</label>
        <select class="tq-type" onchange="toggleTqOptions(${idx})">
          <option value="mcq">MCQ</option>
          <option value="fill_blank">Fill in the blank</option>
        </select>
      </div>
      <div class="field-group">
        <label class="field-label">Topic</label>
        <input type="text" class="tq-topic" placeholder="e.g. Rotational Mechanics">
      </div>
      <div class="field-group" style="grid-column:1/-1;">
        <label class="field-label">Question text</label>
        <textarea class="tq-text" rows="2" placeholder="Enter the question..."></textarea>
      </div>
    </div>
    <div class="tq-mcq-options">
      <div class="field-group"><label class="field-label">Option 1</label><input type="text" class="tq-opt"></div>
      <div class="field-group"><label class="field-label">Option 2</label><input type="text" class="tq-opt"></div>
      <div class="field-group"><label class="field-label">Option 3</label><input type="text" class="tq-opt"></div>
      <div class="field-group"><label class="field-label">Option 4</label><input type="text" class="tq-opt"></div>
      <div class="field-group">
        <label class="field-label">Correct option (1-4)</label>
        <input type="number" class="tq-correct-mcq" min="1" max="4" value="1">
      </div>
    </div>
    <div class="tq-fill-answer" style="display:none;">
      <div class="field-group"><label class="field-label">Correct answer (exact text)</label><input type="text" class="tq-correct-fill"></div>
    </div>`;
  container.appendChild(row);
}
window.addTestQuestionRow = addTestQuestionRow;

window.toggleTqOptions = (idx) => {
  const row = document.getElementById(`tq-${idx}`);
  const type = row.querySelector('.tq-type').value;
  row.querySelector('.tq-mcq-options').style.display = type === 'mcq' ? '' : 'none';
  row.querySelector('.tq-fill-answer').style.display = type === 'fill_blank' ? '' : 'none';
};

async function createTest() {
  const btn = document.getElementById('createTestBtn');
  const msgEl = document.getElementById('createTestMessage');
  const title = document.getElementById('testTitle').value.trim();
  const subject = document.getElementById('testSubject').value;
  const chapter = document.getElementById('testChapter').value.trim();
  const difficulty = document.getElementById('testDifficulty').value;
  const timeLimitMin = parseInt(document.getElementById('testTimeLimit').value, 10) || 30;
  const scheduledAtRaw = document.getElementById('testScheduledAt').value;
  const negativeMarking = document.getElementById('testNegativeMarking').checked;
  const randomize = document.getElementById('testRandomize').checked;

  const rows = document.querySelectorAll('#testQuestionsContainer > div');
  if (!title || rows.length === 0) {
    msgEl.innerHTML = `<span class="badge danger">Please add a title and at least one question.</span>`;
    return;
  }

  const questions = [];
  for (const row of rows) {
    const qType = row.querySelector('.tq-type').value;
    const questionText = row.querySelector('.tq-text').value.trim();
    const topic = row.querySelector('.tq-topic').value.trim();
    if (!questionText) { msgEl.innerHTML = `<span class="badge danger">Every question needs text.</span>`; return; }

    if (qType === 'mcq') {
      const opts = Array.from(row.querySelectorAll('.tq-opt')).map(i => i.value.trim()).filter(Boolean);
      const correctIdx = parseInt(row.querySelector('.tq-correct-mcq').value, 10) - 1;
      if (opts.length < 2) { msgEl.innerHTML = `<span class="badge danger">MCQ questions need at least 2 options.</span>`; return; }
      questions.push({ qType, questionText, topic, options: opts, correctAnswer: String(correctIdx), difficulty });
    } else {
      const correct = row.querySelector('.tq-correct-fill').value.trim();
      if (!correct) { msgEl.innerHTML = `<span class="badge danger">Fill-in-the-blank questions need a correct answer.</span>`; return; }
      questions.push({ qType, questionText, topic, correctAnswer: correct, difficulty });
    }
  }

  let scheduledAt = null;
  if (scheduledAtRaw) scheduledAt = new Date(scheduledAtRaw).toISOString();

  btn.disabled = true; btn.textContent = 'Scheduling...';
  try {
    await api('/api/faculty/tests', {
      method: 'POST',
      body: JSON.stringify({ title, subject, chapter, difficulty, timeLimitMin, negativeMarking, randomize, scheduledAt, questions })
    });
    msgEl.innerHTML = `<span class="badge success">✅ Test scheduled successfully.</span>`;
    showToast('Test scheduled.', 'success');
    document.getElementById('testTitle').value = '';
    document.getElementById('testChapter').value = '';
    document.getElementById('testQuestionsContainer').innerHTML = '';
    testQuestionCount = 0;
    renderFacultyTests();
  } catch (err) {
    msgEl.innerHTML = `<span class="badge danger">${err.message}</span>`;
    showToast(err.message, 'error');
  } finally {
    btn.disabled = false; btn.textContent = 'Schedule test';
  }
}

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
// TEST MANAGEMENT — STUDENT (attempt tests)
// ====================================================================
let activeStudentTest = null;
let activeTestQuestions = [];

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


function adminLogin() {
  const passcode = document.getElementById('adminPasscode').value;
  const errEl = document.getElementById('adminLoginError');
  if (passcode === ADMIN_PASSCODE) {
    sessionStorage.setItem('neet_ctk_admin', '1');
    document.getElementById('adminLoginCard').style.display = 'none';
    document.getElementById('adminConsole').style.display = 'block';
    renderAdmin();
  } else {
    errEl.innerHTML = `<span class="badge danger">Incorrect passcode.</span>`;
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

async function resetAllData() {
  if (!confirm('This will permanently delete ALL students, progress, lectures and feedback. Continue?')) return;
  if (!confirm('Are you absolutely sure? This cannot be undone.')) return;
  try {
    await api('/api/admin/reset-all', { method: 'POST' });
    localStorage.removeItem('neet_ctk_email');
    localStorage.removeItem('neet_ctk_lecturer');
    showToast('All platform data has been reset.', 'success');
    setTimeout(() => location.reload(), 800);
  } catch (err) { showToast(err.message, 'error'); }
}

// ====================================================================
// FEEDBACK
// ====================================================================
async function sendFeedback() {
  const msg = document.getElementById('feedbackMsg').value.trim();
  const respEl = document.getElementById('feedbackResp');
  if (!msg) { respEl.innerHTML = `<span class="badge danger">Please write a message first.</span>`; return; }
  try {
    await api('/api/feedback', { method: 'POST', body: JSON.stringify({ message: msg }) });
    respEl.innerHTML = `<span class="badge success">Thanks — your feedback has been recorded.</span>`;
    document.getElementById('feedbackMsg').value = '';
  } catch (err) {
    respEl.innerHTML = `<span class="badge danger">${err.message}</span>`;
  }
}

// ====================================================================
// NAVIGATION
// ====================================================================
const AUTH_REQUIRED_PAGES = {
  guidance: 'student', practice: 'student', progress: 'student',
  onboarding: 'student', lecturer: 'faculty', facultyDashboard: 'faculty'
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
  if (pageId === 'lecturer') { renderMySubmissions(); renderFacultyTests(); renderFacultyAnalytics(); }
  if (pageId === 'onboarding') prefillOnboarding();
  if (pageId === 'admin') {
    if (sessionStorage.getItem('neet_ctk_admin') === '1') {
      document.getElementById('adminLoginCard').style.display = 'none';
      document.getElementById('adminConsole').style.display = 'block';
      renderAdmin();
    } else {
      document.getElementById('adminLoginCard').style.display = 'block';
      document.getElementById('adminConsole').style.display = 'none';
    }
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
  document.getElementById('navLecturer').style.display    = (loggedIn && role === 'faculty') ? '' : 'none';
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

  document.getElementById('authRole').onchange = (e) => {
    document.getElementById('adminCodeGroup').style.display = e.target.value === 'admin' ? '' : 'none';
  };

  // Existing app features
  document.getElementById('submitQuizBtn').onclick = submitQuiz;
  document.getElementById('submitLectureBtn').onclick = submitLecture;
  document.getElementById('refreshSubmissionsBtn').onclick = renderMySubmissions;
  document.getElementById('addTestQuestionBtn').onclick = addTestQuestionRow;
  document.getElementById('createTestBtn').onclick = createTest;
  document.getElementById('refreshFacultyTestsBtn').onclick = renderFacultyTests;
  document.getElementById('refreshStudentTestsBtn').onclick = renderStudentTests;
  document.getElementById('sendFeedbackBtn').onclick = sendFeedback;
  document.getElementById('adminLoginBtn').onclick = adminLogin;
  document.getElementById('setExamDateBtn').onclick = setExamDate;
  document.getElementById('resetAllDataBtn').onclick = resetAllData;
  document.getElementById('upgradeProBtn').onclick = () => showToast('Payment integration coming soon — this is a demo upgrade flow.', '');
  document.getElementById('upgradePremiumBtn').onclick = () => showToast('Please use the Contact page to arrange Premium payment.', '');
  document.getElementById('startNowBtn').onclick = () => showPage(currentUser ? (currentUser.role === 'student' ? 'guidance' : 'lecturer') : 'register');

  document.querySelectorAll('.nav-btn').forEach(btn =>
    btn.addEventListener('click', () => {
      const page = btn.getAttribute('data-page');
      if (page) showPage(page);
    })
  );

  updateNavForAuth();

  if (currentUser?.role === 'student' && currentStudentEmail) {
    loadStudentData(currentStudentEmail).then(() => showPage('welcome'));
  } else {
    showPage('welcome');
  }
};
