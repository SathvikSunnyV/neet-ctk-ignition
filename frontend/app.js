// app.js - NEET CTK IGNITION frontend logic
// Talks to the Express + PostgreSQL backend defined in /backend.

const API_BASE = window.location.origin;
const ADMIN_PASSCODE = 'ctk-admin'; // demo only - replace with real auth in production

let currentStudentEmail = localStorage.getItem('neet_ctk_email') || null;
let globalStudentData = null;
let cachedQuestions = null;

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
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options
  });
  let data = null;
  try { data = await res.json(); } catch (e) { /* no body */ }
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
// REGISTRATION
// ====================================================================
async function registerStudent() {
  const btn = document.getElementById('registerBtn');
  const name = document.getElementById('regName').value.trim();
  const email = document.getElementById('regEmail').value.trim();
  const phone = document.getElementById('regPhone').value.trim();
  const category = document.getElementById('regCategory').value;
  const aim = document.getElementById('regAim').value;
  const examDate = document.getElementById('regExamDate').value;
  const msgEl = document.getElementById('regMessage');

  if (!name || !email) {
    msgEl.innerHTML = `<span class="badge danger">Please fill in your name and email.</span>`;
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Building your plan...';
  msgEl.innerHTML = '';

  try {
    const data = await api('/api/register', {
      method: 'POST',
      body: JSON.stringify({ name, email, phone, category, aim, examDate })
    });
    currentStudentEmail = email;
    localStorage.setItem('neet_ctk_email', email);
    globalStudentData = data;
    msgEl.innerHTML = `<span class="badge success">✅ Registration successful — your plan is ready.</span>`;
    showToast('Welcome aboard! Your personalised plan is ready.', 'success');
    setTimeout(() => showPage('guidance'), 600);
  } catch (err) {
    msgEl.innerHTML = `<span class="badge danger">${err.message}</span>`;
    showToast(err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Register & build my plan';
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
    const { student, progress, targets } = data;
    const { phases, daysLeft, progressPercent, focusSubject, strongSubject, message } = plan;

    container.innerHTML = `
      <div class="card">
        <h2>Your Seven Hills plan, ${student.name.split(' ')[0]}</h2>
        <p style="color:var(--ink-soft); margin-bottom:1rem;">${daysLeft} days remain until the platform exam date. Aim: <strong>${student.aim}</strong> · Category: <strong>${student.category}</strong>.</p>

        <div class="progress-bar"><div class="progress-fill" style="width:${progressPercent}%"></div></div>
        <p class="helper-text">Overall readiness: ${progressPercent}% of target accuracy reached.</p>

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
      </div>`;

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
// ADMIN CONSOLE
// ====================================================================
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
function showPage(pageId) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.getElementById(pageId + 'Page').classList.add('active');
  document.querySelectorAll('.nav-btn').forEach(btn => btn.classList.remove('active'));
  const navBtn = document.querySelector(`.nav-btn[data-page="${pageId}"]`);
  if (navBtn) navBtn.classList.add('active');

  if (pageId === 'guidance') renderGuidance();
  if (pageId === 'practice') renderPractice();
  if (pageId === 'progress') renderProgress();
  if (pageId === 'lecturer') renderMySubmissions();
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
window.showPage = showPage;

// ====================================================================
// INIT
// ====================================================================
window.onload = () => {
  document.getElementById('registerBtn').onclick = registerStudent;
  document.getElementById('submitQuizBtn').onclick = submitQuiz;
  document.getElementById('submitLectureBtn').onclick = submitLecture;
  document.getElementById('refreshSubmissionsBtn').onclick = renderMySubmissions;
  document.getElementById('sendFeedbackBtn').onclick = sendFeedback;
  document.getElementById('adminLoginBtn').onclick = adminLogin;
  document.getElementById('setExamDateBtn').onclick = setExamDate;
  document.getElementById('resetAllDataBtn').onclick = resetAllData;
  document.getElementById('upgradeProBtn').onclick = () => showToast('Payment integration coming soon — this is a demo upgrade flow.', '');
  document.getElementById('upgradePremiumBtn').onclick = () => showToast('Please use the Contact page to arrange Premium payment.', '');
  document.getElementById('startNowBtn').onclick = () => showPage('register');

  document.querySelectorAll('.nav-btn').forEach(btn =>
    btn.addEventListener('click', () => showPage(btn.getAttribute('data-page')))
  );

  if (currentStudentEmail) {
    loadStudentData(currentStudentEmail).then(() => showPage('welcome'));
  } else {
    showPage('welcome');
  }
};
