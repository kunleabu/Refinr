// ═══════════════════════════════════════════════════════════════════
// lib/rules.js — Reference Intelligence Engine
// Pure deterministic rules engine.
//
// Responsibilities:
//   - Quality checking: flag incomplete or malformed references
//   - Duplicate detection: string similarity (Levenshtein distance)
//   - Metadata validation: year, DOI, ISBN, URL format checks
//   - Bulk processing: alphabetise, number, deduplicate raw strings
//
// Design principle: every function here is pure and deterministic.
// Same input always produces same output. No randomness, no AI,
// no external calls. These are the rules Refinr can stake its
// credibility on.
// ═══════════════════════════════════════════════════════════════════

// ── String similarity (Levenshtein distance) ──────────────────────
// Used for duplicate detection. Compares two strings and returns
// a similarity score between 0 (completely different) and 1 (identical).

function levenshtein(a, b) {
    if (a === b) return 0;
    if (a.length === 0) return b.length;
    if (b.length === 0) return a.length;

    // Use a single row rolling approach for memory efficiency
    const row = Array.from({ length: b.length + 1 }, (_, i) => i);

    for (let i = 1; i <= a.length; i++) {
        let prev = i;
        for (let j = 1; j <= b.length; j++) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            const next = Math.min(row[j] + 1, prev + 1, row[j - 1] + cost);
            row[j - 1] = prev;
            prev = next;
        }
        row[b.length] = prev;
    }

    return row[b.length];
}

/**
 * Similarity score between 0 and 1.
 * 1.0 = identical, 0.0 = completely different.
 * Normalised by the length of the longer string.
 */
function similarity(a, b) {
    const maxLen = Math.max(a.length, b.length);
    if (maxLen === 0) return 1;
    return 1 - levenshtein(a, b) / maxLen;
}

