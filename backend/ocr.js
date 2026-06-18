// ocr.js — NEET CTK IGNITION
// OCR-based test upload (Faculty Module enhancement #2).
//
// Pipeline:
//   1. Raw text extraction
//        - Images (PNG/JPG/WEBP)  -> Tesseract.js (pure JS/WASM OCR, no
//          native system dependencies, runs anywhere Node.js runs).
//        - PDFs                   -> pdf-parse (reads embedded/selectable
//          text). Scanned PDFs with no embedded text are explicitly
//          rejected with a friendly message asking for an image upload
//          instead, rather than silently producing nothing — rasterising
//          PDF pages to images for OCR would require native system
//          libraries (e.g. poppler/ghostscript) that aren't reliably
//          available across every free hosting tier this project targets.
//   2. Structuring raw text into {questionText, options, correctAnswerIndex}
//      - Primary: the same free Hugging Face Inference API already used
//        elsewhere in this project (ai.js / research.js) is asked to
//        return strict JSON. This handles messy OCR text far better than
//        regex ever could.
//      - Fallback (no HF_TOKEN configured, or the AI call/JSON parse
//        fails for any reason): a deterministic regex-based parser that
//        recognises common question/option/answer-key layouts.
//   3. Nothing is written to the database here — this module only
//      produces a preview that the faculty member reviews/edits in the
//      UI before confirming (server.js then reuses the existing
//      POST /api/faculty/tests endpoint to actually save).

const { createWorker } = require('tesseract.js');
const { PDFParse } = require('pdf-parse');

const HF_TOKEN = process.env.HF_TOKEN;
const HF_MODEL = process.env.HF_MODEL || 'mistralai/Mistral-7B-Instruct-v0.3';
const HF_URL = `https://api-inference.huggingface.co/models/${HF_MODEL}`;

// ---------------------------------------------------------------------------
// STEP 1 — RAW TEXT EXTRACTION
// ---------------------------------------------------------------------------
async function extractTextFromImage(buffer) {
    const worker = await createWorker('eng');
    try {
        const { data } = await worker.recognize(buffer);
        return data.text || '';
    } finally {
        await worker.terminate().catch(() => {});
    }
}

async function extractTextFromPdf(buffer) {
    const parser = new PDFParse({ data: buffer });
    try {
        const result = await parser.getText();
        return result.text || '';
    } finally {
        await parser.destroy().catch(() => {});
    }
}

// Heuristic used to flag PDFs/images that produced essentially no usable
// text (e.g. a scanned PDF with no embedded text layer, or a blank/blurry
// photo), so we can fail fast with a clear, actionable message instead of
// silently returning zero questions.
function looksEmpty(text) {
    return (text || '').replace(/\s+/g, '').length < 25;
}

