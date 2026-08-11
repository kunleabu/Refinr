// ═══════════════════════════════════════════════════════════════════
// api/lookup.js — Reference Intelligence Engine
// DOI/ISBN lookup, URL extraction, title search.
// Metadata from CrossRef/OpenAlex/OpenLibrary feeds directly into
// the CSL formatter — Groq is not used for formatting output.
// ═══════════════════════════════════════════════════════════════════

import { formatSingle } from '../lib/formatter.js';

async function lookupDOI(doi) {
    const cleaned = doi.trim().replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '');
    try {
        const r = await fetch(`https://api.crossref.org/works/${encodeURIComponent(cleaned)}`);
        if (!r.ok) return null;
        const d = await r.json();
        const item = d.message;
        return {
            id: `doi_${Math.random().toString(36).substring(2, 9)}`,
            type: item.type === 'book-chapter' ? 'chapter' :
                  item.type === 'proceedings-article' ? 'paper-conference' :
                  item.type === 'book' ? 'book' : 'article-journal',
            author: item.author?.map(a => ({ family: a.family || '', given: a.given || '' })) || [],
            issued: { 'date-parts': [item.issued?.['date-parts']?.[0] || [new Date().getFullYear()]] },
            title: item.title?.[0] || '',
            'container-title': item['container-title']?.[0] || '',
            volume: item.volume || undefined,
            issue: item.issue || undefined,
            page: item.page || undefined,
            DOI: item.DOI || cleaned,
            publisher: item.publisher || undefined,
            'publisher-place': item['publisher-location'] || undefined
        };
    } catch { return null; }
}

async function lookupISBN(isbn) {
    const digits = isbn.replace(/[-\s]/g, '');
    try {
        const r = await fetch(`https://openlibrary.org/api/books?bibkeys=ISBN:${digits}&format=json&jscmd=data`);
        if (!r.ok) return null;
        const d = await r.json();
        const book = d[`ISBN:${digits}`];
        if (!book) return null;
        return {
            id: `isbn_${Math.random().toString(36).substring(2, 9)}`,
            type: 'book',
            author: book.authors?.map(a => {
                const parts = (a.name || '').split(' ');
                return { family: parts.slice(-1)[0] || '', given: parts.slice(0, -1).join(' ') || '' };
            }) || [],
            issued: { 'date-parts': [[parseInt(book.publish_date) || new Date().getFullYear()]] },
            title: book.title || '',
            publisher: book.publishers?.[0]?.name || '',
            'publisher-place': book.publish_places?.[0]?.name || '',
            ISBN: digits
        };
    } catch { return null; }
}

async function lookupPubMed(pmid) {
    try {
        const r = await fetch(`https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=pubmed&id=${pmid}&retmode=json`);
        if (!r.ok) return null;
        const d = await r.json();
        const article = d.result?.[pmid];
        if (!article) return null;
        const doiMatch = (article.elocationid || '').match(/10\.\d{4,9}\/\S+/);
        return {
            id: `pubmed_${pmid}`,
            type: 'article-journal',
            author: article.authors?.map(a => {
                const parts = (a.name || '').split(' ');
                return { family: parts[0] || '', given: parts.slice(1).join(' ') || '' };
            }) || [],
            issued: { 'date-parts': [[parseInt(article.pubdate?.split(' ')?.[0]) || new Date().getFullYear()]] },
            title: article.title || '',
            'container-title': article.fulljournalname || article.source || '',
            volume: article.volume || undefined,
            issue: article.issue || undefined,
            page: article.pages || undefined,
            DOI: doiMatch ? doiMatch[0] : undefined
        };
    } catch { return null; }
}

async function searchByTitle(query) {
    try {
        const r = await fetch(`https://api.crossref.org/works?query=${encodeURIComponent(query)}&rows=1`);
        if (!r.ok) return null;
        const d = await r.json();
        const item = d.message.items?.[0];
        if (!item || item.score < 3) return null;
        return {
            id: `title_${Math.random().toString(36).substring(2, 9)}`,
            type: 'article-journal',
            author: item.author?.map(a => ({ family: a.family || '', given: a.given || '' })) || [],
            issued: { 'date-parts': [item.issued?.['date-parts']?.[0] || []] },
            title: item.title?.[0] || '',
            'container-title': item['container-title']?.[0] || '',
            volume: item.volume || undefined,
            issue: item.issue || undefined,
            page: item.page || undefined,
            DOI: item.DOI || undefined,
            publisher: item.publisher || undefined
        };
    } catch { return null; }
}

