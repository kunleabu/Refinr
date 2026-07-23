// ═══════════════════════════════════════════════════════════════════
// api/clean.js — Reference Intelligence Engine
// Complete pipeline: split → deduplicate → extract metadata →
// format via CSL → quality check → return
//
// AI usage: Groq called ONLY for entries where rules-based metadata
// extraction confidence is below 40% AND only to extract structured
// fields (not to format). Formatting is always CSL/citeproc-js.
//
// Special modes:
//   'Clean and alphabetize only' → no reformatting, just sort + dedup
//   'Number my references'       → sort + dedup + sequential numbers
// ═══════════════════════════════════════════════════════════════════

import { extractMetadata } from './lib/metadata.js';
import { formatReferenceList } from './lib/formatter.js';
import { detectDuplicates, alphabetise, numberReferences, splitIntoReferences, separateIdentifiers, checkListQuality } from './lib/rules.js';
import { rateLimit } from './ratelimit.js';

const GROQ_API_KEY = process.env.GROQ_API_KEY;

// ── Groq: extract structured fields from ambiguous reference ───────
// Called only when rules-based extraction confidence < 40%.
// Returns a CSL-JSON object or null if Groq also fails.
async function extractFieldsWithGroq(rawReference) {
    try {
        const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${GROQ_API_KEY}`
            },
            body: JSON.stringify({
                model: 'llama-3.3-70b-versatile',
                temperature: 0,
                max_tokens: 400,
                messages: [
                    {
                        role: 'system',
                        content: 'You are an academic metadata extractor. Extract bibliographic fields from the reference string and return ONLY a JSON object with these fields (omit any you cannot find): {"type": "article-journal|book|chapter|paper-conference|thesis|webpage", "author": [{"family": "...", "given": "..."}], "issued": {"date-parts": [[year]]}, "title": "...", "container-title": "...", "volume": "...", "issue": "...", "page": "...", "DOI": "...", "URL": "...", "publisher": "...", "publisher-place": "..."}. Return ONLY the JSON object, no other text.'
                    },
                    {
                        role: 'user',
                        content: `Extract bibliographic fields from this reference:\n${rawReference}`
                    }
                ]
            })
        });

        if (!response.ok) return null;

        const data = await response.json();
        const raw = data.choices?.[0]?.message?.content?.trim();
        if (!raw) return null;

        const cleaned = raw.replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim();
        const parsed = JSON.parse(cleaned);

        // Attach an ID for citeproc
        parsed.id = `ref_groq_${Math.random().toString(36).substring(2, 9)}`;
        return parsed;

    } catch {
        return null;
    }
}

// ── Resolve inline identifiers (DOIs/ISBNs) ───────────────────────
// Some users paste bare DOIs or ISBNs alongside full references.
// We resolve these via CrossRef/OpenLibrary so they become full
// CSL-JSON objects that can go through the same formatting pipeline.
async function resolveIdentifier(identifier) {
    const cleaned = identifier.trim().replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '');

    // DOI
    if (/^10\.\d{4,9}\//.test(cleaned)) {
        try {
            const r = await fetch(`https://api.crossref.org/works/${encodeURIComponent(cleaned)}`);
            if (!r.ok) return null;
            const d = await r.json();
            const item = d.message;
            return {
                id: `ref_doi_${Math.random().toString(36).substring(2, 9)}`,
                type: 'article-journal',
                author: item.author?.map(a => ({ family: a.family || '', given: a.given || '' })) || [],
                issued: { 'date-parts': [item.issued?.['date-parts']?.[0] || []] },
                title: item.title?.[0] || '',
                'container-title': item['container-title']?.[0] || '',
                volume: item.volume || undefined,
                issue: item.issue || undefined,
                page: item.page || undefined,
                DOI: item.DOI || cleaned,
                publisher: item.publisher || undefined
            };
        } catch { return null; }
    }

    // ISBN
    const isbnDigits = cleaned.replace(/[-\s]/g, '');
    if (/^\d{10}$|^\d{13}$/.test(isbnDigits)) {
        try {
            const r = await fetch(`https://openlibrary.org/api/books?bibkeys=ISBN:${isbnDigits}&format=json&jscmd=data`);
            if (!r.ok) return null;
            const d = await r.json();
            const book = d[`ISBN:${isbnDigits}`];
            if (!book) return null;
            return {
                id: `ref_isbn_${Math.random().toString(36).substring(2, 9)}`,
                type: 'book',
                author: book.authors?.map(a => {
                    const parts = (a.name || '').split(' ');
                    return { family: parts.slice(-1)[0] || '', given: parts.slice(0, -1).join(' ') || '' };
                }) || [],
                issued: { 'date-parts': [[parseInt(book.publish_date) || new Date().getFullYear()]] },
                title: book.title || '',
                publisher: book.publishers?.[0]?.name || '',
                'publisher-place': book.publish_places?.[0]?.name || '',
                ISBN: isbnDigits
            };
        } catch { return null; }
    }

    return null;
}

