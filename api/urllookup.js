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
            // Step 1 — Try to extract DOI from URL first
            const doiMatch = trimmed.match(/10\.\d{4,}\/[^\s]+/);

            if (doiMatch) {
                // Found a DOI in the URL — use CrossRef directly
                const doi = doiMatch[0].replace(/[.,;)\]]+$/, '');
                const crossrefResponse = await fetch(
                    `https://api.crossref.org/works/${encodeURIComponent(doi)}`
                );

                if (crossrefResponse.ok) {
                    const crossrefData = await crossrefResponse.json();
                    const item = crossrefData.message;

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
                    rawRef += `. doi: ${doi}`;

                    const formatted = await formatWithGroq(rawRef, format, apiKey);
                    results.push(`✅ ${formatted}`);
                    continue;
                }
            }

            // Step 2 — No DOI found, use Groq to extract metadata from the URL itself
            const extractResponse = await fetch('https://api.groq.com/openai/v1/chat/completions', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${apiKey}`
                },
                body: JSON.stringify({
                    model: 'llama-3.3-70b-versatile',
                    max_tokens: 400,
                    messages: [
                        {
                            role: 'system',
                            content: `You are an academic reference extractor. Given a URL, extract as much bibliographic information as you can from the URL structure itself (domain, path, identifiers). Then format it as a ${format} citation for a webpage or online resource. Include the URL and access date. Return only the formatted citation.`
                        },
                        {
                            role: 'user',
                            content: `Extract and format a ${format} reference for this URL:\n${trimmed}\n\nAccess date: ${new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}`
                        }
                    ]
                })
            });

            const extractData = await extractResponse.json();
            const formatted = extractData.choices[0].message.content.trim();
            results.push(`✅ ${formatted}`);

        } catch (error) {
            results.push(`⚠️ ERROR processing — ${trimmed}`);
        }
    }

    return res.status(200).json({ results });
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
