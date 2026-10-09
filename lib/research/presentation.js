import { createHash } from 'node:crypto';
import { rankPapers, toCSL } from '../retrieval/papers.js';
import { formatSingle } from '../formatter.js';

const STOP = new Set('a an the and or of for to in on at by with from as is are was were be been being how what which that this these those does do can could would should'.split(' '));
const words = value => String(value ?? '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(/ +/).filter(w => w && !STOP.has(w));
// Mirrors the frozen SQL presentation guard; SQL remains authoritative under races.
export function newEvidence(oldQuery, newQuery, metadata) {
    const query = words(newQuery), previous = ` ${words(oldQuery).join(' ')} `;
    const documents = [metadata.title, metadata.abstract].map(v => ` ${words(v).join(' ')} `);
    for (const size of [1, 2, 3]) for (let i = 0; i + size <= query.length; i++) {
        const phrase = ` ${query.slice(i, i + size).join(' ')} `;
        if (!previous.includes(phrase) && documents.some(d => d.includes(phrase))) return true;
    }
    return false;
}
export function selectPapers(rows, session, limit) {
    const eligible = rows.filter(p => !p.merged_into_id && !p.saved_at && !p.cited_at && !p.rejected_at
        && p.last_presented_revision !== session.context_revision
        && (!p.last_presented_at || newEvidence(p.last_presented_query, session.retrieval_query, p.metadata))
        && (!session.year_from || p.metadata.year >= session.year_from)
        && (!session.year_to || p.metadata.year && p.metadata.year <= session.year_to));
    return rankPapers(eligible.map(p => ({ ...p.metadata, id: p.id })), session.retrieval_query).slice(0, limit).map(p => p.id);
}
export async function formatRows(rows, style, { formatter = formatSingle, signal } = {}) {
    const papers = [];
    for (const row of rows) {
        const paper = row.metadata;
        let formatted = '', formattingError = null;
        try {
            if (signal?.aborted) throw Error();
            // Response formatting is bounded independently of acquisition persistence.
            let timer;
            try {
                formatted = await Promise.race([formatter(toCSL(paper), style), new Promise((_, reject) => { timer = setTimeout(() => reject(Error()), 1500); })]);
            } finally { clearTimeout(timer); }
        } catch { formattingError = 'Citation formatting unavailable'; }
        papers.push({ ...paper, id: row.id, canonicalKey: row.canonical_key, rowVersion: row.row_version,
            authors: paper.authors.map(a => [a.family, a.given].filter(Boolean).join(', ')),
            doiUrl: paper.doi ? `https://doi.org/${paper.doi}` : null, formatted, formattingError,
            lifecycle: { viewedAt: row.last_viewed_at, savedAt: row.saved_at, rejectedAt: row.rejected_at, citedAt: row.cited_at } });
    }
    return { papers, formatted: papers.map(p => p.formatted).filter(Boolean).join('\n') };
}

// Identity hints for owner-scoped, read-only eligibility checks, never for merging.
// SQL rechecks full fallback equality and performs all actual identity reconciliation.
export function bibliographicIdentity(p) {
    const title = String(p.title ?? '').normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim();
    const name = v => String(v ?? '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
    if (!title || !Number.isInteger(p.year) || p.year < 1 || !p.authors?.length || p.authors.some(a => !a.family?.trim() || !a.given?.trim())) return null;
    return [title, p.year, p.authors.map(a => [name(a.family), name(a.given)])];
}
export function paperAliases(p) {
    const aliases = new Set([p.id]);
    if (p.doi) aliases.add(`doi:${p.doi}`);
    for (const [source, id] of Object.entries(p.identifiers)) if (source !== 'doi' && typeof id === 'string' && id.trim()) aliases.add(`${source}:${id}`);
    for (const entry of p.provenance) if (typeof entry.id === 'string' && entry.id.trim()) aliases.add(`${entry.source}:${entry.id}`);
    const bib = bibliographicIdentity(p);
    // PostgreSQL JSONB array text uses comma-space separators (there are no objects here).
    const jsonbArray = v => Array.isArray(v) ? `[${v.map(jsonbArray).join(', ')}]` : JSON.stringify(v);
    if (bib) aliases.add(`bibmeta:${createHash('md5').update(jsonbArray(bib)).digest('hex')}`);
    return [...aliases];
}
export function rankRows(rows, query) {
    const byId = new Map(rows.map(row => [row.id, row]));
    return rankPapers(rows.map(row => ({ ...row.metadata, id: row.id })), query).map(p => byId.get(p.id));
}
export async function selectAcquired(papers, session, repo, limit) {
    const hints = papers.map(paperAliases);
    const aliases = await repo.findAliases(session.id, [...new Set(hints.flat())]);
    const ids = [...new Set(aliases.filter(a => !a.ambiguous && a.paper_id).map(a => a.paper_id))];
    const reads = [];
    for (let i = 0; i < ids.length; i += 40) reads.push(repo.paperRows(session.id, ids.slice(i, i + 40)));
    const existing = (await Promise.all(reads)).flat();
    const candidates = [];
    for (let i = 0; i < papers.length; i++) {
        const paper = papers[i];
        // A fallback hash is only a lookup hint, never evidence of identity by itself.
        const valid = aliases.filter(a => hints[i].includes(a.alias) && !a.ambiguous).map(a => {
            const r = existing.find(row => row.id === a.paper_id);
            if (!r || (r.metadata.doi && paper.doi && r.metadata.doi !== paper.doi)) return null;
            if (a.alias.startsWith('bib:') || a.alias.startsWith('bibmeta:')) {
                const old = bibliographicIdentity(r.metadata), fresh = bibliographicIdentity(paper);
                if (!old || !fresh || JSON.stringify(old) !== JSON.stringify(fresh)) return null;
            }
            return r;
        }).filter(Boolean);
        // Conservatively suppress if any legitimately matching lifecycle would suppress the merged root.
        if (valid.some(r => !selectPapers([{ ...r, metadata: { ...r.metadata, ...Object.fromEntries(Object.entries(paper).filter(([,v]) => v !== null && v !== '' && (!Array.isArray(v) || v.length))) } }], session, 1).length)) continue;
        candidates.push({ id: paper.id, metadata: paper });
    }
    return selectPapers(candidates, session, limit);
}
