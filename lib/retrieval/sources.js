import { validateSourceState } from './continuation.js';
import { normalizeOpenAlex, normalizeCrossref } from './papers.js';
async function getJSON(url, fetchImpl) {
    const r = await fetchImpl(url, { signal: AbortSignal.timeout(10000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
}
export const sources = {
    openalex: async ({ query, yearFrom, yearTo, state = {}, pageSize, fetchImpl }) => {
        validateSourceState('openalex', state);
        const url = new URL('https://api.openalex.org/works');
        url.searchParams.set('search',query); url.searchParams.set('per-page',pageSize);
        url.searchParams.set('cursor',state?.cursor || '*');
        if (yearFrom || yearTo) url.searchParams.set('filter',`publication_year:${yearFrom || 1}-${yearTo || new Date().getFullYear()}`);
        const data = await getJSON(url,fetchImpl);
        if (!Array.isArray(data.results)) throw new Error('Invalid OpenAlex response');
        const continuation = data.results.length && data.meta?.next_cursor ? {cursor:data.meta.next_cursor} : null;
        validateSourceState('openalex', continuation);
        if (continuation?.cursor === (state?.cursor || '*')) throw new Error('OpenAlex continuation did not advance');
        return { papers:data.results.map(normalizeOpenAlex), total:data.meta?.count ?? null, continuation };
    },
    crossref: async ({ query, yearFrom, yearTo, state = {}, pageSize, fetchImpl }) => {
        validateSourceState('crossref', state);
        const url = new URL('https://api.crossref.org/works');
        url.searchParams.set('query.bibliographic',query); url.searchParams.set('rows',pageSize);
        url.searchParams.set('sort','relevance'); url.searchParams.set('order','desc');
        // Crossref relevance searches use offsets, not OpenAlex cursors.
        const offset = state?.offset ?? 0;
        if (!Number.isInteger(offset) || offset < 0 || offset > 10000) throw new Error('Invalid Crossref offset');
        url.searchParams.set('offset',offset);
        const filters=[];
        if(yearFrom) filters.push(`from-pub-date:${yearFrom}-01-01`);
        if(yearTo) filters.push(`until-pub-date:${yearTo}-12-31`);
        if(filters.length) url.searchParams.set('filter',filters.join(','));
        const data = await getJSON(url,fetchImpl); const m=data.message;
        if (!Array.isArray(m?.items)) throw new Error('Invalid Crossref response');
        return {papers:m.items.map(normalizeCrossref),total:m['total-results'] ?? null,
            continuation:m.items.length && offset + m.items.length < m['total-results'] && offset + m.items.length <= 10000 ? {offset:offset+m.items.length} : null};
    }
};
