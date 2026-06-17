// ai.js — NEET CTK IGNITION
// Optional AI layer for generating personalized study recommendations.
//
// Uses the FREE Hugging Face Inference API (https://huggingface.co/) when
// HF_TOKEN is configured. If no token is set, or the call fails for any
// reason (rate limit, model cold-start, network), it transparently falls
// back to the deterministic rule-based recommender — so the feature never
// breaks the app and never depends on a paid API key.

const HF_TOKEN = process.env.HF_TOKEN;
const HF_MODEL = process.env.HF_MODEL || 'mistralai/Mistral-7B-Instruct-v0.3';
const HF_URL = `https://api-inference.huggingface.co/models/${HF_MODEL}`;

/**
 * Rule-based fallback recommendation (always available, fully deterministic,
 * driven by the student's real mistake-log data — nothing hardcoded about
 * the student).
 */
function ruleBasedRecommendation(row) {
    const { subject, topic, mistakeType, count } = row;
    switch (mistakeType) {
        case 'memory':
            return `Revise key facts, definitions and NCERT lines for "${topic}" (${subject}) — ${count} memory-based error(s) logged.`;
        case 'conceptual':
            return `Re-watch a foundational lecture on "${topic}" (${subject}) and rebuild the concept from first principles — ${count} conceptual error(s) logged.`;
        case 'unattempted':
            return `You're skipping questions on "${topic}" (${subject}) — practise more MCQs here to build attempt confidence (${count} unattempted).`;
        default:
            return `Practise additional problems on "${topic}" (${subject}) — ${count} mistake(s) logged here recently.`;
    }
}

/**
 * Generate recommendations for a list of mistake rows
 * [{ subject, topic, mistakeType, count }], using the free Hugging Face
 * model if configured, otherwise the rule-based fallback.
 *
 * Returns: [{ subject, topic, recommendation }]
 */
async function generateRecommendations(rows) {
    const fallback = rows.map(r => ({
        subject: r.subject, topic: r.topic, recommendation: ruleBasedRecommendation(r)
    }));

    if (!HF_TOKEN || rows.length === 0) return fallback;

    try {
        const summary = rows.map(r =>
            `${r.subject} - ${r.topic}: ${r.count} ${r.mistakeType} mistake(s)`
        ).join('\n');

        const prompt = `You are an expert NEET (medical entrance exam) tutor. A student has the following recent mistake patterns from their test attempts:\n${summary}\n\nFor each line, write ONE short, specific, actionable study tip (max 20 words) telling the student exactly what to do next. Return only the tips, one per line, in the same order, with no numbering or extra commentary.`;

        const response = await fetch(HF_URL, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${HF_TOKEN}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                inputs: prompt,
                parameters: { max_new_tokens: 220, temperature: 0.4, return_full_text: false }
            })
        });

        if (!response.ok) {
            console.warn(`HF inference returned ${response.status}; using rule-based recommendations.`);
            return fallback;
        }

        const data = await response.json();
        const text = Array.isArray(data) ? (data[0]?.generated_text || '') : (data.generated_text || '');
        const lines = text.split('\n').map(l => l.replace(/^[\-\d.\s]+/, '').trim()).filter(Boolean);

        if (lines.length === 0) return fallback;

        return rows.map((r, i) => ({
            subject: r.subject,
            topic: r.topic,
            recommendation: lines[i] || ruleBasedRecommendation(r)
        }));
    } catch (err) {
        console.warn('AI recommendation generation failed, using rule-based fallback:', err.message);
        return fallback;
    }
}

module.exports = { generateRecommendations, ruleBasedRecommendation, generatePhysicsRecommendations };

// ---------------------------------------------------------------------------
// PHYSICS STUDENT MODULE — personalised Physics recommendations
// (Section 7 of the Physics Student Module spec). Deterministic and driven
// entirely by the student's own topic accuracy — nothing hardcoded.
// ---------------------------------------------------------------------------
function generatePhysicsRecommendations(topicStats) {
    // topicStats: [{ topic, accuracy, weakestTermLabel }]
    return topicStats.map(t => {
        const actions = [];
        if (t.accuracy < 75) actions.push('Review Term 1 conceptual materials');
        actions.push(`Revise the Term 2 formula sheet for "${t.topic}"`);
        actions.push(`Watch the related Physics lecture on "${t.topic}"`);
        actions.push('Attempt a fresh practice test on this topic');
        return {
            topic: t.topic,
            accuracy: t.accuracy,
            message: `Your accuracy in ${t.topic} is ${t.accuracy}%.`,
            actions
        };
    });
}