// Normalise a string for comparison — lowercase, remove punctuation and extra spaces
function normalise(str) {
    return str
        .toLowerCase()
        .replace(/[^\w\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

// ── Duplicate detection ────────────────────────────────────────────

/**
 * Find duplicate references in an array of raw reference strings.
 * Uses title-based similarity — two references are duplicates if
 * their normalised strings are more than `threshold` similar.
 *
 * @param {string[]} references  - Raw reference strings
 * @param {number}   threshold   - Similarity threshold 0-1 (default 0.85)
 * @returns {{
 *   unique: string[],           - Deduplicated list (first occurrence kept)
 *   duplicates: Array<{         - Pairs of duplicates found
 *     original: string,
 *     duplicate: string,
 *     similarity: number
 *   }>,
 *   removedCount: number
 * }}
 */
export function detectDuplicates(references, threshold = 0.85) {
    const unique = [];
    const duplicates = [];
    const normalisedUnique = [];

    for (const ref of references) {
        const normRef = normalise(ref);

        // Check against all already-accepted unique references
        let isDuplicate = false;
        for (let i = 0; i < normalisedUnique.length; i++) {
            const sim = similarity(normRef, normalisedUnique[i]);
            if (sim >= threshold) {
                duplicates.push({
                    original: unique[i],
                    duplicate: ref,
                    similarity: Math.round(sim * 100) / 100
                });
                isDuplicate = true;
                break;
            }
        }

        if (!isDuplicate) {
            unique.push(ref);
            normalisedUnique.push(normRef);
        }
    }

    return { unique, duplicates, removedCount: duplicates.length };
}

// ── Metadata field validators ──────────────────────────────────────

/**
 * Validate a DOI string.
 * DOIs always start with 10. followed by a registrant code and suffix.
 */
export function validateDOI(doi) {
    if (!doi) return { valid: false, reason: 'No DOI provided' };
    const cleaned = doi.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '');
    if (!/^10\.\d{4,9}\/\S+/.test(cleaned)) {
        return { valid: false, reason: `"${doi}" does not match DOI format (should start with 10.xxxx/)` };
    }
    return { valid: true, cleaned };
}

/**
 * Validate an ISBN-10 or ISBN-13.
 * Uses the actual checksum algorithms.
 */
export function validateISBN(isbn) {
    if (!isbn) return { valid: false, reason: 'No ISBN provided' };
    const digits = isbn.replace(/[-\s]/g, '');

    if (digits.length === 10) {
        // ISBN-10 checksum
        let sum = 0;
        for (let i = 0; i < 9; i++) {
            if (!/\d/.test(digits[i])) return { valid: false, reason: 'ISBN-10 contains non-digit characters' };
            sum += parseInt(digits[i]) * (10 - i);
        }
        const check = digits[9] === 'X' ? 10 : parseInt(digits[9]);
        sum += check;
        if (sum % 11 !== 0) return { valid: false, reason: 'ISBN-10 checksum failed — may be mistyped' };
        return { valid: true, type: 'ISBN-10', cleaned: digits };
    }

    if (digits.length === 13) {
        // ISBN-13 checksum
        if (!/^\d{13}$/.test(digits)) return { valid: false, reason: 'ISBN-13 contains non-digit characters' };
        let sum = 0;
        for (let i = 0; i < 12; i++) {
            sum += parseInt(digits[i]) * (i % 2 === 0 ? 1 : 3);
        }
        const check = (10 - (sum % 10)) % 10;
        if (check !== parseInt(digits[12])) return { valid: false, reason: 'ISBN-13 checksum failed — may be mistyped' };
        return { valid: true, type: 'ISBN-13', cleaned: digits };
    }

    return { valid: false, reason: `ISBN must be 10 or 13 digits (found ${digits.length})` };
}

/**
 * Validate a year value.
 * Academic references should be between 1000 and next year.
 */
export function validateYear(year) {
    if (!year) return { valid: false, reason: 'No year provided' };
    const y = parseInt(String(year).match(/\d{4}/)?.[0]);
    if (isNaN(y)) return { valid: false, reason: `"${year}" is not a valid year` };
    const nextYear = new Date().getFullYear() + 1;
    if (y < 1000 || y > nextYear) {
        return { valid: false, reason: `Year ${y} is outside the expected range (1000–${nextYear})` };
    }
    return { valid: true, year: y };
}

/**
 * Validate a URL is at minimum structurally valid.
 */
export function validateURL(url) {
    if (!url) return { valid: false, reason: 'No URL provided' };
    try {
        const parsed = new URL(url);
        if (!['http:', 'https:'].includes(parsed.protocol)) {
            return { valid: false, reason: 'URL must use http or https protocol' };
        }
        return { valid: true, url: parsed.href };
    } catch {
        return { valid: false, reason: `"${url}" is not a valid URL` };
    }
}

// ── Reference quality checker ──────────────────────────────────────

/**
 * Check a single raw reference string for quality issues.
 * Returns a list of flags — empty array means no issues found.
 *
 * @param {string} reference - Raw reference string
 * @returns {{
 *   hasIssues: boolean,
 *   flags: string[],         - Human-readable issue descriptions
 *   severity: 'ok'|'warn'|'error'
 * }}
 */
export function checkReferenceQuality(reference) {
    const flags = [];
    const text = reference.trim();

    if (text.length < 20) {
        return { hasIssues: true, flags: ['Reference is too short to be valid'], severity: 'error' };
    }

    // Check for year
    if (!/\b(19|20)\d{2}\b/.test(text)) {
        flags.push('Missing publication year');
    }

    // Check for author-like pattern
    if (!/[A-Z][a-z]+,|[A-Z]\.\s?[A-Z][a-z]+|[A-Z]{2,3}[,;]/.test(text)) {
        flags.push('No recognisable author name found');
    }

    // Check for title-like content (at least 5 words in sequence)
    if (!/([\w-]+ ){4,}[\w-]+/.test(text)) {
        flags.push('No recognisable title found');
    }

    // Check for source (journal/book/URL/DOI)
    const hasSource = /10\.\d{4,9}\/|https?:\/\/|[A-Z][a-z]+(?: [A-Z][a-z]+){1,4},?\s+vol\.|[A-Z][a-z]+(?: [A-Z][a-z]+){1,4},?\s+\d+\s*[\(:]/.test(text);
    if (!hasSource && text.length < 100) {
        flags.push('No identifiable source (journal, publisher, DOI, or URL)');
    }

    // Check for in-text citation mistakenly included as a full reference
    if (/^\([A-Z][a-z]+,?\s+\d{4}\)$/.test(text) || /^\[[A-Z][a-z]+,?\s+\d{4}\]$/.test(text)) {
        flags.push('This looks like an in-text citation, not a full reference');
    }

    // Check for obviously truncated reference (ends mid-sentence without punctuation or DOI)
    if (text.length > 50 && !/[.)\]]$/.test(text) && !/\d$/.test(text)) {
        flags.push('Reference may be truncated (does not end with expected punctuation)');
    }

    // Warn about very old references (pre-1950) — not errors, just worth flagging
    const yearMatch = text.match(/\b(1[0-9]\d{2})\b/);
    if (yearMatch && parseInt(yearMatch[1]) < 1950) {
        flags.push(`Reference is from ${yearMatch[1]} — verify this is intentional`);
    }

    const severity = flags.length === 0 ? 'ok' : flags.some(f =>
        f.includes('truncated') || f.includes('in-text') || f.includes('too short')
    ) ? 'error' : 'warn';

    return { hasIssues: flags.length > 0, flags, severity };
}

/**
 * Check quality of a full reference list.
 *
 * @param {string[]} references
 * @returns {{
 *   results: Array,           - Per-reference quality results
 *   totalIssues: number,
 *   errors: number,
 *   warnings: number,
 *   clean: number,
 *   summary: string
 * }}
 */
export function checkListQuality(references) {
    const results = references.map((ref, i) => ({
        index: i,
        reference: ref,
        ...checkReferenceQuality(ref)
    }));

    const errors = results.filter(r => r.severity === 'error').length;
    const warnings = results.filter(r => r.severity === 'warn').length;
    const clean = results.filter(r => r.severity === 'ok').length;
    const totalIssues = errors + warnings;

    const summary = totalIssues === 0
        ? `All ${references.length} references passed quality checks.`
        : `${clean} of ${references.length} references are clean. ${errors > 0 ? `${errors} error(s)` : ''} ${warnings > 0 ? `${warnings} warning(s)` : ''}`.trim();

    return { results, totalIssues, errors, warnings, clean, summary };
}

// ── Bulk text processing (raw string operations) ───────────────────

/**
 * Alphabetise a list of raw reference strings by first author surname.
 * Falls back to full string sort if no author is detected.
 *
 * @param {string[]} references
 * @returns {string[]}
 */
export function alphabetise(references) {
    return [...references].sort((a, b) => {
        const authorA = extractSortKey(a);
        const authorB = extractSortKey(b);
        return authorA.localeCompare(authorB, 'en', { sensitivity: 'base' });
    });
}

function extractSortKey(ref) {
    // Strip leading numbers/brackets for numbered styles
    const cleaned = ref.replace(/^\s*[\[\(]?\d+[\.\)\]]?\s*/, '');
    // First word that looks like a surname (capitalised, no punctuation before it)
    const match = cleaned.match(/^([A-Z][a-z'-]+)/);
    return match ? match[1].toLowerCase() : cleaned.toLowerCase().substring(0, 20);
}

/**
 * Number a list of references sequentially.
 * Removes any existing numbering first, then applies fresh numbers.
 *
 * @param {string[]} references
 * @param {string}   format - 'numeric' (1. 2. 3.) or 'brackets' ([1] [2] [3])
 * @returns {string[]}
 */
export function numberReferences(references, format = 'numeric') {
    return references.map((ref, i) => {
        // Strip any existing leading number/bracket
        const stripped = ref
            .replace(/^\s*\[\d+\]\s*/, '')
            .replace(/^\s*\d+[\.\)]\s*/, '')
            .replace(/^\s*\(\d+\)\s*/, '')
            .trim();

        if (format === 'brackets') return `[${i + 1}] ${stripped}`;
        return `${i + 1}. ${stripped}`;
    });
}

/**
 * Split a block of pasted text into individual reference strings.
 * Tries multiple splitting strategies and picks the best result.
 *
 * @param {string} text - Raw pasted text from user input
 * @returns {string[]}  - Array of individual reference strings
 */
export function splitIntoReferences(text) {
    if (!text || !text.trim()) return [];

    const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);

    // Strategy 1: already one reference per line (most common paste format)
    if (lines.length > 1 && lines.every(l => l.length > 15)) {
        // Check if each line looks like a complete reference (has a year)
        const linesWithYears = lines.filter(l => /\b(19|20)\d{2}\b/.test(l));
        if (linesWithYears.length / lines.length > 0.6) {
            return lines;
        }
    }

    // Strategy 2: numbered list (1. ref\n2. ref)
    const numbered = text.split(/\n(?=\s*\d+[\.\)]\s+[A-Z])/);
    if (numbered.length > 1) {
        return numbered.map(r => r.replace(/^\s*\d+[\.\)]\s+/, '').replace(/\s+/g, ' ').trim()).filter(r => r.length > 20);
    }

    // Strategy 3: bracketed list ([1] ref\n[2] ref)
    const bracketed = text.split(/\n(?=\s*\[\d+\])/);
    if (bracketed.length > 1) {
        return bracketed.map(r => r.replace(/^\s*\[\d+\]\s*/, '').replace(/\s+/g, ' ').trim()).filter(r => r.length > 20);
    }

    // Strategy 4: double newline separated
    const doubleNewline = text.split(/\n\n+/).map(r => r.replace(/\s+/g, ' ').trim()).filter(r => r.length > 20);
    if (doubleNewline.length > 1) return doubleNewline;

    // Strategy 5: single block — treat as one reference
    return [text.replace(/\s+/g, ' ').trim()];
}

