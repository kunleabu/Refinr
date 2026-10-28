import { createHash } from 'node:crypto';
const hash = value => createHash('sha256').update(value).digest('hex').slice(0, 24);
export function normalizeDOI(value) {
    if (typeof value !== 'string') return null;
    let doi = value.trim();
    if (/^https?:\/\/(?:dx\.)?doi\.org\//i.test(doi)) {
        try { doi = new URL(doi).pathname.slice(1); } catch { return null; }
    } else doi = doi.replace(/^doi:\s*/i, '');
    try { doi = decodeURIComponent(doi); } catch { return null; }
    return /^10\.\d{4,9}\/\S+$/i.test(doi) ? doi.toLowerCase() : null;
}
const text = value => typeof value === 'string' ? value.trim() : '';
const titleKey = value => text(value).normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
const keyText = value => text(value).normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
export function reconstructAbstract(index) {
    if (!index || typeof index !== 'object') return null;
    const words = [];
    for (const [word, positions] of Object.entries(index)) {
        if (!Array.isArray(positions)) continue;
        for (const p of positions) if (Number.isInteger(p) && p >= 0 && p < 100000) words[p] = word;
    }
    return words.filter(Boolean).join(' ') || null;
}
export function crossrefAbstract(value) {
    return text(value).replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#(?:x([0-9a-f]+)|(\d+));/gi, (_, hex, dec) => {
        const code = parseInt(hex || dec, hex ? 16 : 10);
        return code <= 0x10ffff ? String.fromCodePoint(code) : '';
    }).replace(/\s+/g, ' ').trim() || null;
}
function finish(paper, source, sourceId, score) {
    paper.doi = normalizeDOI(paper.doi);
    paper.year = Number.isInteger(paper.year) && paper.year > 0 ? paper.year : null;
    paper.identifiers = { doi: paper.doi, [source]: sourceId || null };
    paper.provenance = [{ source, id: sourceId || null, relevance: Number.isFinite(score) ? score : null }];
    paper.citationCounts = { [source]: paper.citedBy || 0 };
    paper.id = paper.doi ? `doi:${paper.doi}` : fallbackKey(paper) ? `bib:${hash(fallbackKey(paper))}` : `${source}:${sourceId || hash(JSON.stringify([paper.title, paper.year, paper.authors]))}`;
    return paper;
}
export function normalizeOpenAlex(work) {
    const authors = (work.authorships || []).map(({ author }) => {
        const name = text(author?.display_name); const parts = name.split(/\s+/);
        return { family: parts.pop() || '', given: parts.join(' '), orcid: author?.orcid || null };
    });
    return finish({ title: text(work.title || work.display_name), year: work.publication_year, authors,
        type: work.type === 'book' ? 'book' : work.type === 'dissertation' ? 'thesis' : 'article-journal',
        journal: text(work.primary_location?.source?.display_name), doi: work.doi,
        url: work.primary_location?.landing_page_url || null, abstract: reconstructAbstract(work.abstract_inverted_index),
        volume: text(work.biblio?.volume), issue: text(work.biblio?.issue),
        page: [work.biblio?.first_page, work.biblio?.last_page].filter(Boolean).join('-'),
        publisher: '', citedBy: work.cited_by_count || 0
    }, 'openalex', work.id, work.relevance_score);
}
export function normalizeCrossref(work) {
    const date = [work.published, work.issued, work['published-print'], work['published-online']].find(d => Number.isInteger(d?.['date-parts']?.[0]?.[0]));
    return finish({ title: text(work.title?.[0]), year: date?.['date-parts']?.[0]?.[0],
        authors: (work.author || []).map(a => ({ family: text(a.family || a.name), given: text(a.given), orcid: a.ORCID || null })),
        type: ({ book: 'book', 'book-chapter': 'chapter', 'proceedings-article': 'paper-conference', dissertation: 'thesis' })[work.type] || 'article-journal',
        journal: text(work['container-title']?.[0]), doi: work.DOI, url: work.URL || null,
        abstract: crossrefAbstract(work.abstract), volume: text(work.volume), issue: text(work.issue), page: text(work.page),
        publisher: text(work.publisher), citedBy: work['is-referenced-by-count'] || 0
    }, 'crossref', work.DOI || work.URL, work.score);
}
function fallbackKey(p) {
    if (!p.title || !p.year || !p.authors.length || p.authors.some(a => !a.family || !a.given)) return null;
    // Exact normalized title, year, and ordered full author names. No fuzzy matching.
    return JSON.stringify([titleKey(p.title), p.year, p.authors.map(a => [keyText(a.family), keyText(a.given)])]);
}
export function mergePapers(papers) {
    const groups = [];
    // DOI-bearing records first so a DOI-less record cannot bridge conflicting DOIs.
    for (const p of [...papers].sort((a, b) => Number(!!b.doi) - Number(!!a.doi) || a.id.localeCompare(b.id) || a.provenance[0].source.localeCompare(b.provenance[0].source))) {
        const key = fallbackKey(p);
        let candidates = groups.filter(g => (p.doi && g.doi === p.doi) || g.id === p.id);
        if (!candidates.length && key) candidates = groups.filter(g => fallbackKey(g) === key && !(g.doi && p.doi && g.doi !== p.doi));
        if (candidates.length !== 1) { groups.push(structuredClone(p)); continue; }
        const g = candidates[0];
        for (const field of ['title','year','journal','doi','url','abstract','volume','issue','page','publisher']) if (!g[field] && p[field]) g[field] = p[field];
        if (!g.authors.length && p.authors.length) g.authors = structuredClone(p.authors);
        // Crossref supplies structured names and bibliographic fields; retain original records for conflicts.
        if (p.provenance.some(s => s.source === 'crossref')) {
            for (const field of ['authors','type','volume','issue','page','publisher']) if (p[field]?.length) g[field] = structuredClone(p[field]);
        }
        g.identifiers = { ...g.identifiers, ...Object.fromEntries(Object.entries(p.identifiers).filter(([,v]) => v)) };
        g.provenance.push(...p.provenance);
        if (p.sourceRecords) g.sourceRecords = [...(g.sourceRecords || []), ...p.sourceRecords];
        for (const [source, count] of Object.entries(p.citationCounts)) g.citationCounts[source] = Math.max(g.citationCounts[source] || 0, count);
        g.citedBy = Math.max(...Object.values(g.citationCounts));
        g.id = g.doi ? `doi:${g.doi}` : fallbackKey(g) ? `bib:${hash(fallbackKey(g))}` : g.id;
    }
    return groups;
}
// Ranking normalization is deliberately separate from conservative identity matching.
const STOP_WORDS = new Set('a an the and or of for to in on at by with from as is are was were be been being how what which that this these those does do can could would should'.split(' '));
function rankingTokens(value) {
    const tokens = keyText(value).split(' ').filter(Boolean);
    const informative = tokens.filter(token => !STOP_WORDS.has(token));
    return informative.length ? informative : tokens;
}
function phraseCoverage(queryTokens, documentTokens) {
    const document = ` ${documentTokens.join(' ')} `;
    let matched = 0, possible = 0;
    // Contiguous informative bigrams/trigrams reward concepts without stemming or synonyms.
    for (const size of [2, 3]) {
        const phrases = new Set();
        for (let i = 0; i + size <= queryTokens.length; i++) phrases.add(queryTokens.slice(i, i + size).join(' '));
        for (const phrase of phrases) {
            possible += size - 1;
            if (document.includes(` ${phrase} `)) matched += size - 1;
        }
    }
    return possible ? matched / possible : 0;
}
export function rankPapers(papers, query) {
    const queryTokens = rankingTokens(query);
    const tokens = [...new Set(queryTokens)];
    return papers.map(p => {
        const titleTokens = rankingTokens(p.title), abstractTokens = rankingTokens(p.abstract);
        const title = new Set(titleTokens), abstract = new Set(abstractTokens);
        const coverage = tokens.length ? tokens.reduce((sum, token) => sum + (title.has(token) ? 1 : abstract.has(token) ? 0.35 : 0), 0) / tokens.length : 0;
        const titlePhrase = phraseCoverage(queryTokens, titleTokens);
        const abstractPhrase = phraseCoverage(queryTokens, abstractTokens);
        const relevance = coverage + 0.5 * titlePhrase + 0.15 * abstractPhrase;
        const bestRanks = new Map();
        for (const source of p.provenance) if (source.rank) bestRanks.set(source.source, Math.min(bestRanks.get(source.source) || Infinity, source.rank));
        const sourceSupport = [...bestRanks.values()].reduce((sum, rank) => sum + 1 / (60 + rank), 0);
        return { ...p, ranking: { relevance, coverage, titlePhrase, abstractPhrase, sourceSupport, citationSupport: Math.log1p(Math.max(0,p.citedBy)) } };
    }).sort((a,b) => b.ranking.relevance - a.ranking.relevance || b.ranking.sourceSupport - a.ranking.sourceSupport || b.ranking.citationSupport - a.ranking.citationSupport || a.id.localeCompare(b.id));
}
export function toCSL(p) {
    return { id:p.id, type:p.type, title:p.title || 'Untitled', author:p.authors,
        ...(p.year ? { issued:{'date-parts':[[p.year]]} } : {}), 'container-title':p.journal,
        DOI:p.doi || undefined, URL:p.doi ? `https://doi.org/${p.doi}` : p.url || undefined,
        volume:p.volume || undefined, issue:p.issue || undefined, page:p.page || undefined, publisher:p.publisher || undefined };
}
