// ═══════════════════════════════════════════════════════════════════
// lib/metadata.js — Reference Intelligence Engine
// Pure rules-based field extractor.
// Converts raw reference strings into structured CSL-JSON objects
// that citeproc-js can format into any citation style.
//
// Design principle: extract fields deterministically using regex
// patterns. Return a confidence score so callers know whether to
// trust the result or fall back to AI field extraction.
//
// Output shape matches CSL-JSON spec:
// https://citeproc-js.readthedocs.io/en/latest/csl-json/markup.html
// ═══════════════════════════════════════════════════════════════════

// ── Field extractors ───────────────────────────────────────────────

// Extract DOI — most reliable field, very distinctive pattern
function extractDOI(text) {
    const match = text.match(/\b(10\.\d{4,9}\/[^\s,;>\])"]+)/);
    return match ? match[1].replace(/[.,;)\]]+$/, '') : null;
}

// Extract URL (non-DOI)
function extractURL(text) {
    const doiUrl = text.match(/https?:\/\/doi\.org\/[^\s,;>\])"]+/);
    if (doiUrl) return null; // DOI URL — handled by extractDOI
    const match = text.match(/https?:\/\/[^\s,;>\])"]{10,}/);
    return match ? match[0].replace(/[.,;)\]]+$/, '') : null;
}

// Extract year — look for 4-digit year in typical positions
function extractYear(text) {
    // Priority 1: year in parentheses (Harvard/APA style)
    const inParens = text.match(/\((\d{4})\)/);
    if (inParens) return inParens[1];

    // Priority 2: year after authors, before title (Vancouver/AMA)
    const afterAuthors = text.match(/^[^.]+\.\s+(\d{4})\s+/);
    if (afterAuthors) return afterAuthors[1];

    // Priority 3: year near end of entry (MLA/Chicago)
    const nearEnd = text.match(/[,;]\s*(\d{4})[,;.\s]*$/);
    if (nearEnd) return nearEnd[1];

    // Priority 4: any 4-digit year between 1900 and 2099
    const anyYear = text.match(/\b((?:19|20)\d{2})\b/);
    return anyYear ? anyYear[1] : null;
}

// Extract authors — handles multiple formats
function extractAuthors(text) {
    const authors = [];

    // Remove leading numbering (Vancouver/IEEE/AMA)
    const cleaned = text
        .replace(/^\s*\[\d+\]\s*/, '')    // [1]
        .replace(/^\s*\d+[\.\)]\s*/, '')   // 1. or 1)
        .replace(/^\s*\(\d+\)\s*/, '');    // (1)

    // Stop at the year or title to avoid pulling in non-author text
    const stopAt = cleaned.search(/\((?:19|20)\d{2}\)|\.\s+"|\.\s+'|\.\s+[A-Z][a-z]{2,}.*\./);
    const authorSection = stopAt > 10 ? cleaned.substring(0, stopAt) : cleaned.substring(0, 150);

    // Pattern A: "Lastname, F. M." or "Lastname, F." (Harvard/APA/MLA)
    const patternA = /([A-Z][a-z'-]+(?:\s[A-Z][a-z'-]+)?),\s*([A-Z](?:\.\s?[A-Z]\.?)*)/g;
    let match;
    const foundA = [];
    while ((match = patternA.exec(authorSection)) !== null) {
        foundA.push({ family: match[1].trim(), given: match[2].replace(/\s/g, '').trim() });
    }
    if (foundA.length > 0) return foundA;

    // Pattern B: "F. Lastname" or "F.M. Lastname" (IEEE style)
    const patternB = /([A-Z](?:\.\s?[A-Z]\.?)*)\s+([A-Z][a-z'-]+)/g;
    const foundB = [];
    while ((match = patternB.exec(authorSection)) !== null) {
        // Avoid matching journal abbreviations or titles
        if (match[2].length < 3) continue;
        foundB.push({ family: match[2].trim(), given: match[1].replace(/\s/g, '').trim() });
    }
    if (foundB.length > 0) return foundB;

    // Pattern C: "Lastname AB" (Vancouver — initials without periods)
    const patternC = /([A-Z][a-z'-]+)\s+([A-Z]{1,3})(?:[,;]|$)/g;
    const foundC = [];
    while ((match = patternC.exec(authorSection)) !== null) {
        foundC.push({ family: match[1].trim(), given: match[2].trim() });
    }
    if (foundC.length > 0) return foundC;

    return authors; // empty array if nothing matched
}

// Extract title — the trickiest field
function extractTitle(text, year) {
    // Remove author section (before year or first quoted title)
    let working = text;

    // Remove leading numbering
    working = working.replace(/^\s*\[\d+\]\s*/, '').replace(/^\s*\d+[\.\)]\s*/, '').replace(/^\s*\(\d+\)\s*/, '');

    // Strategy 1: title in single quotes (Harvard)
    const singleQuoted = working.match(/'([^']{10,})'/);
    if (singleQuoted) return singleQuoted[1].trim();

    // Strategy 2: title in double quotes (MLA/IEEE/Chicago)
    const doubleQuoted = working.match(/"([^"]{10,})"/);
    if (doubleQuoted) return doubleQuoted[1].trim();

    // Strategy 3: title follows year in parentheses (APA/Harvard)
    if (year) {
        const afterYear = working.match(new RegExp('\\(' + year + '\\)\\.?\\s+([^.]{15,}?)(?:\\.|$)'));
        if (afterYear) return afterYear[1].trim();
    }

    // Strategy 4: title is between author section and journal name
    // Remove everything before year, take next sentence-like chunk
    if (year) {
        const yearIdx = working.indexOf(year);
        if (yearIdx !== -1) {
            const afterYearText = working.substring(yearIdx + year.length).replace(/^[\s().]+/, '');
            const titleChunk = afterYearText.match(/^([^.]{15,}?)\./);
            if (titleChunk) return titleChunk[1].trim();
        }
    }

    return null;
}

