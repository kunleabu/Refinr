// ═══════════════════════════════════════════════════════════════════
// api/intext.js — Reference Intelligence Engine
// Generates in-text citations from a reference list.
// Two modes: parenthetical (Smith, 2020) and narrative Smith (2020).
// Pure rules for et al. logic — no AI needed for this task.
// ═══════════════════════════════════════════════════════════════════

import { extractMetadata } from '../lib/metadata.js';

// ── Rules: build in-text citation from CSL-JSON metadata ──────────
function buildInTextCitation(cslItem, style = 'parenthetical') {
    const authors = cslItem.author || [];
    const year = cslItem.issued?.['date-parts']?.[0]?.[0] || 'n.d.';

    // Build author string with et al. rules
    // 1 author: Smith
    // 2 authors: Smith and Jones
    // 3+ authors: Smith et al.
    let authorStr = '';
    if (authors.length === 0) {
        authorStr = cslItem.title
            ? `'${cslItem.title.substring(0, 30)}...'`
            : 'Unknown';
    } else if (authors.length === 1) {
        authorStr = authors[0].family || 'Unknown';
    } else if (authors.length === 2) {
        authorStr = `${authors[0].family} and ${authors[1].family}`;
    } else {
        authorStr = `${authors[0].family} et al.`;
    }

    if (style === 'narrative') {
        // Narrative: Smith (2020) or Smith and Jones (2020) or Smith et al. (2020)
        return `${authorStr} (${year})`;
    } else {
        // Parenthetical: (Smith, 2020) or (Smith and Jones, 2020) or (Smith et al., 2020)
        return `(${authorStr}, ${year})`;
    }
}

// ── Split raw input into individual references ─────────────────────
function splitReferences(text) {
    const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 10);

    // One reference per line is the most common paste format
    if (lines.length > 1) {
        const withYears = lines.filter(l => /\b(19|20)\d{2}\b/.test(l));
        if (withYears.length / lines.length > 0.5) return lines;
    }

    // Numbered list
    const numbered = text.split(/\n(?=\s*\d+[\.\)]\s+[A-Z])/);
    if (numbered.length > 1) return numbered.map(r => r.replace(/^\s*\d+[\.\)]\s+/, '').trim());

    // Double newline separated
    const doubled = text.split(/\n\n+/).map(r => r.replace(/\s+/g, ' ').trim()).filter(r => r.length > 10);
    if (doubled.length > 1) return doubled;

    return [text.trim()];
}

// ── Main handler ───────────────────────────────────────────────────
export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const { references: rawInput, style = 'parenthetical' } = req.body;

    if (!rawInput || !rawInput.trim()) {
        return res.status(400).json({ error: 'Missing references' });
    }

    try {
        const refs = splitReferences(rawInput);

        const citations = [];

        for (let i = 0; i < refs.length; i++) {
            const ref = refs[i].trim();
            if (!ref) continue;

            // Extract metadata using rules
            const { cslJson, confidence } = extractMetadata(ref, `intext_${i + 1}`);

            // Build in-text citation
            const inText = buildInTextCitation(cslJson, style);

            citations.push({
                number: i + 1,
                inText,
                source: ref.substring(0, 80) + (ref.length > 80 ? '...' : '')
            });
        }

        // Format output
        const styleLabel = style === 'narrative' ? 'Narrative' : 'Parenthetical';
        const lines = citations.map(c =>
            `${c.number}. ${c.inText}\n   Source: ${c.source}`
        );

        const result = `IN-TEXT CITATIONS — ${styleLabel} style\n` +
            `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
            lines.join('\n\n') +
            `\n\n─────────────────────────────\n` +
            `💡 ${citations.length} citation(s) generated. ` +
            (style === 'parenthetical'
                ? 'Use these inline: e.g. "...as shown in previous research ' + (citations[0]?.inText || '(Author, Year)') + '.\"'
                : 'Use these inline: e.g. "' + (citations[0]?.inText || 'Author (Year)') + ' demonstrated that..."');

        return res.status(200).json({ result });

    } catch (err) {
        console.error('Intext error:', err.message);
        return res.status(500).json({ error: `Could not generate citations: ${err.message}` });
    }
}