// ---------------------------------------------------------------------------
// STEP 2a — AI-ASSISTED STRUCTURING (preferred path)
// ---------------------------------------------------------------------------
function safeParseJsonArray(text) {
    if (!text) return null;
    let cleaned = text.trim().replace(/^```json/i, '').replace(/^```/, '').replace(/```$/, '').trim();
    const start = cleaned.indexOf('[');
    const end = cleaned.lastIndexOf(']');
    if (start === -1 || end === -1 || end < start) return null;
    cleaned = cleaned.slice(start, end + 1);
    try {
        const parsed = JSON.parse(cleaned);
        return Array.isArray(parsed) ? parsed : null;
    } catch (_) {
        return null;
    }
}

function normaliseAiQuestions(rawArr) {
    if (!Array.isArray(rawArr)) return [];
    const out = [];
    for (const item of rawArr) {
        if (!item || typeof item !== 'object') continue;
        const questionText = (item.questionText || item.question || item.text || '').toString().trim();
        if (!questionText) continue;
        const options = Array.isArray(item.options) ? item.options.map(o => (o ?? '').toString().trim()).filter(Boolean) : [];
        let correctAnswerIndex = null;
        if (typeof item.correctAnswerIndex === 'number' && item.correctAnswerIndex >= 0 && item.correctAnswerIndex < options.length) {
            correctAnswerIndex = item.correctAnswerIndex;
        } else if (typeof item.correctAnswer === 'string') {
            const letterIdx = 'ABCD'.indexOf(item.correctAnswer.trim().toUpperCase());
            if (letterIdx !== -1 && letterIdx < options.length) correctAnswerIndex = letterIdx;
        }
        out.push({
            questionText,
            options,
            correctAnswerIndex,
            topic: (item.topic || '').toString().trim() || null,
            difficulty: ['Easy', 'Medium', 'Hard'].includes(item.difficulty) ? item.difficulty : 'Medium',
            needsReview: correctAnswerIndex === null || options.length < 2
        });
    }
    return out;
}

async function structureWithAI(rawText) {
    if (!HF_TOKEN) return null;
    try {
        const truncated = rawText.slice(0, 6000);
        const prompt = `You are extracting multiple-choice exam questions from raw OCR/PDF text for a Physics test bank. The text may contain OCR noise, broken lines, and stray characters — use your judgement to reconstruct the intended question.

Raw text:
"""
${truncated}
"""

Return ONLY a JSON array (no markdown, no commentary, no code fences) where each element has this exact shape:
{"questionText": string, "options": string[] (2 to 5 items), "correctAnswerIndex": number or null (0-based index into options, or null if the correct answer cannot be determined from the text), "topic": string or null, "difficulty": "Easy" | "Medium" | "Hard"}

If the text contains no extractable questions, return [].`;

        const response = await fetch(HF_URL, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${HF_TOKEN}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                inputs: prompt,
                parameters: { max_new_tokens: 1800, temperature: 0.2, return_full_text: false }
            })
        });

        if (!response.ok) {
            console.warn(`HF inference returned ${response.status} during OCR structuring; falling back to rule-based parser.`);
            return null;
        }

        const data = await response.json();
        const text = Array.isArray(data) ? (data[0]?.generated_text || '') : (data.generated_text || '');
        const parsed = safeParseJsonArray(text);
        if (!parsed) return null;
        const normalised = normaliseAiQuestions(parsed);
        return normalised.length > 0 ? normalised : null;
    } catch (err) {
        console.warn('AI-assisted OCR structuring failed, using rule-based fallback:', err.message);
        return null;
    }
}

// ---------------------------------------------------------------------------
// STEP 2b — RULE-BASED FALLBACK PARSER (always available, no API key needed)
// Recognises common layouts:
//   1. Question text...            Q1) Question text...
//   A) option                      a. option
//   B) option                      b. option
//   ...                            ...
//   Answer: B                      Ans: b
// Also recognises a trailing answer-key block like "1-A 2-C 3-B" or
// "1. A  2. C  3. B" and applies it by question position when no inline
// answer was found for that question.
// ---------------------------------------------------------------------------
const QUESTION_START_RE = /^\s*(?:Q[\s.\-]?)?(\d{1,3})\s*[\.\):]\s+/;
const OPTION_LINE_RE = /^\s*[\(\[]?([A-Da-d])[\)\.\]:]\s*(.+?)\s*$/;
// Deliberately does NOT include the bare word "key" — that's reserved for
// detecting a trailing "Answer Key" block (see ANSWER_KEY_HEADING_RE below)
// and including it here causes false positives when such a block ends up
// appended to the last question (it has no following question to end it).
const INLINE_ANSWER_RE = /(?:correct\s*answer|answer|ans)\s*[:\-]?\s*\(?\s*([A-Da-d]|[1-4])\s*\)?/i;
const ANSWER_KEY_HEADING_RE = /answer\s*key|key\s*:/i;
// A "key line" is one that's essentially just a list of "number-letter"
// pairs (e.g. "1-B, 2-B" or "1. A  2. C"), as opposed to genuine question
// text — used to strip such lines out before block-splitting so they don't
// get absorbed into (and corrupt) the preceding/last question's block.
const KEY_LINE_RE = /^(?:\(?\d{1,3}\)?\s*[\.\-\):]\s*[A-Da-d][\s,;]*)+$/;

function letterOrNumberToIndex(token, optionCount) {
    if (!token) return null;
    const upper = token.toUpperCase();
    const letterIdx = 'ABCD'.indexOf(upper);
    if (letterIdx !== -1 && letterIdx < optionCount) return letterIdx;
    const num = parseInt(token, 10);
    if (!Number.isNaN(num) && num >= 1 && num <= optionCount) return num - 1;
    return null;
}

function parseAnswerKeyBlock(text) {
    // Matches sequences like "1-A, 2-C, 3-B" or "1. A   2. B   3. D"
    const map = {};
    const re = /(\d{1,3})\s*[\.\-\):]\s*([A-Da-d])\b/g;
    let m;
    while ((m = re.exec(text)) !== null) {
        map[parseInt(m[1], 10)] = m[2].toUpperCase();
    }
    return map;
}

function parseQuestionsRuleBased(rawText) {
    const allLines = rawText.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);

    // Try to isolate a trailing "answer key" section (common in printed
    // papers) by looking for a line containing the word "answer key" (or a
    // heading ending in "key:"), in the LAST quarter of the doc.
    let answerKeyMap = {};
    const tailStart = Math.floor(allLines.length * 0.75);
    const tailText = allLines.slice(tailStart).join(' ');
    if (ANSWER_KEY_HEADING_RE.test(tailText)) {
        answerKeyMap = parseAnswerKeyBlock(tailText);
    }

    // Strip out the heading line and any pure "number-letter" key lines so
    // they can't get absorbed into the last question's block during
    // splitting below.
    const lines = allLines.filter(l => !ANSWER_KEY_HEADING_RE.test(l) && !KEY_LINE_RE.test(l));

    const blocks = [];
    let current = null;
    for (const line of lines) {
        const qMatch = line.match(QUESTION_START_RE);
        if (qMatch) {
            if (current) blocks.push(current);
            current = { number: parseInt(qMatch[1], 10), lines: [line.replace(QUESTION_START_RE, '')] };
        } else if (current) {
            current.lines.push(line);
        }
    }
    if (current) blocks.push(current);

    const questions = [];
    for (const block of blocks) {
        const optionLines = [];
        const textLines = [];
        let inlineAnswerToken = null;

        for (const line of block.lines) {
            const ansMatch = line.match(INLINE_ANSWER_RE);
            const optMatch = line.match(OPTION_LINE_RE);
            if (ansMatch && !optMatch) {
                inlineAnswerToken = ansMatch[1];
                continue;
            }
            if (optMatch) {
                optionLines.push({ label: optMatch[1].toUpperCase(), text: optMatch[2].replace(INLINE_ANSWER_RE, '').trim() });
            } else if (optionLines.length === 0) {
                textLines.push(line);
            }
        }

        const questionText = textLines.join(' ').trim();
        if (!questionText) continue;

        // De-duplicate options by label, preserve first-seen order, cap at 5.
        const seen = new Set();
        const options = [];
        for (const o of optionLines) {
            if (seen.has(o.label) || !o.text) continue;
            seen.add(o.label);
            options.push(o.text);
        }
        if (options.length < 2) continue; // not enough structure to trust this as an MCQ

        let correctAnswerIndex = letterOrNumberToIndex(inlineAnswerToken, options.length);
        if (correctAnswerIndex === null && answerKeyMap[block.number]) {
            correctAnswerIndex = letterOrNumberToIndex(answerKeyMap[block.number], options.length);
        }

        questions.push({
            questionText,
            options,
            correctAnswerIndex,
            topic: null,
            difficulty: 'Medium',
            needsReview: correctAnswerIndex === null || options.length < 2
        });
    }

    return questions;
}

// ---------------------------------------------------------------------------
// TOP-LEVEL ORCHESTRATOR
// ---------------------------------------------------------------------------
const SUPPORTED_IMAGE_MIME = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/webp']);

async function extractQuestionsFromFile(buffer, mimeType, originalName) {
    let rawText = '';
    let sourceKind = '';

    if (mimeType === 'application/pdf') {
        sourceKind = 'pdf';
        try {
            rawText = await extractTextFromPdf(buffer);
        } catch (err) {
            return { success: false, error: `Could not read this PDF (${err.message}). Try re-exporting it or uploading page images instead.` };
        }
        if (looksEmpty(rawText)) {
            return {
                success: false,
                error: 'This PDF has no selectable/embedded text (it looks like a scanned image). Please upload the page(s) as PNG/JPG images instead so OCR can read them, or use manual question entry.'
            };
        }
    } else if (SUPPORTED_IMAGE_MIME.has(mimeType)) {
        sourceKind = 'image';
        try {
            rawText = await extractTextFromImage(buffer);
        } catch (err) {
            return { success: false, error: `OCR failed to process this image (${err.message}). Try a clearer, well-lit photo or scan.` };
        }
        if (looksEmpty(rawText)) {
            return { success: false, error: 'No readable text could be detected in this image. Try a clearer, higher-resolution photo or scan, or use manual question entry.' };
        }
    } else {
        return { success: false, error: 'Unsupported file type for OCR upload. Please upload a PDF or an image (PNG, JPG, WEBP).' };
    }

    let questions = await structureWithAI(rawText);
    let method = 'ai-assisted';
    if (!questions) {
        questions = parseQuestionsRuleBased(rawText);
        method = 'rule-based';
    }

    if (questions.length === 0) {
        return {
            success: false,
            error: 'Text was extracted, but no questions could be identified in a recognisable format (numbered question + lettered options). You can still copy the raw extracted text below into manual question entry.',
            rawText
        };
    }

    return { success: true, sourceKind, method, fileName: originalName, questions, rawTextPreview: rawText.slice(0, 4000) };
}

module.exports = { extractQuestionsFromFile, parseQuestionsRuleBased, structureWithAI };
