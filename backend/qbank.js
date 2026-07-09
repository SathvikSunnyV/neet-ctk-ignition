const { Router } = require('express');

function init(deps) {
    const {
        pool, authenticate, requireRole, CURRICULUM,
        generateDailyTest, generateWeeklyTest, generateMonthlyTest,
        generateGrandTest, generateChapterComboTest, generateMockTest,
        fillTestQuestions, computeScore, applyBridgeProgressUpdate
    } = deps;

    const router = Router();

    // ============================================================
    // QUESTION BANK — Faculty CRUD + approval workflow
    // ============================================================

    router.post('/api/qbank/questions', authenticate, requireRole('faculty'), async (req, res) => {
        const {
            courseType, subject, chapterName, topic, subtopic,
            questionText, optionA, optionB, optionC, optionD,
            correctAnswer, explanation, difficulty, estimatedTime
        } = req.body;

        if (!courseType || !subject || !chapterName || !questionText ||
            !optionA || !optionB || !optionC || !optionD || !correctAnswer)
            return res.status(400).json({ error: 'All fields required.' });

        if (!['NEET','JEE','BOTH'].includes(courseType))
            return res.status(400).json({ error: 'courseType must be NEET, JEE, or BOTH.' });

        if (!['A','B','C','D'].includes(correctAnswer))
            return res.status(400).json({ error: 'correctAnswer must be A, B, C, or D.' });

        try {
            const { rows: [q] } = await pool.query(
                `INSERT INTO question_bank
                 (course_type, subject, chapter_name, topic, subtopic, question_text,
                  option_a, option_b, option_c, option_d, correct_answer,
                  explanation, difficulty, estimated_time, status, submitted_by)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'pending',$15)
                 RETURNING id, status, created_at`,
                [courseType, subject, chapterName, topic||null, subtopic||null, questionText,
                 optionA, optionB, optionC, optionD, correctAnswer,
                 explanation||null, difficulty||'Moderate', estimatedTime||60, req.user.email]
            );
            res.status(201).json({ success: true, question: q });
        } catch (err) {
            console.error(err);
            res.status(500).json({ error: 'Server error.' });
        }
    });

    router.post('/api/qbank/questions/bulk', authenticate, requireRole('faculty'), async (req, res) => {
        const { questions } = req.body;
        if (!Array.isArray(questions) || questions.length === 0)
            return res.status(400).json({ error: 'questions array required.' });

        const inserted = [], errors = [];
        for (let i = 0; i < questions.length; i++) {
            const q = questions[i];
            try {
                const { rows: [row] } = await pool.query(
                    `INSERT INTO question_bank
                     (course_type, subject, chapter_name, topic, question_text,
                      option_a, option_b, option_c, option_d, correct_answer,
                      explanation, difficulty, estimated_time, status, submitted_by)
                     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'pending',$14)
                     RETURNING id`,
                    [q.courseType||'NEET', q.subject, q.chapterName, q.topic||null,
                     q.questionText, q.optionA, q.optionB, q.optionC, q.optionD,
                     q.correctAnswer, q.explanation||null, q.difficulty||'Moderate',
                     q.estimatedTime||60, req.user.email]
                );
                inserted.push(row.id);
            } catch (err) {
                errors.push({ index: i, error: err.message });
            }
        }
        res.json({ success: true, inserted: inserted.length, errors });
    });

    router.get('/api/qbank/questions', authenticate, async (req, res) => {
        const { courseType, subject, chapter, difficulty, status: qStatus, page = 1, limit = 50 } = req.query;
        const offset = (parseInt(page) - 1) * parseInt(limit);

        const conditions = [];
        const params = [];
        if (courseType) { params.push(courseType); conditions.push(`course_type = $${params.length}`); }
        if (subject)    { params.push(subject);    conditions.push(`subject = $${params.length}`); }
        if (chapter)    { params.push(chapter);    conditions.push(`chapter_name = $${params.length}`); }
        if (difficulty) { params.push(difficulty); conditions.push(`difficulty = $${params.length}`); }
        if (qStatus)    { params.push(qStatus);    conditions.push(`status = $${params.length}`); }

        if (req.user.role === 'faculty') {
            params.push(req.user.email);
            conditions.push(`(status = 'approved' OR submitted_by = $${params.length})`);
        }

        const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
        params.push(parseInt(limit), offset);

        try {
            const { rows } = await pool.query(
                `SELECT id, course_type, subject, chapter_name, topic, question_text,
                        option_a, option_b, option_c, option_d, correct_answer,
                        difficulty, status, usage_count, submitted_by, approved_at, created_at
                 FROM question_bank ${where}
                 ORDER BY created_at DESC
                 LIMIT $${params.length - 1} OFFSET $${params.length}`,
                params
            );
            const { rows: [cnt] } = await pool.query(
                `SELECT COUNT(*) AS total FROM question_bank ${where}`,
                params.slice(0, -2)
            );
            res.json({ questions: rows, total: parseInt(cnt.total), page: parseInt(page), limit: parseInt(limit) });
        } catch (err) {
            console.error(err);
            res.status(500).json({ error: 'Server error.' });
        }
    });

    router.get('/api/qbank/questions/:id', authenticate, async (req, res) => {
        try {
            const { rows: [q] } = await pool.query(`SELECT * FROM question_bank WHERE id = $1`, [req.params.id]);
            if (!q) return res.status(404).json({ error: 'Question not found.' });
            if (req.user.role === 'faculty' && q.status !== 'approved' && q.submitted_by !== req.user.email)
                return res.status(403).json({ error: 'Forbidden.' });
            res.json(q);
        } catch (err) {
            res.status(500).json({ error: 'Server error.' });
        }
    });

    router.put('/api/qbank/questions/:id', authenticate, requireRole('faculty'), async (req, res) => {
        const { rows: [q] } = await pool.query(`SELECT * FROM question_bank WHERE id = $1`, [req.params.id]);
        if (!q) return res.status(404).json({ error: 'Not found.' });
        if (q.submitted_by !== req.user.email)
            return res.status(403).json({ error: 'You can only edit your own questions.' });
        if (q.status === 'approved')
            return res.status(400).json({ error: 'Approved questions cannot be edited.' });

        const { questionText, optionA, optionB, optionC, optionD, correctAnswer, explanation, difficulty } = req.body;
        try {
            await pool.query(
                `UPDATE question_bank SET question_text=$1, option_a=$2, option_b=$3, option_c=$4, option_d=$5,
                 correct_answer=$6, explanation=$7, difficulty=$8, status='pending' WHERE id=$9`,
                [questionText||q.question_text, optionA||q.option_a, optionB||q.option_b,
                 optionC||q.option_c, optionD||q.option_d, correctAnswer||q.correct_answer,
                 explanation||q.explanation, difficulty||q.difficulty, req.params.id]
            );
            res.json({ success: true });
        } catch (err) {
            res.status(500).json({ error: 'Server error.' });
        }
    });

    // Delete a question. Faculty may delete their own not-yet-approved
    // submissions; admins (and the faculty approver on record) may delete
    // any question, including approved ones (e.g. to retire a bad item).
    router.delete('/api/qbank/questions/:id', authenticate, async (req, res) => {
        if (!['faculty','admin'].includes(req.user.role))
            return res.status(403).json({ error: 'Only faculty or admin can delete questions.' });
        try {
            const { rows: [q] } = await pool.query(`SELECT * FROM question_bank WHERE id = $1`, [req.params.id]);
            if (!q) return res.status(404).json({ error: 'Not found.' });

            const isOwner = q.submitted_by === req.user.email;
            const isAdmin = req.user.role === 'admin';
            if (q.status === 'approved' && !isAdmin) {
                return res.status(403).json({ error: 'Only an admin can delete an approved question.' });
            }
            if (!isOwner && !isAdmin) {
                return res.status(403).json({ error: 'You can only delete your own questions.' });
            }

            await pool.query(`DELETE FROM question_bank WHERE id = $1`, [req.params.id]);
            res.json({ success: true });
        } catch (err) {
            console.error(err);
            res.status(500).json({ error: 'Server error.' });
        }
    });

    router.post('/api/qbank/questions/:id/approve', authenticate, async (req, res) => {
        if (!['admin','faculty'].includes(req.user.role))
            return res.status(403).json({ error: 'Only faculty or admin can approve questions.' });

        const { action, rejectionNote } = req.body;
        if (!['approve','reject'].includes(action))
            return res.status(400).json({ error: 'action must be approve or reject.' });

        try {
            const newStatus = action === 'approve' ? 'approved' : 'rejected';
            await pool.query(
                `UPDATE question_bank SET status=$1, approved_by=$2, approved_at=NOW(), rejection_note=$3 WHERE id=$4`,
                [newStatus, req.user.email, rejectionNote||null, req.params.id]
            );
            res.json({ success: true, status: newStatus });
        } catch (err) {
            res.status(500).json({ error: 'Server error.' });
        }
    });

    router.get('/api/qbank/stats', authenticate, async (req, res) => {
        try {
            const { rows: [counts] } = await pool.query(`
                SELECT
                    COUNT(*) FILTER (WHERE status='approved') AS approved,
                    COUNT(*) FILTER (WHERE status='pending')  AS pending,
                    COUNT(*) FILTER (WHERE status='rejected') AS rejected,
                    COUNT(*) AS total
                FROM question_bank
            `);
            const { rows: byCourse } = await pool.query(`
                SELECT course_type, subject, COUNT(*) AS count, AVG(usage_count) AS avg_usage
                FROM question_bank WHERE status='approved'
                GROUP BY course_type, subject ORDER BY course_type, subject
            `);
            const { rows: topUsed } = await pool.query(`
                SELECT id, subject, chapter_name, question_text, usage_count
                FROM question_bank WHERE status='approved'
                ORDER BY usage_count DESC LIMIT 10
            `);
            const { rows: leastUsed } = await pool.query(`
                SELECT id, subject, chapter_name, question_text, usage_count
                FROM question_bank WHERE status='approved'
                ORDER BY usage_count ASC LIMIT 10
            `);
            res.json({ counts, byCourse, topUsed, leastUsed });
        } catch (err) {
            res.status(500).json({ error: 'Server error.' });
        }
    });

    // ============================================================
    // ENTRY TESTS
    // ============================================================

    router.get('/api/bridge/entry-tests', authenticate, requireRole('student'), async (req, res) => {
        const courseType = req.query.courseType || 'NEET';
        try {
            const { rows } = await pool.query(
                `SELECT et.*, gt.question_count, gt.time_limit_min,
                        ta.id AS attempt_id, ta.score, ta.total, ta.submitted_at
                 FROM entry_tests et
                 JOIN generated_tests gt ON et.test_id = gt.id
                 LEFT JOIN test_attempts ta ON ta.test_id = et.test_id AND ta.student_email = $1
                 WHERE et.course_type = $2
                 ORDER BY et.test_number`,
                [req.user.email, courseType]
            );
            res.json(rows);
        } catch (err) {
            res.status(500).json({ error: 'Server error.' });
        }
    });

    router.get('/api/bridge/entry-tests/:courseType/:testNumber', authenticate, requireRole('student'), async (req, res) => {
        const { courseType, testNumber } = req.params;
        try {
            const { rows: [et] } = await pool.query(
                `SELECT et.test_id, et.title, gt.time_limit_min, gt.question_count
                 FROM entry_tests et JOIN generated_tests gt ON et.test_id = gt.id
                 WHERE et.course_type=$1 AND et.test_number=$2`,
                [courseType, parseInt(testNumber)]
            );
            if (!et) return res.status(404).json({ error: 'Entry test not found.' });

            const { rows: [attempt] } = await pool.query(
                `SELECT id FROM test_attempts WHERE test_id=$1 AND student_email=$2`,
                [et.test_id, req.user.email]
            );
            if (attempt) return res.status(400).json({ error: 'Already attempted.', alreadyAttempted: true });

            const { rows: questions } = await pool.query(
                `SELECT q.id, q.subject, q.chapter_name, q.question_text,
                        q.option_a, q.option_b, q.option_c, q.option_d, q.difficulty, q.estimated_time
                 FROM generated_test_questions gtq
                 JOIN question_bank q ON gtq.question_id = q.id
                 WHERE gtq.test_id = $1
                 ORDER BY gtq.position`,
                [et.test_id]
            );
            res.json({ testId: et.test_id, title: et.title, timeLimitMin: et.time_limit_min, questions });
        } catch (err) {
            res.status(500).json({ error: 'Server error.' });
        }
    });

    // ============================================================
    // GENERATED TEST ENGINE — student-facing
    // ============================================================

    router.get('/api/bridge/tests/history', authenticate, requireRole('student'), async (req, res) => {
        const { courseType, testType } = req.query;
        try {
            const { rows } = await pool.query(
                `SELECT ta.id, ta.score, ta.total, ta.correct_count, ta.wrong_count, ta.skipped_count,
                        ta.neet_equiv_score, ta.percentile_est, ta.submitted_at,
                        gt.title, gt.test_type, gt.course_type, gt.question_count
                 FROM test_attempts ta
                 JOIN generated_tests gt ON ta.test_id = gt.id
                 WHERE ta.student_email = $1
                   AND ($2::text IS NULL OR gt.course_type = $2)
                   AND ($3::text IS NULL OR gt.test_type = $3)
                 ORDER BY ta.submitted_at DESC
                 LIMIT 50`,
                [req.user.email, courseType||null, testType||null]
            );
            res.json(rows);
        } catch (err) {
            res.status(500).json({ error: 'Server error.' });
        }
    });

    router.get('/api/bridge/tests/daily', authenticate, requireRole('student'), async (req, res) => {
        const courseType = req.query.courseType || 'NEET';
        try {
            const testId = await generateDailyTest(courseType);
            const { rows: [gt] } = await pool.query(
                `SELECT id, title, time_limit_min, question_count FROM generated_tests WHERE id=$1`, [testId]
            );
            const { rows: [attempt] } = await pool.query(
                `SELECT id, score, total, submitted_at FROM test_attempts WHERE test_id=$1 AND student_email=$2`,
                [testId, req.user.email]
            );
            res.json({ test: gt, alreadyAttempted: !!attempt, attempt: attempt || null });
        } catch (err) {
            console.error(err);
            res.status(500).json({ error: 'Server error.' });
        }
    });

    router.get('/api/bridge/tests/weekly', authenticate, requireRole('student'), async (req, res) => {
        const courseType = req.query.courseType || 'NEET';
        const now = new Date();
        const monday = new Date(now);
        monday.setDate(now.getDate() - ((now.getDay() + 6) % 7));
        try {
            const testId = await generateWeeklyTest(courseType, monday);
            const { rows: [gt] } = await pool.query(
                `SELECT id, title, time_limit_min, question_count FROM generated_tests WHERE id=$1`, [testId]
            );
            const { rows: [attempt] } = await pool.query(
                `SELECT id, score, total, submitted_at FROM test_attempts WHERE test_id=$1 AND student_email=$2`,
                [testId, req.user.email]
            );
            res.json({ test: gt, alreadyAttempted: !!attempt, attempt: attempt || null });
        } catch (err) {
            res.status(500).json({ error: 'Server error.' });
        }
    });

    router.get('/api/bridge/tests/monthly', authenticate, requireRole('student'), async (req, res) => {
        const courseType = req.query.courseType || 'NEET';
        const now = new Date();
        try {
            const testId = await generateMonthlyTest(courseType, now.getMonth() + 1, now.getFullYear());
            const { rows: [gt] } = await pool.query(
                `SELECT id, title, time_limit_min, question_count FROM generated_tests WHERE id=$1`, [testId]
            );
            const { rows: [attempt] } = await pool.query(
                `SELECT id, score, total, submitted_at FROM test_attempts WHERE test_id=$1 AND student_email=$2`,
                [testId, req.user.email]
            );
            res.json({ test: gt, alreadyAttempted: !!attempt, attempt: attempt || null });
        } catch (err) {
            res.status(500).json({ error: 'Server error.' });
        }
    });

    router.post('/api/bridge/tests/mock', authenticate, requireRole('student'), async (req, res) => {
        const courseType = req.body.courseType || 'NEET';
        const difficultyMode = req.body.difficultyMode || 'Mixed';
        try {
            const testId = await generateMockTest(courseType, difficultyMode, req.user.email);
            const { rows: [gt] } = await pool.query(
                `SELECT id, title, time_limit_min, question_count FROM generated_tests WHERE id=$1`, [testId]
            );
            res.json({ success: true, test: gt });
        } catch (err) {
            res.status(500).json({ error: 'Server error.' });
        }
    });

    router.post('/api/bridge/tests/chapter-combo', authenticate, requireRole('student'), async (req, res) => {
        const { courseType, subject, chapters } = req.body;
        if (!courseType || !subject || !Array.isArray(chapters) || chapters.length === 0)
            return res.status(400).json({ error: 'courseType, subject, and chapters array required.' });
        try {
            const testId = await generateChapterComboTest(courseType, subject, chapters, req.user.email);
            const { rows: [gt] } = await pool.query(
                `SELECT id, title, time_limit_min, question_count FROM generated_tests WHERE id=$1`, [testId]
            );
            res.json({ success: true, test: gt });
        } catch (err) {
            res.status(500).json({ error: 'Server error.' });
        }
    });

    // Grand Tests are published by faculty, not generated on demand by
    // students. Students can only fetch the most recently published one
    // for their course and take it (once).
    router.get('/api/bridge/tests/grand', authenticate, requireRole('student'), async (req, res) => {
        const courseType = req.query.courseType || 'NEET';
        try {
            const { rows: [gt] } = await pool.query(
                `SELECT id, title, time_limit_min, question_count, created_at
                 FROM generated_tests WHERE test_type='grand' AND course_type=$1
                 ORDER BY created_at DESC LIMIT 1`,
                [courseType]
            );
            if (!gt) return res.json({ test: null, available: false });

            const { rows: [attempt] } = await pool.query(
                `SELECT id, score, total, submitted_at FROM test_attempts WHERE test_id=$1 AND student_email=$2`,
                [gt.id, req.user.email]
            );
            res.json({ test: gt, available: true, alreadyAttempted: !!attempt, attempt: attempt || null });
        } catch (err) {
            console.error(err);
            res.status(500).json({ error: 'Server error.' });
        }
    });

    // Faculty: publish a Grand Test for a course type. Publishing the same
    // courseType + label twice returns the already-published test rather
    // than creating a duplicate.
    router.post('/api/bridge/faculty/tests/grand', authenticate, requireRole('faculty'), async (req, res) => {
        const courseType = req.body.courseType || 'NEET';
        const now = new Date();
        const label = req.body.label || `Q${Math.ceil((now.getMonth() + 1) / 3)} ${now.getFullYear()}`;
        try {
            const { rows: existingBefore } = await pool.query(
                `SELECT id FROM generated_tests WHERE test_type='grand' AND course_type=$1 AND title=$2`,
                [courseType, `${courseType} Grand Test — ${label}`]
            );
            const testId = await generateGrandTest(courseType, label, null, req.user.email);
            const { rows: [gt] } = await pool.query(
                `SELECT id, title, time_limit_min, question_count, created_at FROM generated_tests WHERE id=$1`, [testId]
            );
            res.json({ success: true, test: gt, alreadyPublished: existingBefore.length > 0 });
        } catch (err) {
            console.error(err);
            res.status(500).json({ error: 'Server error.' });
        }
    });

    // Faculty: list published Grand Tests with attempt counts.
    router.get('/api/bridge/faculty/tests/grand', authenticate, requireRole('faculty'), async (req, res) => {
        try {
            const { rows } = await pool.query(
                `SELECT gt.id, gt.title, gt.course_type, gt.question_count, gt.time_limit_min, gt.created_at,
                        COUNT(ta.id) AS attempt_count
                 FROM generated_tests gt
                 LEFT JOIN test_attempts ta ON ta.test_id = gt.id
                 WHERE gt.test_type = 'grand'
                 GROUP BY gt.id
                 ORDER BY gt.created_at DESC`
            );
            res.json(rows);
        } catch (err) {
            console.error(err);
            res.status(500).json({ error: 'Server error.' });
        }
    });

    router.get('/api/bridge/tests/:id/questions', authenticate, requireRole('student'), async (req, res) => {
        const testId = parseInt(req.params.id);
        try {
            const { rows: [gt] } = await pool.query(
                `SELECT id, title, test_type, time_limit_min, negative_marking FROM generated_tests WHERE id=$1`, [testId]
            );
            if (!gt) return res.status(404).json({ error: 'Test not found.' });

            const { rows: questions } = await pool.query(
                `SELECT q.id, q.subject, q.chapter_name, q.topic, q.question_text,
                        q.option_a, q.option_b, q.option_c, q.option_d,
                        q.difficulty, q.estimated_time
                 FROM generated_test_questions gtq
                 JOIN question_bank q ON gtq.question_id = q.id
                 WHERE gtq.test_id = $1
                 ORDER BY gtq.position`,
                [testId]
            );

            // Logging exposure is best-effort bookkeeping (used to avoid
            // repeat questions later) — it must never block a student from
            // seeing a test they're entitled to, e.g. if they haven't
            // finished onboarding yet and have no `students` row.
            for (const q of questions) {
                try {
                    await pool.query(
                        `INSERT INTO question_exposure (student_email, question_id)
                         VALUES ($1,$2)
                         ON CONFLICT (student_email, question_id) DO UPDATE
                         SET times_seen = question_exposure.times_seen + 1, last_seen_at = NOW()`,
                        [req.user.email, q.id]
                    );
                } catch (exposureErr) {
                    console.warn('Skipped question_exposure log:', exposureErr.message);
                    break; // same FK issue will repeat for every question — stop retrying
                }
            }

            res.json({ test: gt, questions });
        } catch (err) {
            console.error(err);
            res.status(500).json({ error: 'Server error.' });
        }
    });

    router.post('/api/bridge/tests/:id/submit', authenticate, requireRole('student'), async (req, res) => {
        const testId = parseInt(req.params.id);
        const { answers, timeTakenSec } = req.body;

        try {
            const { rows: [gt] } = await pool.query(
                `SELECT id, negative_marking FROM generated_tests WHERE id=$1`, [testId]
            );
            if (!gt) return res.status(404).json({ error: 'Test not found.' });

            const { rows: [existing] } = await pool.query(
                `SELECT id FROM test_attempts WHERE test_id=$1 AND student_email=$2`,
                [testId, req.user.email]
            );
            if (existing) return res.status(400).json({ error: 'Already submitted.' });

            const { rows: questions } = await pool.query(
                `SELECT q.id, q.correct_answer, q.subject, q.chapter_name, q.topic, q.difficulty
                 FROM generated_test_questions gtq
                 JOIN question_bank q ON gtq.question_id = q.id
                 WHERE gtq.test_id = $1`,
                [testId]
            );

            const { correct, wrong, skipped, rawScore, totalMax, percentage, neetEquivScore, percentileEst }
                = computeScore(answers || {}, questions, gt.negative_marking);

            const { rows: [attempt] } = await pool.query(
                `INSERT INTO test_attempts
                 (test_id, student_email, answers, score, total, correct_count, wrong_count,
                  skipped_count, neet_equiv_score, percentile_est, time_taken_sec)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
                 RETURNING id, submitted_at`,
                [testId, req.user.email, JSON.stringify(answers || {}),
                 rawScore, totalMax, correct, wrong, skipped, neetEquivScore, percentileEst, timeTakenSec||null]
            );

            for (const q of questions) {
                const ans = (answers || {})[q.id];
                if (ans && ans !== q.correct_answer) {
                    await pool.query(
                        `INSERT INTO mistakes (student_email, test_id, question_id, subject, chapter_name, topic, difficulty, mistake_type)
                         VALUES ($1,$2,$3,$4,$5,$6,$7,'conceptual')`,
                        [req.user.email, testId, q.id, q.subject, q.chapter_name, q.topic, q.difficulty]
                    );
                }
            }

            // Analyze and record progress for THIS test -- every Bridge test
            // type (entry/daily/weekly/monthly/mock/chapter-combo/grand)
            // goes through this one route, so this single call is enough to
            // make sure any test a student takes updates their progress,
            // not only faculty-scheduled tests.
            try {
                await applyBridgeProgressUpdate(req.user.email, questions, answers || {}, correct, questions.length);
            } catch (progressErr) {
                console.warn('Progress update skipped:', progressErr.message);
            }

            res.json({
                success: true,
                attemptId: attempt.id,
                score: rawScore,
                total: totalMax,
                percentage: Math.round(percentage * 10) / 10,
                correct, wrong, skipped,
                neetEquivScore,
                percentileEst: Math.round(percentileEst * 10) / 10,
                submittedAt: attempt.submitted_at
            });
        } catch (err) {
            console.error(err);
            res.status(500).json({ error: 'Server error.' });
        }
    });

    router.get('/api/bridge/analytics', authenticate, requireRole('student'), async (req, res) => {
        const email = req.user.email;
        const courseType = req.query.courseType || 'NEET';
        try {
            const { rows: [overall] } = await pool.query(
                `SELECT COUNT(*) AS tests_taken,
                        AVG(ta.score::float / NULLIF(ta.total,0)) * 100 AS avg_pct,
                        MAX(ta.score::float / NULLIF(ta.total,0)) * 100 AS best_pct
                 FROM test_attempts ta
                 JOIN generated_tests gt ON ta.test_id = gt.id
                 WHERE ta.student_email = $1 AND gt.course_type = $2`,
                [email, courseType]
            );
            const { rows: weakChapters } = await pool.query(
                `SELECT chapter_name, subject, COUNT(*) AS mistake_count
                 FROM mistakes WHERE student_email = $1
                 GROUP BY chapter_name, subject
                 ORDER BY mistake_count DESC LIMIT 10`,
                [email]
            );
            const { rows: recentScores } = await pool.query(
                `SELECT gt.test_type, ta.score, ta.total,
                        ROUND((ta.score::float / NULLIF(ta.total,0)) * 100, 1) AS pct,
                        ta.submitted_at
                 FROM test_attempts ta
                 JOIN generated_tests gt ON ta.test_id = gt.id
                 WHERE ta.student_email = $1 AND gt.course_type = $2
                 ORDER BY ta.submitted_at DESC LIMIT 20`,
                [email, courseType]
            );
            res.json({ overall, weakChapters, recentScores });
        } catch (err) {
            res.status(500).json({ error: 'Server error.' });
        }
    });

    router.get('/api/bridge/faculty/pending-questions', authenticate, requireRole('faculty'), async (req, res) => {
        try {
            const { rows } = await pool.query(
                `SELECT q.*, u.name AS submitted_by_name
                 FROM question_bank q
                 LEFT JOIN users u ON u.email = q.submitted_by
                 WHERE q.status = 'pending'
                 ORDER BY q.created_at ASC`
            );
            res.json(rows);
        } catch (err) {
            res.status(500).json({ error: 'Server error.' });
        }
    });

    router.post('/api/bridge/faculty/approve-batch', authenticate, requireRole('faculty'), async (req, res) => {
        const { questionIds, action } = req.body;
        if (!Array.isArray(questionIds) || !['approve','reject'].includes(action))
            return res.status(400).json({ error: 'questionIds array and action required.' });

        const newStatus = action === 'approve' ? 'approved' : 'rejected';
        try {
            await pool.query(
                `UPDATE question_bank SET status=$1, approved_by=$2, approved_at=NOW() WHERE id = ANY($3)`,
                [newStatus, req.user.email, questionIds]
            );
            res.json({ success: true, updated: questionIds.length, status: newStatus });
        } catch (err) {
            res.status(500).json({ error: 'Server error.' });
        }
    });

    // ============================================================
    // CENTRALIZED CHAPTERS — course-aware CRUD (Course → Subject → Chapter)
    // This is distinct from the legacy /api/chapters (materials/lectures),
    // which isn't course-aware. These endpoints manage the same `chapters`
    // table but always scope by course_type, so faculty can build out the
    // Course → Subject → Chapter hierarchy for NEET and JEE independently
    // (e.g. add/remove a JEE Mathematics chapter without touching NEET).
    // ============================================================

    router.get('/api/qbank/chapters', authenticate, async (req, res) => {
        const { courseType, subject } = req.query;
        if (!courseType || !subject)
            return res.status(400).json({ error: 'courseType and subject are required.' });
        try {
            const { rows } = await pool.query(
                `SELECT id, course_type, subject, name, description, position
                 FROM chapters WHERE course_type = $1 AND subject = $2 ORDER BY position ASC`,
                [courseType, subject]
            );
            res.json(rows);
        } catch (err) {
            console.error(err);
            res.status(500).json({ error: 'Server error.' });
        }
    });

    router.post('/api/qbank/chapters', authenticate, requireRole('faculty'), async (req, res) => {
        const { courseType, subject, name, description } = req.body;
        if (!courseType || !subject || !name?.trim())
            return res.status(400).json({ error: 'courseType, subject, and name are required.' });
        if (!['NEET','JEE','BOTH'].includes(courseType))
            return res.status(400).json({ error: 'courseType must be NEET, JEE, or BOTH.' });

        try {
            const { rows: [maxPos] } = await pool.query(
                `SELECT COALESCE(MAX(position), -1) AS max_pos FROM chapters WHERE course_type = $1 AND subject = $2`,
                [courseType, subject]
            );
            const { rows: [chapter] } = await pool.query(
                `INSERT INTO chapters (course_type, subject, name, description, position, created_by)
                 VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
                [courseType, subject, name.trim(), description || null, parseInt(maxPos.max_pos, 10) + 1, req.user.email]
            );
            res.status(201).json({ success: true, chapter });
        } catch (err) {
            if (err.code === '23505') return res.status(409).json({ error: 'A chapter with this name already exists for this course/subject.' });
            console.error(err);
            res.status(500).json({ error: 'Server error while creating chapter.' });
        }
    });

    router.put('/api/qbank/chapters/:id', authenticate, requireRole('faculty'), async (req, res) => {
        const { name, description } = req.body;
        if (!name?.trim()) return res.status(400).json({ error: 'Chapter name is required.' });
        try {
            const { rows: [existing] } = await pool.query(`SELECT * FROM chapters WHERE id = $1`, [req.params.id]);
            if (!existing) return res.status(404).json({ error: 'Chapter not found.' });

            const { rows: [chapter] } = await pool.query(
                `UPDATE chapters SET name = $1, description = $2 WHERE id = $3 RETURNING *`,
                [name.trim(), description ?? existing.description, req.params.id]
            );

            // Keep question_bank rows for this chapter in sync so renaming
            // a chapter doesn't orphan its questions from the new name.
            if (name.trim() !== existing.name) {
                await pool.query(
                    `UPDATE question_bank SET chapter_name = $1
                     WHERE course_type = $2 AND subject = $3 AND chapter_name = $4`,
                    [name.trim(), existing.course_type, existing.subject, existing.name]
                );
            }
            res.json({ success: true, chapter });
        } catch (err) {
            if (err.code === '23505') return res.status(409).json({ error: 'A chapter with this name already exists for this course/subject.' });
            console.error(err);
            res.status(500).json({ error: 'Server error while updating chapter.' });
        }
    });

    // Deleting a chapter never deletes its questions — they stay in the
    // bank (still tagged with the old chapter_name) so no faculty work is
    // ever lost; only the chapter entry itself (used for combo-test pickers
    // and curriculum browsing) is removed.
    router.delete('/api/qbank/chapters/:id', authenticate, requireRole('faculty'), async (req, res) => {
        try {
            const { rowCount } = await pool.query(`DELETE FROM chapters WHERE id = $1`, [req.params.id]);
            if (rowCount === 0) return res.status(404).json({ error: 'Chapter not found.' });
            res.json({ success: true });
        } catch (err) {
            console.error(err);
            res.status(500).json({ error: 'Server error while deleting chapter.' });
        }
    });

    router.get('/api/bridge/curriculum', authenticate, async (req, res) => {
        const courseType = req.query.courseType;
        try {
            const where = courseType ? `WHERE course_type = $1` : '';
            const params = courseType ? [courseType] : [];
            const { rows } = await pool.query(
                `SELECT course_type, subject, name, position FROM chapters ${where} ORDER BY course_type, subject, position`,
                params
            );
            const result = {};
            for (const r of rows) {
                if (!result[r.course_type]) result[r.course_type] = {};
                if (!result[r.course_type][r.subject]) result[r.course_type][r.subject] = [];
                result[r.course_type][r.subject].push(r.name);
            }
            res.json(result);
        } catch (err) {
            res.status(500).json({ error: 'Server error.' });
        }
    });

    return router;
}

module.exports = { init };
