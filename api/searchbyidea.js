// ═══════════════════════════════════════════════════════════════════
// api/searchbyidea.js — Research Discovery Engine
// Searches OpenAlex by research concept/idea.
// Results formatted via CSL/citeproc-js — no Groq for formatting.
// ═══════════════════════════════════════════════════════════════════

import { formatSingle } from '../lib/formatter.js';

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const { idea, format = 'Harvard', yearFrom, yearTo } = req.body;

    if (!idea || !idea.trim()) {
        return res.status(400).json({ error: 'Missing research idea or topic' });
    }

    try {
        // Build OpenAlex search URL with optional year filter
        let url = `https://api.openalex.org/works?search=${encodeURIComponent(idea.trim())}&per-page=10&sort=cited_by_count:desc`;
        
        if (yearFrom || yearTo) {
            const from = yearFrom || '1900';
            const to = yearTo || new Date().getFullYear();
            url += `&filter=publication_year:${from}-${to}`;
        }

        const r = await fetch(url);
        if (!r.ok) throw new Error(`OpenAlex returned ${r.status}`);

        const d = await r.json();
        const works = d.results || [];

        if (works.length === 0) {
            return res.status(200).json({
                papers: [],
                formatted: '',
                total: 0,
                message: 'No papers found for this topic. Try different keywords.'
            });
        }

        // Build CSL-JSON for each result and format
        const papers = [];
        const formattedLines = [];

        for (const work of works) {
            const doiClean = work.doi?.replace('https://doi.org/', '');

            // Build author list
            const authors = (work.authorships || []).map(a => {
                const name = a.author?.display_name || '';
                const parts = name.trim().split(' ');
                return {
                    family: parts.slice(-1)[0] || '',
                    given: parts.slice(0, -1).join(' ') || ''
                };
            });

            // Build CSL-JSON item
            const cslItem = {
                id: `idea_${work.id?.split('/').pop() || Math.random().toString(36).substring(2, 9)}`,
                type: 'article-journal',
                author: authors,
                issued: { 'date-parts': [[work.publication_year || new Date().getFullYear()]] },
                title: work.title || 'Untitled',
                'container-title': work.primary_location?.source?.display_name || '',
                DOI: doiClean || undefined,
                URL: doiClean ? `https://doi.org/${doiClean}` : (work.primary_location?.landing_page_url || undefined)
            };

            // Format via CSL
            let formatted = '';
            try {
                formatted = await formatSingle(cslItem, format);
            } catch {
                // Fallback plain text if formatting fails
                const authorStr = authors.slice(0, 3).map(a => `${a.family}, ${a.given}`).join('; ');
                formatted = `${authorStr} (${work.publication_year || 'n.d.'}) ${work.title || 'Untitled'}`;
            }

            formattedLines.push(formatted);

            // Paper card data for the UI
            papers.push({
                title: work.title || 'Untitled',
                authors: authors.map(a => `${a.family}, ${a.given}`),
                year: work.publication_year,
                journal: work.primary_location?.source?.display_name || '',
                doi: doiClean || null,
                doiUrl: doiClean ? `https://doi.org/${doiClean}` : null,
                abstract: work.abstract || null,
                citedBy: work.cited_by_count || 0,
                formatted
            });
        }

        return res.status(200).json({
            papers,
            formatted: formattedLines.join('\n'),
            total: d.meta?.count || works.length
        });

    } catch (err) {
        console.error('Search by idea error:', err.message);
        return res.status(500).json({ error: `Search failed: ${err.message}` });
    }
}
