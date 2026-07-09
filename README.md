# CTK Bridge Course

**A comprehensive NEET & JEE preparation platform built on the Connectomic Theory of Knowledge.**

Migrated and expanded from NEET CTK IGNITION → CTK Bridge Course (v3.0).

---

## What's New in v3.0

- ✅ **Both NEET & JEE** — students can register for NEET, JEE, or both
- ✅ **Centralized Question Bank** — single source of truth for all MCQs
- ✅ **Faculty Approval Workflow** — questions go through pending → approved/rejected cycle
- ✅ **All Test Types** — Entry (3 fixed), Daily, Weekly, Monthly, Grand (3-month), Chapter Combo, Full Mock
- ✅ **JEE Subjects** — Physics, Chemistry, Mathematics (removable)
- ✅ **NEET Subjects** — Physics, Chemistry, Botany, Zoology
- ✅ **Question Exposure Tracking** — per-student question history, usage counts
- ✅ **Test Centre UI** — unified test dashboard for students
- ✅ **Question Bank UI** — faculty submit, approve, and browse questions

---

## Architecture

```
CTK Bridge Course
├── backend/
│   ├── server.js       — Express API (all original routes preserved + new ones)
│   ├── db.js           — PostgreSQL schema + test generation engine
│   ├── qbank.js        — Question bank & test engine routes (additive)
│   ├── auth.js         — JWT authentication
│   ├── ai.js           — AI recommendations
│   ├── ocr.js          — OCR-based question upload
│   └── research.js     — Live cutoff data via web research
└── frontend/
    ├── index.html      — SPA with new Test Centre + Question Bank pages
    ├── app.js          — All original JS + Bridge Course + QBank modules
    └── styles.css      — Unchanged
```

---

## Curriculum

### NEET
| Subject  | Chapters |
|----------|---------|
| Physics  | 13 chapters (Units → Modern Physics) |
| Chemistry| 13 chapters (Atomic Structure → Hydrocarbons) |
| Botany   | 13 chapters (Cell Biology → Plant Growth) |
| Zoology  | 13 chapters (Animal Kingdom → Circulatory System) |

### JEE
| Subject     | Chapters |
|-------------|---------|
| Physics     | 13 chapters (same as NEET) |
| Chemistry   | 13 chapters (same as NEET) |
| Mathematics | 15 chapters (Sets → Trigonometry) |

---

## Test Types

| Type | Questions | Frequency | Notes |
|------|-----------|-----------|-------|
| Entry Test | 90 | 3 fixed per course | Pre-generated, same for all students |
| Daily Practice | 90 | Every day | Auto-generated, no repeats within 30 days |
| Weekly Test | 90 | Every week | Higher difficulty proportion |
| Monthly Test | 90 | Every month | Comprehensive chapter coverage |
| Grand Test | 90 | Every 3 months | Full syllabus coverage |
| Chapter Combo | 90 | On-demand | Choose 3, 6, or any chapters |
| Full Mock | 90 | Unlimited | Randomized, balanced |
| Faculty Test | Variable | Faculty-scheduled | Existing system preserved |

---

## Question Bank

Questions flow through an approval pipeline:

```
Faculty Submits → pending → Faculty/Admin Approves → approved → Used in tests
                         → Faculty/Admin Rejects  → rejected
```

Monthly/trimonthly batch approval is supported via the bulk approve endpoint.

The question bank seed provides **5 dummy approved questions per chapter** across all subjects to make the platform functional immediately. Faculty replace these with real questions.

---

## Deployment

### Render.com
```bash
# Set environment variables in Render dashboard:
DATABASE_URL=<postgres-connection-string>
JWT_SECRET=<your-secret>
DEFAULT_ADMIN_EMAIL=admin@ctkbridge.com
DEFAULT_ADMIN_PASSWORD=<your-password>
ADMIN_SIGNUP_CODE=<invite-code>
SMTP_HOST=smtp.gmail.com
SMTP_USER=<your-email>
SMTP_PASS=<app-password>
HF_TOKEN=<huggingface-token>  # optional, for AI recommendations
```

### Railway
Same env vars. The `railway.toml` is pre-configured.

### Local Development
```bash
cd backend
cp .envexample .env   # fill in DATABASE_URL and other values
npm install
npm run dev
# Visit http://localhost:4000
```

---

## Default Admin
- Email: `admin@ctkbridge.com`
- Password: `ctk-admin-2026`
- Change via `DEFAULT_ADMIN_EMAIL` / `DEFAULT_ADMIN_PASSWORD` env vars

---

## API Reference (new endpoints)

### Question Bank
| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | `/api/qbank/questions` | faculty | Submit question |
| POST | `/api/qbank/questions/bulk` | faculty | Bulk submit |
| GET | `/api/qbank/questions` | any | List/filter questions |
| PUT | `/api/qbank/questions/:id` | faculty | Edit own pending question |
| POST | `/api/qbank/questions/:id/approve` | faculty/admin | Approve or reject |
| GET | `/api/qbank/stats` | any | Bank statistics |
| GET | `/api/bridge/faculty/pending-questions` | faculty | Approval queue |
| POST | `/api/bridge/faculty/approve-batch` | faculty | Batch approve |

### Test Engine
| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/api/bridge/entry-tests?courseType=NEET` | student | List entry tests |
| GET | `/api/bridge/entry-tests/:courseType/:testNumber` | student | Get entry test |
| GET | `/api/bridge/tests/daily?courseType=NEET` | student | Today's daily test |
| GET | `/api/bridge/tests/weekly?courseType=NEET` | student | This week's test |
| GET | `/api/bridge/tests/monthly?courseType=NEET` | student | This month's test |
| POST | `/api/bridge/tests/mock` | student | Generate mock test |
| POST | `/api/bridge/tests/chapter-combo` | student | Chapter combo test |
| POST | `/api/bridge/tests/grand` | student | Grand test |
| GET | `/api/bridge/tests/:id/questions` | student | Get test questions |
| POST | `/api/bridge/tests/:id/submit` | student | Submit answers |
| GET | `/api/bridge/tests/history` | student | Test history |
| GET | `/api/bridge/analytics` | student | Performance analytics |
| GET | `/api/bridge/curriculum` | any | Curriculum structure |

---

## What's Preserved from NEET CTK IGNITION

All original functionality is intact and additive:
- User authentication (JWT, OTP, email verification)
- Student onboarding & profiling
- Study plan & guidance
- Faculty test creation (OCR upload, bulk paste)
- Lecturer Hub (chapters, materials, lectures)
- Physics Student Module (entry tests, term materials, progress tracking)
- Admin panel
- AI-based NEET cutoff prediction
- Error Atlas & mistake analysis
- Chart.js analytics dashboards

---

*CTK Bridge Course · Built on the Connectomic Theory of Knowledge · The Seven Hills of Knowledge*
