
// ═══════════════════════════════════════════════════════════════════
// lib/style-detector.js — Reference Intelligence Engine
// Pure rules-based citation style fingerprinter.
// Analyses a sample of references and returns the detected style
// with a confidence score. No AI, no API calls, no external deps.
//
// Each citation style has a unique combination of:
//   - Author format (Lastname, F. vs F. Lastname vs Lastname F)
//   - Date position (after author vs end of entry)
//   - Title punctuation ("double" vs 'single' vs none vs italic marker)
//   - Numbering (yes/no, format)
//   - Punctuation patterns (semicolons, commas, colons, periods)
//   - Abbreviation usage (vol./Vol., no./No., pp./p.)
// ═══════════════════════════════════════════════════════════════════

// ── Style fingerprints ─────────────────────────────────────────────
// Each fingerprint is a set of weighted pattern tests.
// score = sum of (weight * match_boolean) for all tests.
// Max possible score per style = sum of all weights.
const STYLE_FINGERPRINTS = {

    harvard: {
        name: 'Harvard',
        cslFile: 'harvard-cite-them-right',
        tests: [
            // Author format: Lastname, F. or Lastname, Firstname
            { weight: 3, test: refs => refs.filter(r => /^[A-Z][a-z]+,\s?[A-Z]\./.test(r.trim())).length / refs.length > 0.5 },
            // Date in parentheses immediately after author: Author (2020)
            { weight: 4, test: refs => refs.filter(r => /^[A-Z][a-z]+.*?\(\d{4}\)/.test(r)).length / refs.length > 0.4 },
            // Single quotes around article/chapter titles
            { weight: 3, test: refs => refs.filter(r => /'[A-Z][^']{10,}'/.test(r)).length / refs.length > 0.3 },
            // vol. and no. abbreviations (lowercase)
            { weight: 2, test: refs => refs.filter(r => /\bvol\.\s?\d+/i.test(r) || /\bno\.\s?\d+/i.test(r)).length / refs.length > 0.3 },
            // pp. for page ranges
            { weight: 2, test: refs => refs.filter(r => /\bpp\.\s?\d+/.test(r)).length / refs.length > 0.3 },
            // Not numbered (no leading numbers)
            { weight: 1, test: refs => refs.filter(r => /^\s*\d+[\.\)]/.test(r)).length / refs.length < 0.2 },
        ]
    },

    apa: {
        name: 'APA',
        cslFile: 'apa',
        tests: [
            // Author format: Lastname, F. M.
            { weight: 3, test: refs => refs.filter(r => /^[A-Z][a-z]+,\s?[A-Z]\.\s?([A-Z]\.\s?)?/.test(r.trim())).length / refs.length > 0.5 },
            // Date in parentheses after author: Author, F. (2020).
            { weight: 4, test: refs => refs.filter(r => /^[A-Z][a-z]+,\s?[A-Z]\..*?\(\d{4}\)\./.test(r)).length / refs.length > 0.4 },
            // No quotes around article titles (title just follows year)
            { weight: 2, test: refs => refs.filter(r => /\(\d{4}\)\.\s+[A-Z][^'"]{20,}\./.test(r)).length / refs.length > 0.3 },
            // Sentence case for article titles (first word capitalised, rest lowercase)
            { weight: 2, test: refs => refs.filter(r => /\(\d{4}\)\.\s+[A-Z][a-z ]{15,}[,\.]/.test(r)).length / refs.length > 0.3 },
            // DOI at end: https://doi.org/ format
            { weight: 2, test: refs => refs.filter(r => /https:\/\/doi\.org\//.test(r)).length / refs.length > 0.2 },
            // Multiple authors joined with &
            { weight: 2, test: refs => refs.filter(r => /[A-Z][a-z]+,\s?[A-Z]\.,?\s?&\s?[A-Z]/.test(r)).length / refs.length > 0.2 },
            // Not numbered
            { weight: 1, test: refs => refs.filter(r => /^\s*\d+[\.\)]/.test(r)).length / refs.length < 0.2 },
        ]
    },

    mla: {
        name: 'MLA',
        cslFile: 'modern-language-association',
        tests: [
            // Author format: Lastname, Firstname (full first name, not initials)
            { weight: 3, test: refs => refs.filter(r => /^[A-Z][a-z]+,\s[A-Z][a-z]{2,}/.test(r.trim())).length / refs.length > 0.4 },
            // Date near END of entry (not after author)
            { weight: 4, test: refs => refs.filter(r => /,\s?\d{4}[,\.]?\s*$/.test(r) || /\.\s+\d{4}\.$/.test(r)).length / refs.length > 0.3 },
            // Double quotes around article titles
            { weight: 4, test: refs => refs.filter(r => /"[A-Z][^"]{10,}"/.test(r)).length / refs.length > 0.3 },
            // vol. and no. with period
            { weight: 2, test: refs => refs.filter(r => /\bvol\.\s?\d+,\s?no\./.test(r)).length / refs.length > 0.2 },
            // pp. for pages
            { weight: 2, test: refs => refs.filter(r => /\bpp\.\s?\d+/.test(r)).length / refs.length > 0.3 },
            // Not numbered
            { weight: 1, test: refs => refs.filter(r => /^\s*\d+[\.\)]/.test(r)).length / refs.length < 0.2 },
        ]
    },

    chicago: {
        name: 'Chicago',
        cslFile: 'chicago-author-date',
        tests: [
            // Author format: Lastname, Firstname (full name)
            { weight: 2, test: refs => refs.filter(r => /^[A-Z][a-z]+,\s[A-Z][a-z]{2,}/.test(r.trim())).length / refs.length > 0.4 },
            // Date in parentheses after author for author-date style
            { weight: 3, test: refs => refs.filter(r => /^[A-Z][a-z]+,\s[A-Z][a-z]+\.\s\d{4}\./.test(r)).length / refs.length > 0.3 },
            // Title case for article titles (multiple capitalised words, no quotes)
            { weight: 2, test: refs => refs.filter(r => /\d{4}\.\s+"[A-Z]/.test(r) || /\d{4}\.\s+[A-Z][a-z]+ [A-Z][a-z]+/.test(r)).length / refs.length > 0.3 },
            // Colon before subtitle
            { weight: 2, test: refs => refs.filter(r => /[A-Z][a-z]+:\s+[A-Z]/.test(r)).length / refs.length > 0.2 },
            // Not numbered
            { weight: 1, test: refs => refs.filter(r => /^\s*\d+[\.\)]/.test(r)).length / refs.length < 0.2 },
        ]
    },

    vancouver: {
        name: 'Vancouver',
        cslFile: 'vancouver',
        tests: [
            // Numbered entries — Vancouver is always numbered
            { weight: 5, test: refs => refs.filter(r => /^\s*\d+[\.\)]\s+/.test(r)).length / refs.length > 0.6 },
            // Author format: Lastname AB (initials without periods)
            { weight: 4, test: refs => refs.filter(r => /^\s*\d+[\.\)]\s+[A-Z][a-z]+\s[A-Z]{1,3}[,\s]/.test(r)).length / refs.length > 0.3 },
            // No quotes around titles
            { weight: 2, test: refs => refs.filter(r => /"[^"]{10,}"/.test(r) || /'[^']{10,}'/.test(r)).length / refs.length < 0.2 },
            // Semicolon between multiple authors
            { weight: 3, test: refs => refs.filter(r => /[A-Z]{1,3};\s?[A-Z][a-z]+/.test(r)).length / refs.length > 0.2 },
            // Year after authors without parentheses
            { weight: 2, test: refs => refs.filter(r => /[A-Z]{1,3}\.\s+\d{4}\s+/.test(r) || /[A-Z]{1,3},?\s+\d{4};/.test(r)).length / refs.length > 0.2 },
        ]
    },

    ieee: {
        name: 'IEEE',
        cslFile: 'ieee',
        tests: [
            // Numbered entries with brackets: [1]
            { weight: 5, test: refs => refs.filter(r => /^\s*\[\d+\]/.test(r)).length / refs.length > 0.6 },
            // Author format: F. Lastname (initials first)
            { weight: 4, test: refs => refs.filter(r => /^\s*\[\d+\]\s+[A-Z]\.\s?([A-Z]\.\s?)?[A-Z][a-z]+/.test(r)).length / refs.length > 0.3 },
            // Double quotes around article/paper titles
            { weight: 3, test: refs => refs.filter(r => /"[A-Z][^"]{10,}"/.test(r)).length / refs.length > 0.3 },
            // "in" keyword for conference papers
            { weight: 2, test: refs => refs.filter(r => /,\s+in\s+[A-Z]/.test(r)).length / refs.length > 0.1 },
            // vol., no., pp. with specific IEEE punctuation
            { weight: 2, test: refs => refs.filter(r => /vol\.\s?\d+,\s?no\.\s?\d+,\s?pp\./.test(r)).length / refs.length > 0.1 },
            // Year at end of entry
            { weight: 2, test: refs => refs.filter(r => /\d{4}\.$/.test(r.trim())).length / refs.length > 0.3 },
        ]
    },

    ama: {
        name: 'AMA',
        cslFile: 'american-medical-association',
        tests: [
            // Numbered entries
            { weight: 4, test: refs => refs.filter(r => /^\s*\d+[\.\)]\s+/.test(r)).length / refs.length > 0.6 },
            // Author: Lastname AB format (like Vancouver but different punctuation)
            { weight: 3, test: refs => refs.filter(r => /^\s*\d+[\.\)]\s+[A-Z][a-z]+\s[A-Z]{1,3},/.test(r)).length / refs.length > 0.3 },
            // Journal name not italicised, abbreviated
            { weight: 2, test: refs => refs.filter(r => /\.\s+[A-Z][a-z]+\s?[A-Z][a-z]*\.\s+\d{4}/.test(r)).length / refs.length > 0.2 },
            // Semicolon before volume: Journal. Year;vol(issue):pages
            { weight: 4, test: refs => refs.filter(r => /\d{4};\d+[\(\d]/.test(r)).length / refs.length > 0.3 },
        ]
    },

    acs: {
        name: 'ACS',
        cslFile: 'american-chemical-society',
        tests: [
            // Numbered entries
            { weight: 3, test: refs => refs.filter(r => /^\s*\(\d+\)/.test(r)).length / refs.length > 0.5 },
            // Author: Lastname, F. M. with semicolons between authors
            { weight: 3, test: refs => refs.filter(r => /[A-Z][a-z]+,\s[A-Z]\.\s?[A-Z]?\.\s?;/.test(r)).length / refs.length > 0.2 },
            // Italic journal abbreviation pattern
            { weight: 2, test: refs => refs.filter(r => /\s[A-Z][a-z]+\.\s+\d{4},\s+\d+/.test(r)).length / refs.length > 0.2 },
        ]
    }
};

// ── Main detection function ────────────────────────────────────────
/**
 * Analyses a sample of reference strings and returns the detected style.
 *
 * @param {string[]} references - Array of reference strings to analyse
 * @param {number} sampleSize - Max number of references to analyse (default 10)
 * @returns {{
 *   detected: string|null,        // style key e.g. 'harvard', null if unknown
 *   name: string|null,            // display name e.g. 'Harvard'
 *   cslFile: string|null,         // CSL file name for citeproc
 *   confidence: number,           // 0-100
 *   scores: Object,               // raw scores for all styles (for debugging)
 *   message: string               // human-readable result
 * }}
 */
export function detectCitationStyle(references, sampleSize = 10) {
    if (!references || references.length === 0) {
        return { detected: null, name: null, cslFile: null, confidence: 0, scores: {}, message: 'No references provided' };
    }

    // Use a sample — enough to be statistically meaningful, not so many it's slow
    const sample = references.slice(0, Math.min(sampleSize, references.length));

    const scores = {};
    let maxScore = 0;
    let maxRawScore = 0;

    for (const [styleKey, fingerprint] of Object.entries(STYLE_FINGERPRINTS)) {
        const totalWeight = fingerprint.tests.reduce((sum, t) => sum + t.weight, 0);
        let rawScore = 0;

        for (const { weight, test } of fingerprint.tests) {
            try {
                if (test(sample)) rawScore += weight;
            } catch (e) {
                // Silently skip failing tests — don't crash detection on edge cases
            }
        }

        // Normalise to 0-100
        const normalisedScore = Math.round((rawScore / totalWeight) * 100);
        scores[styleKey] = normalisedScore;

        if (rawScore > maxRawScore) {
            maxRawScore = rawScore;
            maxScore = normalisedScore;
        }
    }

    // Find the winner
    const sortedStyles = Object.entries(scores).sort((a, b) => b[1] - a[1]);
    const [topStyle, topScore] = sortedStyles[0];
    const [, secondScore] = sortedStyles[1] || [null, 0];

    // Confidence is high if:
    // 1. The top score itself is high (>50%)
    // 2. There's a meaningful gap between top and second (>15 points)
    const gap = topScore - secondScore;
    const confidence = topScore < 30 ? topScore : Math.min(100, topScore + (gap > 15 ? 10 : 0));

    if (confidence < 30) {
        return {
            detected: null,
            name: null,
            cslFile: null,
            confidence,
            scores,
            message: 'Could not confidently detect a citation style. Please select one manually.'
        };
    }

    const style = STYLE_FINGERPRINTS[topStyle];
    const confidenceLabel = confidence >= 75 ? 'high' : confidence >= 50 ? 'medium' : 'low';

    return {
        detected: topStyle,
        name: style.name,
        cslFile: style.cslFile,
        confidence,
        confidenceLabel,
        scores,
        message: confidence >= 75
            ? `Your references appear to be in ${style.name} format.`
            : `Your references may be in ${style.name} format (we're not fully certain).`
    };
}

// ── Utility: check if two styles are the same ─────────────────────
// Useful for the "keep this style?" UX — if detected style matches
// what the user already has, no reformatting is needed.
export function isSameStyle(detectedKey, requestedCslFile) {
    if (!detectedKey || !requestedCslFile) return false;
    const fingerprint = STYLE_FINGERPRINTS[detectedKey];
    return fingerprint?.cslFile === requestedCslFile;
}

// ── Utility: get all supported style keys ─────────────────────────
export function getSupportedStyles() {
    return Object.entries(STYLE_FINGERPRINTS).map(([key, fp]) => ({
        key,
        name: fp.name,
        cslFile: fp.cslFile
    }));
}