// ── Main handler ───────────────────────────────────────────────────
export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    // Rate limiting
    const ip = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown';
    const limit = rateLimit(ip, 'clean', 30);
    if (!limit.allowed) {
        return res.status(429).json({
            error: `Too many requests. Please wait ${limit.resetIn} minutes before trying again.`
        });
    }

    const { references: rawInput, format } = req.body;

    if (!rawInput || !format) {
        return res.status(400).json({ error: 'Missing references or format' });
    }

    try {
        // ── Step 1: Split raw input into individual reference strings ──
        const lines = rawInput.split('\n').map(l => l.trim()).filter(l => l.length > 0);
        const splitRefs = splitIntoReferences(rawInput);

        // ── Step 2: Separate full references from inline identifiers ──
        const { fullReferences, identifiers } = separateIdentifiers(splitRefs);

        // ── Step 3: Resolve any inline DOIs/ISBNs ─────────────────────
        const resolvedItems = [];
        if (identifiers.length > 0) {
            const resolved = await Promise.all(identifiers.map(id => resolveIdentifier(id)));
            for (const item of resolved) {
                if (item) resolvedItems.push(item);
            }
        }

        // ── Step 4: Special modes — no CSL formatting needed ──────────
        if (format === 'Clean and alphabetize only') {
            const deduped = detectDuplicates(fullReferences);
            const sorted = alphabetise(deduped.unique);

            // Add any resolved identifiers as plain text at the end
            const resolvedPlain = resolvedItems.map(item => {
                const { cslJson } = extractMetadata(item.title || '');
                return item.title
                    ? `${item.author?.[0]?.family || 'Unknown'} (${item.issued?.['date-parts']?.[0]?.[0] || 'n.d.'}) ${item.title}.`
                    : null;
            }).filter(Boolean);

            const allSorted = [...sorted, ...resolvedPlain];
            const quality = checkListQuality(allSorted);

            let result = allSorted.join('\n');
            if (deduped.removedCount > 0) {
                result += `\n\n─────────────────────────────\n✂️ ${deduped.removedCount} duplicate(s) removed`;
            }
            if (quality.totalIssues > 0) {
                result += `\n⚠️ ${quality.warnings} quality warning(s) found — click Verify to check in detail`;
            }

            return res.status(200).json({ result });
        }

        if (format === 'Number my references') {
            const deduped = detectDuplicates(fullReferences);
            const sorted = alphabetise(deduped.unique);
            const numbered = numberReferences(sorted, 'numeric');

            let result = numbered.join('\n');
            if (deduped.removedCount > 0) {
                result += `\n\n─────────────────────────────\n✂️ ${deduped.removedCount} duplicate(s) removed`;
            }

            return res.status(200).json({ result });
        }

        // ── Step 5: Full CSL formatting pipeline ───────────────────────

        // 5a: Extract metadata from all full references using rules
        const extractedItems = fullReferences.map((ref, i) => {
            const { cslJson, confidence } = extractMetadata(ref, `ref_${i + 1}`);
            return { cslJson, confidence, raw: ref };
        });

        // 5b: For low-confidence extractions, try Groq as backup
        const LOW_CONFIDENCE_THRESHOLD = 40;
        const needsGroq = extractedItems.filter(item => item.confidence < LOW_CONFIDENCE_THRESHOLD);

        if (needsGroq.length > 0 && GROQ_API_KEY) {
            // Process low-confidence items with Groq — in parallel, max 5 at once
            const batchSize = 5;
            for (let i = 0; i < needsGroq.length; i += batchSize) {
                const batch = needsGroq.slice(i, i + batchSize);
                const groqResults = await Promise.all(batch.map(item => extractFieldsWithGroq(item.raw)));

                for (let j = 0; j < batch.length; j++) {
                    if (groqResults[j]) {
                        // Replace the low-confidence rules extraction with Groq's result
                        const originalIndex = extractedItems.findIndex(e => e.raw === batch[j].raw);
                        if (originalIndex !== -1) {
                            extractedItems[originalIndex].cslJson = groqResults[j];
                            extractedItems[originalIndex].confidence = 75; // Groq succeeded
                        }
                    }
                }
            }
        }

        // 5c: Merge resolved identifiers into the items list
        const allItems = [
            ...extractedItems.map(e => e.cslJson),
            ...resolvedItems
        ];

        if (allItems.length === 0) {
            return res.status(400).json({ error: 'No valid references found in your input.' });
        }

        // 5d: Format via CSL/citeproc-js
        const { formatted, duplicatesRemoved } = await formatReferenceList(allItems, format, {
            sort: true,
            removeDups: true
        });

        // ── Step 6: Quality check on final output ──────────────────────
        const quality = checkListQuality(formatted);

        // ── Step 7: Build result string ────────────────────────────────
        let result = formatted.join('\n');

        // Append useful metadata notes
        const notes = [];
        if (duplicatesRemoved > 0) {
            notes.push(`✂️ ${duplicatesRemoved} duplicate(s) removed`);
        }
        if (identifiers.length > 0) {
            notes.push(`🔗 ${resolvedItems.length} of ${identifiers.length} DOI/ISBN identifier(s) resolved`);
        }
        if (needsGroq.length > 0) {
            notes.push(`🤖 ${needsGroq.length} reference(s) processed with AI assistance (low field-extraction confidence)`);
        }
        if (quality.warnings > 0) {
            notes.push(`⚠️ ${quality.warnings} reference(s) have quality warnings — click Verify to check in detail`);
        }

        if (notes.length > 0) {
            result += '\n\n─────────────────────────────\n' + notes.join('\n');
        }

        return res.status(200).json({ result });

    } catch (err) {
        console.error('Clean error:', err.message);

        // Graceful degradation — if the new pipeline fails entirely,
        // fall back to Groq for the whole input so the user always gets output
        try {
            const fallback = await fetch('https://api.groq.com/openai/v1/chat/completions', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${GROQ_API_KEY}`
                },
                body: JSON.stringify({
                    model: 'llama-3.3-70b-versatile',
                    max_tokens: 4000,
                    messages: [
                        {
                            role: 'system',
                            content: `You are an academic reference formatter. Clean, deduplicate, alphabetise and format the following references in ${req.body.format} citation style. Return only the formatted references, one per line, nothing else.`
                        },
                        { role: 'user', content: req.body.references }
                    ]
                })
            });
            const fallbackData = await fallback.json();
            const fallbackResult = fallbackData.choices?.[0]?.message?.content?.trim();
            if (fallbackResult) {
                return res.status(200).json({
                    result: fallbackResult + '\n\n─────────────────────────────\n⚠️ Formatted using AI fallback (standard pipeline encountered an error)'
                });
            }
        } catch { /* fallback also failed */ }

        return res.status(500).json({ error: `Could not format references: ${err.message}` });
    }
}
