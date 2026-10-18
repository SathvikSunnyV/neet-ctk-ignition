// options.js — per-test option ordering for the Bridge test engine.
// ---------------------------------------------------------------------------
// generated_test_questions.option_order stores a permutation of [0,1,2,3]:
// DISPLAY slot i (A,B,C,D) shows ORIGINAL option perm[i]. The server presents
// options in display order and translates answers back to ORIGINAL letters, so
// everything else (question_bank.correct_answer, mistakes, analytics, stored
// test_attempts.answers) keeps working in original letters, and the frontend
// needs no change: it just renders option_a..option_d and returns the letter
// the student saw.
// ---------------------------------------------------------------------------

const LETTERS = ['A', 'B', 'C', 'D'];
const IDENTITY = [0, 1, 2, 3];

// "All of these" / "None of the above" only make sense in last place.
const PINNED_LAST_RE = /^\s*(all|none)\s+of\s+(these|the\s+above)\.?\s*$|^\s*none\.?\s*$/i;
// Assertion–Reason questions use a conventional fixed option list.
const ASSERTION_REASON_RE = /assertion\s*\(?a\)?|\bboth\s+a\s*(&|and)\s*r\b|a\s*(&|and)\s*r\b.*\b(true|false)\b/i;

function isValidPermutation(p) {
    return Array.isArray(p) && p.length === 4 && [0, 1, 2, 3].every(i => p.includes(i));
}

function parseOrder(raw) {
    let p = raw;
    if (typeof p === 'string') { try { p = JSON.parse(p); } catch (_) { p = null; } }
    return isValidPermutation(p) ? p.map(Number) : IDENTITY.slice();
}

/**
 * The order actually used for a question: the stored permutation, adjusted so
 * that Assertion–Reason questions keep their conventional order and
 * "All/None of these" options stay last. Deterministic in (stored order, option
 * texts), so serving and grading always agree.
 */
function effectiveOrder(rawOrder, q) {
    const opts = [q.option_a, q.option_b, q.option_c, q.option_d];
    if (opts.some(o => ASSERTION_REASON_RE.test(String(o)))) return IDENTITY.slice();
    const perm = parseOrder(rawOrder);
    const pinned = perm.filter(i => PINNED_LAST_RE.test(String(opts[i])));
    if (!pinned.length) return perm;
    return perm.filter(i => !pinned.includes(i)).concat(pinned.sort((a, b) => a - b));
}

/** Copy of q with option_a..d rearranged into display order. */
function presentQuestion(q, rawOrder) {
    const order = effectiveOrder(rawOrder, q);
    const opts = [q.option_a, q.option_b, q.option_c, q.option_d];
    return { ...q, option_a: opts[order[0]], option_b: opts[order[1]], option_c: opts[order[2]], option_d: opts[order[3]] };
}

/** Letter the student saw (display) -> original letter. Unknown input -> null. */
function displayToOriginal(displayLetter, order) {
    const slot = LETTERS.indexOf(String(displayLetter || '').toUpperCase());
    if (slot < 0) return null;
    return LETTERS[order[slot]];
}

/** Original letter -> the letter it is displayed under. */
function originalToDisplay(originalLetter, order) {
    const orig = LETTERS.indexOf(originalLetter);
    if (orig < 0) return null;
    return LETTERS[order.indexOf(orig)];
}

module.exports = { effectiveOrder, presentQuestion, displayToOriginal, originalToDisplay, parseOrder, LETTERS };