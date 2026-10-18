#!/usr/bin/env node
// Usage: npm run audit:questions [-- --raw] [-- --warnings]
//   --raw        audit the ORIGINAL import instead of the corrected bank (shows what was wrong)
//   --warnings   also print heuristic warnings (key/explanation disagreements) for human review
const { REAL_IMPORTED_QUESTIONS, RAW_IMPORTED_QUESTIONS } = require('../real_imported_questions');
const { auditRows } = require('../question_audit');

const useRaw = process.argv.includes('--raw');
const showWarnings = process.argv.includes('--warnings');
const rows = useRaw ? RAW_IMPORTED_QUESTIONS : REAL_IMPORTED_QUESTIONS;
const { bad, warn } = auditRows(rows);

const bySubject = {};
rows.forEach(q => { const k = `${q.course_type}/${q.subject}`; bySubject[k] = (bySubject[k] || 0) + 1; });
console.log(`Audited ${rows.length} ${useRaw ? 'RAW' : 'corrected'} rows`, bySubject);

for (const b of bad) {
    console.log(`ERROR  #${b.index} [${b.q.course_type}/${b.q.subject}] ${String(b.q.question_text).slice(0, 80)}\n       -> ${b.errors.join('; ')}`);
}
if (showWarnings) {
    for (const w of warn) console.log(`WARN   #${w.index} [${w.q.course_type}/${w.q.subject}] ${String(w.q.question_text).slice(0, 80)}\n       -> ${w.warnings.join('; ')}`);
}
console.log(`\n${bad.length} row(s) with errors, ${warn.length} row(s) with warnings${showWarnings ? '' : ' (use --warnings to list)'}`);
process.exit(bad.length ? 1 : 0);