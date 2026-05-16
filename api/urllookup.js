export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const { urls, format } = req.body;
    if (!urls || !format) {
        return res.status(400).json({ error: 'Missing urls or format' });
    }

    const apiKey = process.env.GROQ_API_KEY;
    const urlList = urls.split('\n').filter(u => u.trim().length > 0);
    let results = [];

    for (const url of urlList) {
        const trimmed = url.trim();
        if (!trimmed) continue;

        try {
            let rawRef = null;

            // Step 1 — Extract DOI from URL (standard format)
            const doiMatch = trimmed.match(/10\.\d{4,9}\/[^\s&?#]+/);

            if (doiMatch) {
                const doi = doiMatch[0].replace(/[.,;)\]]+$/, '');
                const crossrefResponse = await fetch(
                    `https://api.crossref.org/works/${encodeURIComponent(doi)}`
                );
                if (crossrefResponse.ok) {
                    const data = await crossrefResponse.json();
                    const item = data.message;
                    rawRef = buildRawRef(item, doi);
                }
            }

            // Step 2 — PubMed URL — extract PMID and query PubMed API
            if (!rawRef && trimmed.includes('pubmed.ncbi.nlm.nih.gov')) {
                const pmidMatch = trimmed.match(/\/(\d+)\/?$/);
                if (pmidMatch) {
                    const pmid = pmidMatch[1];
                    const pubmedResponse = await fetch(
                        `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=pubmed&id=${pmid}&retmode=json`
                    );
                    if (pubmedResponse.ok) {
                        const pubmedData = await pubmedResponse.json();
                        const article = pubmedData.result?.[pmid];
                        if (article) {
                            const authors = article.authors
                                ? article.authors.map(a => a.name).join('; ')
                                : 'Unknown Author';
                            const year = article.pubdate?.split(' ')?.[0] || 'n.d.';
                            const title = article.title || 'Unknown Title';
                            const journal = article.fulljournalname || article.source || '';
                            const volume = article.volume || '';
                            const issue = article.issue || '';
                            const pages = article.pages || '';
                            const doi = article.elocationid?.replace('doi: ', '') || '';

                            rawRef = `${authors} (${year}) ${title}`;
                            if (journal) rawRef += `. ${journal}`;
                            if (volume) rawRef += `, ${volume}`;
                            if (issue) rawRef += `(${issue})`;
                            if (pages) rawRef += `, pp. ${pages}`;
                            if (doi) rawRef += `. doi: ${doi}`;
                        }
                    }
                }
            }

            // Step 3 — Nature/journal URLs — try to find DOI via CrossRef title search
            if (!rawRef && (trimmed.includes('nature.com') || trimmed.includes('science.org') || trimmed.includes('cell.com'))) {
                const slug = trimmed.split('/').pop().replace(/-/g, ' ');
                const crossrefResponse = await fetch(
                    `https://api.crossref.org/works?query=${encodeURIComponent(slug)}&rows=1`
                );
                if (crossrefResponse.ok) {
                    const data = await crossrefResponse.json();
                    const item = data.message.items?.[0];
                    if (item && item.score > 5) {
                        rawRef = buildRawRef(item, item.DOI);
                    }
                }
            }

            // Step 4 — Fallback: use Groq to format as a webpage citation
            if (!rawRef) {
                const extractResponse = await fetch('https://api.groq.com/openai/v1/chat/completions', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${apiKey}`
                    },
                    body: JSON.stringify({
                        model: 'llama-3.3-70b-versatile',
                        max_tokens: 300,
                        messages: [
                            {
                                role: 'system',
                                content: `You are an academic reference formatter. Format this URL as a ${format} online/webpage citation. Include the URL and today's access date. Return only the formatted citation.`
                            },
                            {
                                role: 'user',
                                content: `Format a ${format} citation for this URL:\n${trimmed}\nAccess date: ${new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}`
                            }
                        ]
                    })
                });
                const extractData = await extractResponse.json();
                results.push(`✅ ${extractData.choices[0].message.content.trim()}`);
                continue;
            }

            const formatted = await formatWithGroq(rawRef, format, apiKey);
            results.push(`✅ ${formatted}`);

        } catch (error) {
            results.push(`⚠️ ERROR processing — ${trimmed}`);
        }
    }

    return res.status(200).json({ results });
}

function buildRawRef(item, doi) {
    const authors = item.author
        ? item.author.map(a => `${a.family || ''}, ${a.given || ''}`).join('; ')
        : 'Unknown Author';
    const year = item.issued?.['date-parts']?.[0]?.[0] || 'n.d.';
    const title = item.title?.[0] || 'Unknown Title';
    const journal = item['container-title']?.[0] || '';
    const volume = item.volume || '';
    const issue = item.issue || '';
    const pages = item.page || '';
    const publisher = item.publisher || '';

    let rawRef = `${authors} (${year}) ${title}`;
    if (journal) rawRef += `. ${journal}`;
    if (volume) rawRef += `, ${volume}`;
    if (issue) rawRef += `(${issue})`;
    if (pages) rawRef += `, pp. ${pages}`;
    if (publisher && !journal) rawRef += `. ${publisher}`;
    if (doi) rawRef += `. doi: ${doi}`;
    return rawRef;
}

async function formatWithGroq(rawRef, format, apiKey) {
    try {
        const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`
            },
            body: JSON.stringify({
                model: 'llama-3.3-70b-versatile',
                max_tokens: 300,
                messages: [
                    {
                        role: 'system',
                        content: `Format the following reference in ${format} citation style. Return only the formatted reference, nothing else.`
                    },
                    {
                        role: 'user',
                        content: rawRef
                    }
                ]
            })
        });
        const data = await response.json();
        return data.choices[0].message.content.trim();
    } catch {
        return rawRef;
    }
}