async function searchOpenAlex(query) {
    try {
        const r = await fetch(`https://api.openalex.org/works?search=${encodeURIComponent(query)}&per-page=1`);
        if (!r.ok) return null;
        const d = await r.json();
        const item = d.results?.[0];
        if (!item) return null;
        const doiClean = item.doi?.replace('https://doi.org/', '');
        return {
            id: `openalex_${Math.random().toString(36).substring(2, 9)}`,
            type: 'article-journal',
            author: item.authorships?.map(a => {
                const name = a.author?.display_name || '';
                const parts = name.split(' ');
                return { family: parts.slice(-1)[0] || '', given: parts.slice(0, -1).join(' ') || '' };
            }) || [],
            issued: { 'date-parts': [[item.publication_year || new Date().getFullYear()]] },
            title: item.title || '',
            'container-title': item.primary_location?.source?.display_name || '',
            DOI: doiClean || undefined
        };
    } catch { return null; }
}

async function lookupURL(url) {
    const doiMatch = url.match(/10\.\d{4,9}\/[^\s&?#]+/);
    if (doiMatch) {
        const doi = doiMatch[0].replace(/[.,;)\]]+$/, '');
        const result = await lookupDOI(doi);
        if (result) return result;
    }
    if (url.includes('pubmed.ncbi.nlm.nih.gov')) {
        const pmidMatch = url.match(/\/(\d+)\/?/);
        if (pmidMatch) {
            const result = await lookupPubMed(pmidMatch[1]);
            if (result) return result;
        }
    }
    if (url.match(/nature\.com|science\.org|cell\.com/)) {
        const slug = url.split('/').pop().replace(/-/g, ' ');
        if (slug && slug.length > 5) {
            const result = await searchByTitle(slug);
            if (result) return result;
        }
    }
    return {
        id: `url_${Math.random().toString(36).substring(2, 9)}`,
        type: 'webpage',
        title: url,
        URL: url,
        accessed: {
            'date-parts': [[new Date().getFullYear(), new Date().getMonth() + 1, new Date().getDate()]]
        }
    };
}

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const { action, identifiers, urls, titles, format } = req.body;
    if (!format) return res.status(400).json({ error: 'Missing format' });

    // ── DOI / ISBN lookup ──────────────────────────────────────────
    if (action === 'identifiers') {
        if (!identifiers) return res.status(400).json({ error: 'Missing identifiers' });
        const lines = identifiers.split('\n').filter(l => l.trim().length > 0);
        const results = [];
        for (const line of lines) {
            const trimmed = line.trim();
            let metadata = null;
            if (/^10\.\d{4,9}\//.test(trimmed) || trimmed.includes('doi.org')) {
                metadata = await lookupDOI(trimmed);
            } else if (/^\d[\d\s-]{8,}\d$/.test(trimmed)) {
                metadata = await lookupISBN(trimmed);
            } else if (/^\d{7,8}$/.test(trimmed)) {
                metadata = await lookupPubMed(trimmed);
            }
            if (metadata) {
                try {
                    const formatted = await formatSingle(metadata, format);
                    const doiNote = metadata.DOI ? `\n   🔗 DOI: ${metadata.DOI}` : '';
                    results.push(`✅ ${formatted}${doiNote}`);
                } catch {
                    results.push(`⚠️ Found metadata but could not format — ${trimmed}`);
                }
            } else {
                results.push(`❌ NOT FOUND — ${trimmed}`);
            }
        }
        return res.status(200).json({ results });
    }

    // ── URL lookup ─────────────────────────────────────────────────
    if (action === 'url') {
        if (!urls) return res.status(400).json({ error: 'Missing urls' });
        const urlList = urls.split('\n').filter(u => u.trim().length > 0);
        const results = [];
        for (const url of urlList) {
            try {
                const metadata = await lookupURL(url.trim());
                const formatted = await formatSingle(metadata, format);
                results.push(`✅ ${formatted}`);
            } catch {
                results.push(`⚠️ Could not extract reference from ${url.trim()}`);
            }
        }
        return res.status(200).json({ results });
    }

    // ── Title search ───────────────────────────────────────────────
    if (action === 'title') {
        if (!titles) return res.status(400).json({ error: 'Missing titles' });
        const titleList = titles.split('\n').filter(t => t.trim().length > 0);
        const results = [];
        for (const query of titleList) {
            const trimmed = query.trim();
            try {
                let metadata = await searchByTitle(trimmed);
                if (!metadata) metadata = await searchOpenAlex(trimmed);
                if (metadata) {
                    const formatted = await formatSingle(metadata, format);
                    const doiNote = metadata.DOI ? `\n   🔗 DOI: ${metadata.DOI}` : '';
                    results.push(`✅ ${formatted}${doiNote}`);
                } else {
                    results.push(`❌ NOT FOUND — "${trimmed}"`);
                }
            } catch {
                results.push(`⚠️ ERROR searching — "${trimmed}"`);
            }
        }
        return res.status(200).json({ results });
    }

    return res.status(400).json({ error: 'Invalid action. Use: identifiers, url, or title' });
}
