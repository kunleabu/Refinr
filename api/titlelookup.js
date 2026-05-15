export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const { titles, format } = req.body;
    if (!titles || !format) {
        return res.status(400).json({ error: 'Missing titles or format' });
    }

    const apiKey = process.env.GROQ_API_KEY;
    const titleList = titles.split('\n').filter(t => t.trim().length > 0);
    let results = [];

    for (const title of titleList) {
        const query = title.trim();
        if (!query) continue;

        try {
            // Search CrossRef by title/author
            const crossrefResponse = await fetch(
                `https://api.crossref.org/works?query=${encodeURIComponent(query)}&rows=1`
            );
            const crossrefData = await crossrefResponse.json();
            const item = crossrefData.message.items[0];

            if (!item || item.score < 3) {
                // Try OpenAlex as backup
                const openAlexResponse = await fetch(
                    `https://api.openalex.org/works?search=${encodeURIComponent(query)}&per-page=1`
                );
                const openAlexData = await openAlexResponse.json();
                const alexItem = openAlexData.results?.[0];

                if (!alexItem) {
                    results.push(`❌ NOT FOUND — "${query}"`);
                    continue;
                }

                // Build reference from OpenAlex data
                const authors = alexItem.authorships
                    ? alexItem.authorships.map(a => a.author?.display_name || '').join('; ')
                    : 'Unknown Author';
                const year = alexItem.publication_year || 'n.d.';
                const foundTitle = alexItem.title || 'Unknown Title';
                const journal = alexItem.primary_location?.source?.display_name || '';
                const doi = alexItem.doi || '';

                let rawRef = `${authors} (${year}) ${foundTitle}`;
                if (journal) rawRef += `. ${journal}`;
                if (doi) rawRef += `. doi: ${doi}`;

                // Format with Groq
                const formatted = await formatWithGroq(rawRef, format, apiKey);
                results.push(`✅ ${formatted}`);
                continue;
            }

            // Build reference from CrossRef data
            const authors = item.author
                ? item.author.map(a => `${a.family || ''}, ${a.given || ''}`).join('; ')
                : 'Unknown Author';
            const year = item.issued?.['date-parts']?.[0]?.[0] || 'n.d.';
            const foundTitle = item.title?.[0] || 'Unknown Title';
            const journal = item['container-title']?.[0] || '';
            const volume = item.volume || '';
            const issue = item.issue || '';
            const pages = item.page || '';
            const publisher = item.publisher || '';
            const doi = item.DOI || '';

            let rawRef = `${authors} (${year}) ${foundTitle}`;
            if (journal) rawRef += `. ${journal}`;
            if (volume) rawRef += `, ${volume}`;
            if (issue) rawRef += `(${issue})`;
            if (pages) rawRef += `, pp. ${pages}`;
            if (publisher && !journal) rawRef += `. ${publisher}`;
            if (doi) rawRef += `. doi: ${doi}`;

            const formatted = await formatWithGroq(rawRef, format, apiKey);
            results.push(`✅ ${formatted}\n   🔗 DOI: ${doi}`);

        } catch (error) {
            results.push(`⚠️ ERROR searching — "${query}"`);
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
