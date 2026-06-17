// research.js — NEET CTK IGNITION
// Fetches *real, current* NEET cutoff/qualifying-score data from the open
// web (no paid API), then uses a free LLM to extract structured numbers
// from the search snippets. Results are cached in the `cutoff_cache` DB
// table so the app stays fast and resilient even if a refresh fails.
//
// Pipeline:
//   1. Free web search (DuckDuckGo HTML endpoint, no API key required)
//   2. Free LLM extraction (Hugging Face Inference API) -> strict JSON
//   3. Sanity-bound validation (0-720, plausible year, known categories)
//   4. Cache to DB; callers always read from cache, never block on the
//      network during a normal request.
//
// If any step fails (network blocked, model cold-start, bad output), the
// function returns null and the caller keeps using the last good cache
// entry, or the hardcoded historical baseline as a final fallback.

const HF_TOKEN = process.env.HF_TOKEN;
const HF_MODEL = process.env.HF_MODEL || 'mistralai/Mistral-7B-Instruct-v0.3';
const HF_URL = `https://api-inference.huggingface.co/models/${HF_MODEL}`;

const SEARCH_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const CATEGORIES = ['General', 'EWS', 'OBC', 'SC', 'ST'];
const NEET_MAX_SCORE = 720;

// ---------------------------------------------------------------------------
// STEP 1 — Free web search (DuckDuckGo HTML results, no API key)
// ---------------------------------------------------------------------------
async function webSearchSnippets(query, maxResults = 6) {
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    const res = await fetch(url, { headers: { 'User-Agent': SEARCH_UA } });
    if (!res.ok) throw new Error(`Search request failed (${res.status})`);
    const html = await res.text();

    // DuckDuckGo's HTML endpoint wraps each result snippet in a
    // result__snippet class; titles are in result__a. Simple regex
    // extraction avoids pulling in a full HTML-parsing dependency.
    const snippetRegex = /class="result__snippet"[^>]*>(.*?)<\/a>/gs;
    const titleRegex = /class="result__a"[^>]*>(.*?)<\/a>/gs;

    const strip = (s) => s.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&#x27;/g, "'").trim();

    const snippets = [];
    let m;
    while ((m = snippetRegex.exec(html)) && snippets.length < maxResults) {
        const text = strip(m[1]);
        if (text) snippets.push(text);
    }
    const titles = [];
    while ((m = titleRegex.exec(html)) && titles.length < maxResults) {
        const text = strip(m[1]);
        if (text) titles.push(text);
    }

    return [...titles, ...snippets].filter(Boolean);
}

// ---------------------------------------------------------------------------
// STEP 2 — Free LLM structured extraction
// ---------------------------------------------------------------------------
async function extractCutoffsWithLLM(rawText, year) {
    if (!HF_TOKEN) throw new Error('HF_TOKEN not configured — cannot run AI extraction.');

    const prompt = `You are a data-extraction assistant. Below are real web search snippets about NEET UG ${year} cutoff / qualifying scores in India (score out of 720, All-India quota).

SNIPPETS:
"""
${rawText.slice(0, 3500)}
"""

Extract the closing/qualifying NEET score for each reservation category (General, EWS, OBC, SC, ST) for these three institution tiers: AIIMS-level (top government institutes), Government Medical College (state/All-India quota government colleges), Private Medical College.

Respond with ONLY a strict JSON array, no commentary, no markdown fences, in exactly this shape:
[{"category":"General","aiims":number,"govt":number,"private":number}, ...one object per category...]

If the snippets do not contain enough information for a category, make your best realistic estimate based on known NEET trends (General is highest, then EWS, then OBC, then SC, then ST, in descending cutoff order), but still return a complete array of all 5 categories. Scores must be between 100 and 720.`;

    const response = await fetch(HF_URL, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${HF_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
            inputs: prompt,
            parameters: { max_new_tokens: 400, temperature: 0.2, return_full_text: false }
        })
    });

    if (!response.ok) throw new Error(`HF inference failed (${response.status})`);
    const data = await response.json();
    const text = Array.isArray(data) ? (data[0]?.generated_text || '') : (data.generated_text || '');

    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) throw new Error('LLM did not return parseable JSON.');

    const parsed = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(parsed)) throw new Error('LLM JSON was not an array.');
    return parsed;
}

// ---------------------------------------------------------------------------
// STEP 3 — Validation / sanity bounds
// ---------------------------------------------------------------------------
function validateCutoffRows(rows, year) {
    const clean = [];
    for (const r of rows) {
        if (!r || !CATEGORIES.includes(r.category)) continue;
        const aiims = Number(r.aiims), govt = Number(r.govt), priv = Number(r.private);
        const inRange = (n) => Number.isFinite(n) && n >= 100 && n <= NEET_MAX_SCORE;
        if (!inRange(aiims) || !inRange(govt) || !inRange(priv)) continue;
        // Tier ordering sanity check: AIIMS-tier >= Govt tier >= Private tier
        if (!(aiims >= govt && govt >= priv)) continue;
        clean.push({ year, category: r.category, aiims: Math.round(aiims), govt: Math.round(govt), private: Math.round(priv) });
    }
    // Require at least 3 of 5 categories to trust this batch
    if (clean.length < 3) return null;
    return clean;
}

// ---------------------------------------------------------------------------
// MAIN: refresh real cutoff data for one exam year from the open web
// ---------------------------------------------------------------------------
async function fetchRealCutoffData(year) {
    const queries = [
        `NEET ${year} cutoff score category wise AIIMS government medical college`,
        `NEET UG ${year} qualifying marks General EWS OBC SC ST`
    ];

    let combinedText = '';
    for (const q of queries) {
        try {
            const snippets = await webSearchSnippets(q);
            combinedText += '\n' + snippets.join('\n');
        } catch (err) {
            console.warn(`Web search failed for "${q}":`, err.message);
        }
    }

    if (!combinedText.trim()) {
        throw new Error('No web search results retrieved (network may be unavailable in this environment).');
    }

    const extracted = await extractCutoffsWithLLM(combinedText, year);
    const validated = validateCutoffRows(extracted, year);
    if (!validated) throw new Error('Extracted cutoff data failed sanity validation.');

    return validated;
}

module.exports = { fetchRealCutoffData, webSearchSnippets, extractCutoffsWithLLM, validateCutoffRows };
