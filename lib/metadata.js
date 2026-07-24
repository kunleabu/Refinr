// ═══════════════════════════════════════════════════════════════════
// lib/metadata.js — Reference Intelligence Engine v2
// Pure rules-based field extractor — improved year, journal,
// publisher extraction and better handling of common citation formats.
// ═══════════════════════════════════════════════════════════════════

// ── Field extractors ───────────────────────────────────────────────

function extractDOI(text) {
    const match = text.match(/\b(10\.\d{4,9}\/[^\s,;>\])"]+)/);
    return match ? match[1].replace(/[.,;)\]]+$/, '') : null;
}

function extractURL(text) {
    const doiUrl = text.match(/https?:\/\/doi\.org\/[^\s,;>\])"]+/);
    if (doiUrl) return null;
    const match = text.match(/https?:\/\/[^\s,;>\])"]{10,}/);
    return match ? match[0].replace(/[.,;)\]]+$/, '') : null;
}

function extractYear(text) {
    // First strip volume/issue patterns to avoid matching issue numbers as years
    // e.g. Nature, 443(7111) — remove the (7111) before searching for year
    const stripped = text
        .replace(/\b\d{1,4}\s*\(\d+\)/g, '')      // removes 443(7111)
        .replace(/vol\.?\s*\d+\s*\(\d+\)/gi, '')   // removes vol.443(7111)
        .replace(/,\s*\d{1,4}\s*\(\d+\)/g, '');    // removes , 443(7111)

    // Priority 1: standalone 4-digit year in parentheses (Harvard/APA)
    // Must be a realistic year 1900-2099
    const inParens = stripped.match(/\(((?:19|20)\d{2})\)/);
    if (inParens) return inParens[1];

    // Priority 2: year after author section, before title
    // e.g. "Smith AB. 2020 Title" (Vancouver)
    const afterAuthors = stripped.match(/[A-Z]{1,3}[,.]?\s+((?:19|20)\d{2})\s+[A-Z]/);
    if (afterAuthors) return afterAuthors[1];

    // Priority 3: year with period after it (APA/Chicago)
    // e.g. "Smith, J. 2020. Title"
    const withPeriod = stripped.match(/\.\s+((?:19|20)\d{2})\./);
    if (withPeriod) return withPeriod[1];

    // Priority 4: year near end of string (MLA)
    const nearEnd = stripped.match(/[,;]\s*((?:19|20)\d{2})[,;.\s]*$/);
    if (nearEnd) return nearEnd[1];

    // Priority 5: any standalone realistic year
    const anyYear = stripped.match(/\b((?:19|20)\d{2})\b/);
    return anyYear ? anyYear[1] : null;
}

