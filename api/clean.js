import { extractMetadata } from './lib/metadata.js';
import { formatReferenceList } from './lib/formatter.js';
import { detectDuplicates, alphabetise, numberReferences, splitIntoReferences, separateIdentifiers, checkListQuality } from './lib/rules.js';
import { rateLimit } from './ratelimit.js';

const GROQ_API_KEY = process.env.GROQ_API_KEY;

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const { references: rawInput, format } = req.body;
    if (!rawInput || !format) {
        return res.status(400).json({ error: 'Missing references or format' });
    }

    const diagnostics = [];

    try {
        // Step 1: Split
        const splitRefs = splitIntoReferences(rawInput);
        diagnostics.push(`Step 1 split: ${splitRefs.length} references found`);

        // Step 2: Separate identifiers
        const { fullReferences, identifiers } = separateIdentifiers(splitRefs);
        diagnostics.push(`Step 2 separate: ${fullReferences.length} full refs, ${identifiers.length} identifiers`);

        // Step 3: Special modes
        if (format === 'Clean and alphabetize only') {
            const deduped = detectDuplicates(fullReferences);
            const sorted = alphabetise(deduped.unique);
            return res.status(200).json({ result: sorted.join('\n'), diagnostics });
        }

        if (format === 'Number my references') {
            const deduped = detectDuplicates(fullReferences);
            const sorted = alphabetise(deduped.unique);
            const numbered = numberReferences(sorted, 'numeric');
            return res.status(200).json({ result: numbered.join('\n'), diagnostics });
        }

        // Step 4: Extract metadata
        const extractedItems = fullReferences.map((ref, i) => {
            const { cslJson, confidence } = extractMetadata(ref, `ref_${i + 1}`);
            return { cslJson, confidence, raw: ref };
        });
        diagnostics.push(`Step 4 metadata: ${extractedItems.length} items extracted`);
        diagnostics.push(`Step 4 sample cslJson: ${JSON.stringify(extractedItems[0]?.cslJson || {})}`);
        diagnostics.push(`Step 4 confidence scores: ${extractedItems.map(e => e.confidence).join(', ')}`);

        // Step 5: Format
        const allItems = extractedItems.map(e => e.cslJson);
        diagnostics.push(`Step 5 formatting ${allItems.length} items in style: ${format}`);

        const { formatted, duplicatesRemoved } = await formatReferenceList(allItems, format, {
            sort: true,
            removeDups: true
        });

        diagnostics.push(`Step 5 result: ${formatted.length} formatted items`);
        diagnostics.push(`Step 5 first result: ${formatted[0] || 'EMPTY'}`);

        if (formatted.length === 0) {
            return res.status(200).json({
                result: 'DEBUG: No formatted output produced. Check diagnostics.',
                diagnostics
            });
        }

        return res.status(200).json({
            result: formatted.join('\n'),
            diagnostics
        });

    } catch (err) {
        return res.status(500).json({
            error: err.message,
            stack: err.stack?.substring(0, 500),
            diagnostics
        });
    }
}
