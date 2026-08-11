// ═══════════════════════════════════════════════════════════════════
// api/verify.js — Reference Intelligence Engine
// Verifies a single reference against CrossRef + OpenAlex.
// Correction suggestions are formatted via CSL, not Groq.
// ═══════════════════════════════════════════════════════════════════

import { formatSingle } from '../lib/formatter.js';
import { rateLimit } from './ratelimit.js';

const GROQ_API_KEY = process.env.GROQ_API_KEY;

// ── Extract a searchable query from a raw reference ────────────────
function extractSearchQuery(reference) {
    const text = reference.trim();

    // Try to find a DOI first — most reliable
    const doiMatch = text.match(/10\.\d{4,9}\/[^\s,;>\])"]+/);
    if (doiMatch) return { type: 'doi', value: doiMatch[0].replace(/[.,;)\]]+$/, '') };

    // Extract title from quotes
    const singleQuoted = text.match(/'([^']{15,})'/);
    if (singleQuoted) return { type: 'title', value: singleQuoted[1] };

    const doubleQuoted = text.match(/"([^"]{15,})"/);
    if (doubleQuoted) return { type: 'title', value: doubleQuoted[1] };

    // Extract year and author for a combined query
    const yearMatch = text.match(/\b((?:19|20)\d{2})\b/);
    const authorMatch = text.match(/^([A-Z][a-z]+)/);

    // Use the full text as a title search — CrossRef handles this well
    return { type: 'query', value: text.substring(0, 200) };
}

// ── CrossRef verification ──────────────────────────────────────────
async function verifyWithCrossRef(reference) {
    const query = extractSearchQuery(reference);

    try {
        let url;
        if (query.type === 'doi') {
            url = `https://api.crossref.org/works/${encodeURIComponent(query.value)}`;
            const r = await fetch(url);
            if (!r.ok) return null;
            const d = await r.json();
            return { source: 'CrossRef', item: d.message, score: 100 };
        } else {
            url = `https://api.crossref.org/works?query=${encodeURIComponent(query.value)}&rows=1`;
            const r = await fetch(url);
            if (!r.ok) return null;
            const d = await r.json();
            const item = d.message.items?.[0];
            if (!item || item.score < 3) return null;
            return { source: 'CrossRef', item, score: item.score };
        }
    } catch { return null; }
}

// ── OpenAlex verification fallback ────────────────────────────────
async function verifyWithOpenAlex(reference) {
    const query = extractSearchQuery(reference);
    try {
        const searchValue = query.type === 'doi'
            ? `https://doi.org/${query.value}`
            : query.value;
        const r = await fetch(`https://api.openalex.org/works?search=${encodeURIComponent(searchValue)}&per-page=1`);
        if (!r.ok) return null;
        const d = await r.json();
        const item = d.results?.[0];
        if (!item) return null;
        return { source: 'OpenAlex', item, score: 50 };
    } catch { return null; }
}

// ── Build CSL-JSON from CrossRef item ─────────────────────────────
function crossRefToCSL(item) {
    return {
        id: `verified_${Math.random().toString(36).substring(2, 9)}`,
        type: item.type === 'book-chapter' ? 'chapter' :
              item.type === 'book' ? 'book' :
              item.type === 'proceedings-article' ? 'paper-conference' : 'article-journal',
        author: item.author?.map(a => ({ family: a.family || '', given: a.given || '' })) || [],
        issued: { 'date-parts': [item.issued?.['date-parts']?.[0] || []] },
        title: item.title?.[0] || '',
        'container-title': item['container-title']?.[0] || '',
        volume: item.volume || undefined,
        issue: item.issue || undefined,
        page: item.page || undefined,
        DOI: item.DOI || undefined,
        publisher: item.publisher || undefined
    };
}

// ── Build CSL-JSON from OpenAlex item ────────────────────────────
function openAlexToCSL(item) {
    const doiClean = item.doi?.replace('https://doi.org/', '');
    return {
        id: `verified_${Math.random().toString(36).substring(2, 9)}`,
        type: 'article-journal',
        author: item.authorships?.map(a => {
            const name = a.author?.display_name || '';
            const parts = name.split(' ');
            return { family: parts.slice(-1)[0] || '', given: parts.slice(0, -1).join(' ') || '' };
        }) || [],
        issued: { 'date-parts': [[item.publication_year || new Date().getFullYear()]] },
        title: item.title || '',
        'container-title': item.primary_location?.source?.display_name || '',
        DOI: doiClean || undefined
    };
}