/**
 * Resolve inline DOIs and ISBNs in a pasted reference list.
 * Some users paste a mix of full references and bare DOIs/ISBNs.
 * This function separates them so the API can look them up.
 *
 * @param {string[]} references
 * @returns {{
 *   fullReferences: string[],  - Complete reference strings (keep as-is)
 *   identifiers: string[],     - Bare DOIs or ISBNs to look up
 *   mixed: boolean             - True if list contains both types
 * }}
 */
export function separateIdentifiers(references) {
    const fullReferences = [];
    const identifiers = [];

    for (const ref of references) {
        const trimmed = ref.trim();

        // Bare DOI (starts with 10.)
        if (/^10\.\d{4,9}\/\S+$/.test(trimmed)) {
            identifiers.push(trimmed);
            continue;
        }

        // DOI URL
        if (/^https?:\/\/(?:dx\.)?doi\.org\/10\.\d{4,9}\/\S+$/.test(trimmed)) {
            identifiers.push(trimmed.replace(/^https?:\/\/(?:dx\.)?doi\.org\//, ''));
            continue;
        }

        // Bare ISBN (10 or 13 digits, possibly with hyphens)
        if (/^(?:\d[-\s]?){9}[\dX]$/.test(trimmed) || /^(?:\d[-\s]?){12}\d$/.test(trimmed)) {
            identifiers.push(trimmed);
            continue;
        }

        fullReferences.push(trimmed);
    }

    return {
        fullReferences,
        identifiers,
        mixed: fullReferences.length > 0 && identifiers.length > 0
    };
}