// Extract journal/container title
function extractJournal(text, title) {
    // Remove the article title to avoid confusion
    let working = text;
    if (title) {
        working = working.replace(title, '§TITLE§');
    }

    // After the title marker, look for the journal name
    // Journal names are typically: proper-cased multi-word names before volume/year info
    const patterns = [
        // After title, before vol/no/year
        /§TITLE§[^.]*\.\s+([A-Z][a-zA-Z &-]{3,50}),?\s+(?:vol\.|Vol\.|v\.|no\.|pp\.|\d+[(\s])/,
        // Italic indicator pattern (journal after title before volume)
        /['"]\s*\.?\s+([A-Z][A-Za-z &-]{3,50})\s*,\s*(?:vol|Vol|v\.|no\.|pp\.|\d+)/,
        // Just look for multi-word proper noun after title period
        /\.\s+([A-Z][A-Za-z]+(?: [A-Z][A-Za-z]+){1,4})[,\s]+(?:vol|Vol|\d+\s*[\(:])/
    ];

    for (const pattern of patterns) {
        const match = working.match(pattern);
        if (match && match[1] && match[1].length > 3) {
            return match[1].trim().replace(/[,;]+$/, '');
        }
    }

    return null;
}

// Extract volume
function extractVolume(text) {
    const patterns = [
        /\bvol\.?\s*(\d+)/i,
        /\bvolume\s+(\d+)/i,
        /,\s*(\d+)\s*[\(;:]/,  // implicit volume before issue
    ];
    for (const pattern of patterns) {
        const match = text.match(pattern);
        if (match) return match[1];
    }
    return null;
}

// Extract issue number
function extractIssue(text) {
    const patterns = [
        /\bno\.?\s*(\d+)/i,
        /\bnumber\s+(\d+)/i,
        /\bissue\s+(\d+)/i,
        /\((\d+)\)/,  // issue in parentheses after volume
    ];
    for (const pattern of patterns) {
        const match = text.match(pattern);
        if (match) return match[1];
    }
    return null;
}

// Extract page range
function extractPages(text) {
    const patterns = [
        /\bpp\.?\s*(\d+[-–]\d+)/i,
        /\bpages?\s+(\d+[-–]\d+)/i,
        /[,:]\s*(\d{1,5}[-–]\d{1,5})\s*[,;.\n]/,
        /:(\d+[-–]\d+)/,
    ];
    for (const pattern of patterns) {
        const match = text.match(pattern);
        if (match) return match[1].replace('–', '-');
    }
    return null;
}

// Extract publisher (for books)
function extractPublisher(text) {
    // Publisher typically appears after place of publication: "London: Publisher"
    const withPlace = text.match(/[A-Z][a-z]+(?:,\s?[A-Z][a-z]+)?:\s+([A-Z][A-Za-z &.,]+?)(?:[,;.]|$)/);
    if (withPlace) return withPlace[1].trim();
    return null;
}

// Extract place of publication (for books)
function extractPlace(text) {
    const match = text.match(/([A-Z][a-z]+(?:,\s?[A-Z][a-z]+)?):\s+[A-Z][A-Za-z]/);
    return match ? match[1].trim() : null;
}

// Detect reference type
function detectType(text, journal, doi) {
    // Clues for book chapter
    if (/\bin\b/i.test(text) && /\bEd(s|itors?)\b|\bed\./i.test(text)) return 'chapter';

    // Clues for conference paper
    if (/\bconference\b|\bproceedings\b|\bproc\./i.test(text)) return 'paper-conference';

    // Clues for thesis
    if (/\bthesis\b|\bdissertation\b|\bphd\b|\bmaster/i.test(text)) return 'thesis';

    // Clues for website/webpage
    if (/\bavailable\s+(?:at|from)\b|\baccessed\b|\bretrieved\b/i.test(text)) return 'webpage';

    // Has journal name or DOI → journal article
    if (journal || doi) return 'article-journal';

    // Has volume/issue → likely journal
    if (/\bvol\b|\bno\b|\bissue\b/i.test(text)) return 'article-journal';

    // Fallback: book
    return 'book';
}

// ── Confidence scoring ─────────────────────────────────────────────
// How confident are we in the extracted fields?
function scoreConfidence(fields) {
    let score = 0;
    let total = 0;

    const checks = [
        { field: fields.author?.length > 0, weight: 25 },
        { field: !!fields.year, weight: 20 },
        { field: !!fields.title, weight: 25 },
        { field: !!fields.journal || fields.type === 'book', weight: 15 },
        { field: !!fields.doi || !!fields.url, weight: 10 },
        { field: !!fields.pages, weight: 5 },
    ];

    for (const { field, weight } of checks) {
        total += weight;
        if (field) score += weight;
    }

    return Math.round((score / total) * 100);
}

// ── Main export ────────────────────────────────────────────────────
/**
 * Extract structured metadata from a raw reference string.
 *
 * @param {string} rawReference - The raw reference string
 * @param {string} [id] - Optional ID for citeproc (auto-generated if omitted)
 * @returns {{
 *   cslJson: Object,      // CSL-JSON object ready for citeproc
 *   confidence: number,   // 0-100 how confident we are in the extraction
 *   raw: string           // original input
 * }}
 */
export function extractMetadata(rawReference, id) {
    const text = rawReference.trim();
    const itemId = id || `ref_${Math.random().toString(36).substring(2, 9)}`;

    const doi = extractDOI(text);
    const url = doi ? null : extractURL(text);
    const year = extractYear(text);
    const authors = extractAuthors(text);
    const title = extractTitle(text, year);
    const journal = extractJournal(text, title);
    const volume = extractVolume(text);
    const issue = extractIssue(text);
    const pages = extractPages(text);
    const publisher = extractPublisher(text);
    const place = extractPlace(text);
    const type = detectType(text, journal, doi);

    // Build CSL-JSON object
    const cslJson = { id: itemId, type };

    if (authors.length > 0) cslJson.author = authors;
    if (year) cslJson.issued = { 'date-parts': [[parseInt(year, 10)]] };
    if (title) cslJson.title = title;
    if (journal) cslJson['container-title'] = journal;
    if (volume) cslJson.volume = volume;
    if (issue) cslJson.issue = issue;
    if (pages) cslJson.page = pages;
    if (doi) cslJson.DOI = doi;
    if (url) cslJson.URL = url;
    if (publisher) cslJson.publisher = publisher;
    if (place) cslJson['publisher-place'] = place;

    // Add accessed date for webpages
    if (type === 'webpage' && !year) {
        const now = new Date();
        cslJson.accessed = { 'date-parts': [[now.getFullYear(), now.getMonth() + 1, now.getDate()]] };
    }

    const confidence = scoreConfidence({
        author: authors,
        year,
        title,
        journal,
        doi,
        url,
        pages,
        type
    });

    return { cslJson, confidence, raw: text };
}

/**
 * Extract metadata from multiple references at once.
 *
 * @param {string[]} references - Array of raw reference strings
 * @returns {{
 *   items: Array,           // Array of {cslJson, confidence, raw}
 *   avgConfidence: number,  // Average confidence across all items
 *   highConfidence: number, // Count with confidence >= 70
 *   lowConfidence: number   // Count with confidence < 40
 * }}
 */
export function extractMetadataBatch(references) {
    const items = references.map((ref, i) => extractMetadata(ref, `ref_${i + 1}`));
    const avgConfidence = Math.round(items.reduce((sum, i) => sum + i.confidence, 0) / items.length);
    const highConfidence = items.filter(i => i.confidence >= 70).length;
    const lowConfidence = items.filter(i => i.confidence < 40).length;
    return { items, avgConfidence, highConfidence, lowConfidence };
}