// ── Compare reference to verified data ────────────────────────────
function compareReference(original, verified, verifiedCsl) {
    const issues = [];

    // Check year
    const origYear = original.match(/\b((?:19|20)\d{2})\b/)?.[1];
    const verYear = String(verifiedCsl.issued?.['date-parts']?.[0]?.[0] || '');
    if (origYear && verYear && origYear !== verYear) {
        issues.push(`Year: found ${origYear} but database shows ${verYear}`);
    }

    // Check title similarity (rough check)
    const origTitle = (original.match(/'([^']{10,})'/) || original.match(/"([^"]{10,})"/))?.[1] || '';
    const verTitle = verifiedCsl.title || '';
    if (origTitle && verTitle) {
        const origNorm = origTitle.toLowerCase().replace(/\W/g, '');
        const verNorm = verTitle.toLowerCase().replace(/\W/g, '');
        if (origNorm.length > 10 && verNorm.length > 10) {
            const overlap = origNorm.substring(0, 20);
            if (!verNorm.includes(overlap) && !origNorm.includes(verNorm.substring(0, 20))) {
                issues.push(`Title mismatch: your reference has "${origTitle.substring(0, 50)}..." but database shows "${verTitle.substring(0, 50)}..."`);
            }
        }
    }

    return issues;
}

// ── Main handler ───────────────────────────────────────────────────
export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const ip = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown';
    const limit = rateLimit(ip, 'verify', 50);
    if (!limit.allowed) {
        return res.status(429).json({
            error: `Too many requests. Please wait ${limit.resetIn} minutes before trying again.`
        });
    }

    const { reference, format = 'Harvard' } = req.body;
    if (!reference) return res.status(400).json({ error: 'Missing reference' });

    try {
        // Try CrossRef first
        let verified = await verifyWithCrossRef(reference);
        let verifiedCsl = null;

        if (verified) {
            verifiedCsl = crossRefToCSL(verified.item);
        } else {
            // Fall back to OpenAlex
            verified = await verifyWithOpenAlex(reference);
            if (verified) {
                verifiedCsl = openAlexToCSL(verified.item);
            }
        }

        if (!verifiedCsl) {
            return res.status(200).json({
                result: `❌ NOT FOUND — ${reference}\n   Could not locate this reference in CrossRef or OpenAlex (370M+ records). Check author names, year and title carefully.`
            });
        }

        // Compare original to verified data
        const issues = compareReference(reference, verified, verifiedCsl);

        // Format the verified/corrected version via CSL
        let correctedFormatted = null;
        try {
            correctedFormatted = await formatSingle(verifiedCsl, format);
        } catch {
            correctedFormatted = null;
        }

        if (issues.length === 0) {
            // CONFIRMED
            const doiNote = verifiedCsl.DOI ? `\n   🔗 Verified DOI: ${verifiedCsl.DOI}` : '';
            return res.status(200).json({
                result: `✅ CONFIRMED — ${reference}\n   Source: ${verified.source}${doiNote}`
            });
        } else {
            // MISMATCH — show issues and corrected version
            const issueList = issues.map(i => `   • ${i}`).join('\n');
            const correctionNote = correctedFormatted
                ? `\n✏️ Suggested correction:\n   ${correctedFormatted}`
                : '';
            const doiNote = verifiedCsl.DOI ? `\n   🔗 DOI: ${verifiedCsl.DOI}` : '';
            return res.status(200).json({
                result: `⚠️ MISMATCH — ${reference}\n${issueList}${doiNote}${correctionNote}`
            });
        }

    } catch (err) {
        // Groq fallback for genuinely ambiguous references
        if (GROQ_API_KEY) {
            try {
                const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${GROQ_API_KEY}` },
                    body: JSON.stringify({
                        model: 'llama-3.3-70b-versatile',
                        max_tokens: 200,
                        messages: [{
                            role: 'system',
                            content: 'You are an academic reference checker. Briefly assess if this reference looks complete and correctly formatted. Return one line starting with ✅, ⚠️ or ❌.'
                        }, {
                            role: 'user',
                            content: reference
                        }]
                    })
                });
                const groqData = await groqRes.json();
                const groqResult = groqData.choices?.[0]?.message?.content?.trim();
                if (groqResult) {
                    return res.status(200).json({ result: groqResult });
                }
            } catch { /* groq also failed */ }
        }

        return res.status(200).json({
            result: `⚠️ ERROR checking — ${reference}\n   Could not connect to verification databases. Please try again.`
        });
    }
}