function extractAuthors(text) {
    const authors = [];

    // Remove leading numbering
    const cleaned = text
        .replace(/^\s*\[\d+\]\s*/, '')
        .replace(/^\s*\d+[\.\)]\s*/, '')
        .replace(/^\s*\(\d+\)\s*/, '');

    // Find where the author section ends
    // It ends at: year in parens, or first quoted title, or ". Title" pattern
    const stopPatterns = [
        /\((?:19|20)\d{2}\)/,           // (2020)
        /\.\s+(?:19|20)\d{2}\./,        // . 2020.
        /\.\s+"[A-Z]/,                   // . "Title
        /\.\s+'[A-Z]/,                   // . 'Title
    ];

    let stopAt = cleaned.length;
    for (const pattern of stopPatterns) {
        const match = pattern.exec(cleaned);
        if (match && match.index < stopAt) stopAt = match.index;
    }

    const authorSection = cleaned.substring(0, Math.min(stopAt, 200));

    // Pattern A: "Lastname, F.M." or "Lastname, F." (Harvard/APA)
    const patternA = /([A-Z][a-z'-]+(?:\s[A-Z][a-z'-]+)?),\s*([A-Z](?:\.[A-Z]?\.?)*)/g;
    let match;
    const foundA = [];
    while ((match = patternA.exec(authorSection)) !== null) {
        const given = match[2].replace(/\s/g, '');
        if (given.length <= 6) { // initials only, not full names that got mismatched
            foundA.push({ family: match[1].trim(), given });
        }
    }
    if (foundA.length > 0) return foundA;

    // Pattern B: "Lastname Firstname" full names with comma separator (MLA/Chicago)
    const patternB = /([A-Z][a-z'-]+),\s+([A-Z][a-z]+(?:\s[A-Z][a-z]+)?)/g;
    const foundB = [];
    while ((match = patternB.exec(authorSection)) !== null) {
        if (match[2].length > 2) {
            foundB.push({ family: match[1].trim(), given: match[2].trim() });
        }
    }
    if (foundB.length > 0) return foundB;

    // Pattern C: "F. Lastname" (IEEE style)
    const patternC = /([A-Z](?:\.\s?[A-Z]\.?)*)\s+([A-Z][a-z'-]{2,})/g;
    const foundC = [];
    while ((match = patternC.exec(authorSection)) !== null) {
        foundC.push({ family: match[2].trim(), given: match[1].replace(/\s/g, '').trim() });
    }
    if (foundC.length > 0) return foundC;

    // Pattern D: "Lastname AB" (Vancouver — initials without periods)
    const patternD = /([A-Z][a-z'-]+)\s+([A-Z]{1,3})(?:[,;]|\s|$)/g;
    const foundD = [];
    while ((match = patternD.exec(authorSection)) !== null) {
        foundD.push({ family: match[1].trim(), given: match[2].trim() });
    }
    if (foundD.length > 0) return foundD;

    return authors;
}

function extractTitle(text, year) {
    let working = text
        .replace(/^\s*\[\d+\]\s*/, '')
        .replace(/^\s*\d+[\.\)]\s*/, '')
        .replace(/^\s*\(\d+\)\s*/, '');

    // Strategy 1: title in single quotes (Harvard)
    const singleQuoted = working.match(/'([^']{10,150})'/);
    if (singleQuoted) return singleQuoted[1].trim();

    // Strategy 2: title in double quotes (MLA/IEEE/Chicago)
    const doubleQuoted = working.match(/"([^"]{10,150})"/);
    if (doubleQuoted) return doubleQuoted[1].trim();

    // Strategy 3: title follows year in parentheses (APA/Harvard)
    if (year) {
        const afterYear = working.match(
            new RegExp('\\(' + year + '\\)\\.?\\s+([^.]{15,150}?)(?:\\.|$)')
        );
        if (afterYear) return afterYear[1].trim();
    }

    // Strategy 4: title follows year with period (Vancouver/AMA/APA)
    // e.g. "Smith J. 2020 Title of article. Journal"
    if (year) {
        const afterYearPeriod = working.match(
            new RegExp(year + '\\.?\\s+([A-Z][^.]{15,150})\\.')
        );
        if (afterYearPeriod) return afterYearPeriod[1].trim();
    }

    // Strategy 5: take text between first period after authors and next period
    // Works for: "Smith, J. (2020) Academic writing. Oxford Press."
    if (year) {
        const yearIdx = working.indexOf(year);
        if (yearIdx !== -1) {
            const afterYear = working.substring(yearIdx + year.length)
                .replace(/^[\s().]+/, '');
            // Take up to the next period
            const titleEnd = afterYear.search(/\.\s+[A-Z]|\.\s*$/);
            if (titleEnd > 15) return afterYear.substring(0, titleEnd).trim();
        }
    }

    return null;
}

function extractJournal(text, title, year) {
    // Remove the title from the text so we don't confuse it with the journal
    let working = text;
    if (title) working = working.replace(title, '§TITLE§');

    // Also remove year patterns to avoid false matches
    if (year) working = working.replace(new RegExp('\\(' + year + '\\)'), '§YEAR§');

    // Pattern 1: After title, before volume number
    // e.g. "§TITLE§. Nature, 443(7111)"
    const afterTitle = working.match(/§TITLE§[^.]*\.\s*([A-Z][A-Za-z &-]{2,50}?),\s*\d/);
    if (afterTitle) return afterTitle[1].trim();

    // Pattern 2: Journal name followed directly by volume
    // e.g. "Nature, 443" or "Nature 443" or "Nature, vol. 443"
    const withVolume = working.match(/([A-Z][A-Za-z &:-]{3,50}?),?\s+(?:vol\.?\s*)?\d{1,4}\s*[\(,;:]/i);
    if (withVolume) {
        const candidate = withVolume[1].trim();
        // Exclude author names and other false matches
        if (!candidate.match(/^(In|The|A|An|And|For|Of|To)$/i) && candidate.length > 3) {
            return candidate;
        }
    }

    // Pattern 3: After §TITLE§ with pp. pattern nearby
    const withPages = working.match(/§TITLE§.*?([A-Z][A-Za-z &-]{3,40}),?\s*\d+.*?pp?\./);
    if (withPages) return withPages[1].trim();

    return null;
}

function extractVolume(text) {
    const patterns = [
        /\bvol\.?\s*(\d+)/i,
        /\bvolume\s+(\d+)/i,
        // "Journal Name, 443(7111)" — volume is the number BEFORE the parenthesised issue
        /[A-Za-z],\s+(\d{1,4})\s*\(\d+\)/,
        // "Journal 443(7111)" without comma
        /[A-Za-z]\s+(\d{1,4})\s*\(\d+\)/,
        // "Journal, 443," — volume before page info
        /[A-Za-z],\s+(\d{1,4})\s*,\s*(?:pp\.|p\.|\d)/,
    ];
    for (const pattern of patterns) {
        const match = text.match(pattern);
        if (match) return match[1];
    }
    return null;
}

function extractIssue(text) {
    const patterns = [
        /\bno\.?\s*(\d+)/i,
        /\bnumber\s+(\d+)/i,
        /\bissue\s+(\d+)/i,
        // Issue in parentheses after volume: "443(7111)" → issue 7111
        /\d{1,4}\((\d+)\)/,
    ];
    for (const pattern of patterns) {
        const match = text.match(pattern);
        if (match) return match[1];
    }
    return null;
}

function extractPages(text) {
    const patterns = [
        /\bpp\.?\s*(\d+[-–]\d+)/i,
        /\bpages?\s+(\d+[-–]\d+)/i,
        /[,:]\s*(\d{1,5}[-–]\d{1,5})(?:\s|[,;.\n]|$)/,
        /:(\d+[-–]\d+)/,
    ];
    for (const pattern of patterns) {
        const match = text.match(pattern);
        if (match) return match[1].replace('–', '-');
    }
    return null;
}

function extractPublisher(text, journal) {
    // Don't extract publisher if we found a journal — it's a journal article
    if (journal) return null;

    // Pattern 1: "Place: Publisher" format
    // e.g. "London: Oxford Press" or "Cambridge: Cambridge University Press"
    const withPlace = text.match(/[A-Z][a-z]+(?:,\s?[A-Z][a-z]+)?:\s+([A-Z][A-Za-z &.,]+?)(?:[,;.]|$)/);
    if (withPlace) return withPlace[1].trim().replace(/\.$/, '');

    // Pattern 2: known publisher names appearing without place
    const knownPublishers = [
        'Oxford University Press', 'Cambridge University Press', 'Oxford Press',
        'Wiley', 'Springer', 'Elsevier', 'Routledge', 'Sage', 'Taylor & Francis',
        'MIT Press', 'Harvard University Press', 'Princeton University Press',
        'Palgrave Macmillan', 'McGraw-Hill', 'Pearson', 'Penguin'
    ];
    for (const pub of knownPublishers) {
        if (text.includes(pub)) return pub;
    }

    // Pattern 3: last proper noun phrase before end of string
    // e.g. "Smith, J. (2020) Academic writing. Oxford Press."
    const lastPhrase = text.match(/\.\s+([A-Z][A-Za-z]+(?: [A-Z][A-Za-z]+)*)\.\s*$/);
    if (lastPhrase && !lastPhrase[1].match(/^\d/) && lastPhrase[1].length > 3) {
        return lastPhrase[1].trim();
    }

    return null;
}

function extractPlace(text, publisher) {
    if (!publisher) return null;
    // "Place: Publisher"
    const match = text.match(/([A-Z][a-z]+(?:,\s?[A-Z][a-z]+)?):\s+[A-Z]/);
    return match ? match[1].trim() : null;
}

function detectType(text, journal, doi) {
    if (/\bin\b.*?\bEd(s|itors?)?\b|\bed\.\s/i.test(text)) return 'chapter';
    if (/\bconference\b|\bproceedings\b|\bproc\.\b/i.test(text)) return 'paper-conference';
    if (/\bthesis\b|\bdissertation\b|\bphd\b|\bmaster/i.test(text)) return 'thesis';
    if (/\bavailable\s+(?:at|from)\b|\baccessed\b|\bretrieved\b/i.test(text)) return 'webpage';
    if (journal || doi) return 'article-journal';
    if (/\bvol\b|\bno\b|\bissue\b/i.test(text)) return 'article-journal';
    return 'book';
}

function scoreConfidence(fields) {
    let score = 0;
    const checks = [
        { field: fields.author?.length > 0, weight: 25 },
        { field: !!fields.year, weight: 20 },
        { field: !!fields.title && fields.title.length > 10, weight: 25 },
        { field: !!fields.journal || fields.type === 'book', weight: 15 },
        { field: !!fields.doi || !!fields.url, weight: 10 },
        { field: !!fields.pages, weight: 5 },
    ];
    const total = checks.reduce((s, c) => s + c.weight, 0);
    for (const { field, weight } of checks) {
        if (field) score += weight;
    }
    return Math.round((score / total) * 100);
}

export function extractMetadata(rawReference, id) {
    const text = rawReference.trim();
    const itemId = id || `ref_${Math.random().toString(36).substring(2, 9)}`;

    const doi = extractDOI(text);
    const url = doi ? null : extractURL(text);
    const year = extractYear(text);
    const authors = extractAuthors(text);
    const title = extractTitle(text, year);
    const journal = extractJournal(text, title, year);
    const volume = extractVolume(text);
    const issue = extractIssue(text);
    const pages = extractPages(text);
    const publisher = extractPublisher(text, journal);
    const place = extractPlace(text, publisher);
    const type = detectType(text, journal, doi);

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

    if (type === 'webpage' && !year) {
        const now = new Date();
        cslJson.accessed = { 'date-parts': [[now.getFullYear(), now.getMonth() + 1, now.getDate()]] };
    }

    const confidence = scoreConfidence({ author: authors, year, title, journal, doi, url, pages, type });

    return { cslJson, confidence, raw: text };
}

export function extractMetadataBatch(references) {
    const items = references.map((ref, i) => extractMetadata(ref, `ref_${i + 1}`));
    const avgConfidence = Math.round(items.reduce((sum, i) => sum + i.confidence, 0) / items.length);
    const highConfidence = items.filter(i => i.confidence >= 70).length;
    const lowConfidence = items.filter(i => i.confidence < 40).length;
    return { items, avgConfidence, highConfidence, lowConfidence };
}
