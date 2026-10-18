// question_audit.js
// ---------------------------------------------------------------------------
// Structural / hygiene checks for question-bank rows. Used three ways:
//   1. `npm run audit:questions` (scripts/audit_questions.js) — run in CI or a
//      git pre-commit hook; exits non-zero if the imported bank has errors.
//   2. importRealQuestions() in db.js — rows with hard errors are skipped (and
//      reported) instead of being served to students with a wrong key.
//   3. Tests.
//
// Errors are things that make a question unanswerable or misleading. Warnings
// are heuristics for a human reviewer (they can't prove a key is wrong).
// ---------------------------------------------------------------------------

// Wording that shows the explanation was written before the author had
// settled on an answer. Anything matching is almost certainly a wrong or
// unreviewed key.
const UNCERTAINTY_RE = /\b(hmm+|let me|let'?s (recheck|see|try)|re-?check|re-?evaluat\w*|wait[,.! ]|oops|options? seem|none (of (the )?above )?match|i'?ll (set|keep|go with)|maybe|not sure|closest:|index \d|answer\s*:\s*[a-d]\b)/i;

// Options that refer to other options by letter break as soon as options are
// reordered ("Both (a) and (b)", "Both B and C"). Self-contained wording such
// as "All of these" is fine; the serving layer pins those to the end.
const LETTER_REF_RE = /\([a-d]\)|\boption\s+[a-d]\b|\bboth\s+[a-d]\s+(and|&)\s+[a-d]\b|\b(and|or)\s+\([a-d]\)/;

const JUNK_EXPLANATION_RE = /[=\-]{10,}|^\s*Explanation:|\b(EASY|MODERATE|DIFFICULT)\s*$/;

const norm = s => String(s).toLowerCase().replace(/[\s,]/g, '');

function auditRow(q) {
    const errors = [];
    const warnings = [];
    const opts = [q.option_a, q.option_b, q.option_c, q.option_d];

    if (!q.question_text || !String(q.question_text).trim()) errors.push('empty question text');
    if (!['A', 'B', 'C', 'D'].includes(q.correct_answer)) errors.push(`invalid correct_answer "${q.correct_answer}"`);
    if (opts.some(o => o === null || o === undefined || !String(o).trim())) errors.push('empty option');
    else if (new Set(opts.map(norm)).size < 4) errors.push('duplicate options');

    if (opts.some(o => LETTER_REF_RE.test(String(o)))) errors.push('option refers to other options by letter');
    if (opts.some(o => /[\]\}]\s*$/.test(String(o)) && !/[\[\{]/.test(String(o)))) errors.push('option has a stray closing bracket');

    const exp = q.explanation;
    if (exp) {
        if (UNCERTAINTY_RE.test(exp)) errors.push('explanation contains uncertainty/working-out wording');
        if (JUNK_EXPLANATION_RE.test(exp)) errors.push('explanation contains separator / prefix / difficulty-tag junk');

        // Heuristic: explanation quotes another option's text but not the keyed one.
        const e = norm(exp);
        const keyIdx = 'ABCD'.indexOf(q.correct_answer);
        if (keyIdx >= 0 && opts[keyIdx] && norm(opts[keyIdx]).length >= 3) {
            const keyed = e.includes(norm(opts[keyIdx]));
            const others = opts.map((o, i) => (i !== keyIdx && norm(o).length >= 3 && e.includes(norm(o)) ? i : -1)).filter(i => i >= 0);
            if (!keyed && others.length === 1) warnings.push(`explanation quotes option ${'ABCD'[others[0]]} but the key is ${q.correct_answer}`);
        }
    }
    return { errors, warnings };
}

function auditRows(rows) {
    const bad = [];
    const warn = [];
    rows.forEach((q, i) => {
        const r = auditRow(q);
        if (r.errors.length) bad.push({ index: i, q, errors: r.errors });
        if (r.warnings.length) warn.push({ index: i, q, warnings: r.warnings });
    });
    return { bad, warn };
}

module.exports = { auditRow, auditRows, UNCERTAINTY_RE, LETTER_REF_RE };