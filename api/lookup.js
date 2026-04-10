export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const { identifiers, format } = req.body;
    if (!identifiers || !format) {
        return res.status(400).json({ error: 'Missing identifiers or format' });
    }

    const apiKey = process.env.GROQ_API_KEY;
    const lines = identifiers.split('\n').filter(l => l.trim().length > 0);
    let results = [];

    for (const line of lines) {
        const id = line.trim();
        if (!id) continue;

        try {
            let rawData = null;

            // Detect if DOI or ISBN
            const isDOI = id.startsWith('10.') || id.toLowerCase().includes('doi');
            const cleanID = id.replace(/^doi:\s*/i, '').trim();

            if (isDOI) {
                // DOI lookup via CrossRef
                const response = await fetch(
                    `https://api.crossref.org/works/${encodeURIComponent(cleanID)}`
                );
                if (response.ok) {
                    const data = await response.json();
                    const item = data.message;
                    rawData = {
                        title: item.title?.[0] || 'Unknown',
                        year: item.issued?.['date-parts']?.[0]?.[0] || 'Unknown',
                        authors: item.author
                            ? item.author.map(a => `${a.family || ''}, ${a.given || ''}`).join('; ')
                            : 'Unknown',
                        journal: item['container-title']?.[0] || '',
                        volume: item.volume || '',
                        issue: item.issue || '',
                        pages: item.page || '',
                        publisher: item.publisher || '',
                        doi: cleanID,
                        type: item.type || 'journal-article'
                    };
                }
            } else {
                // ISBN lookup via OpenLibrary (free, no key needed)
                const cleanISBN = id.replace(/[^0-9X]/gi, '');
                const response = await fetch(
                    `https://openlibrary.org/api/books?bibkeys=ISBN:${cleanISBN}&format=json&jscmd=data`
                );
                if (response.ok) {
                    const data = await response.json();
                    const book = data[`ISBN:${cleanISBN}`];
                    if (book) {
                        rawData = {
                            title: book.title || 'Unknown',
                            year: book.publish_date || 'Unknown',
                            authors: book.authors
                                ? book.authors.map(a => a.name).join('; ')
                                : 'Unknown',
                            publisher: book.publishers?.[0]?.name || 'Unknown',
                            place: book.publish_places?.[0]?.name || '',
                            isbn: cleanISBN,
                            type: 'book'
                        };
                    }
                }
            }

            if (!rawData) {
                results.push(`❌ NOT FOUND — ${id}`);
                continue;
            }

            // Use Groq to format the raw data into the requested citation style
            const formatResponse = await fetch('https://api.groq.com/openai/v1/chat/completions', {
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
                            content: `You are a professional academic reference formatter. Format the provided bibliographic data into a single properly formatted ${format} citation. Return only the formatted citation, nothing else.`
                        },
                        {
                            role: 'user',
                            content: `Format this into a ${format} citation:\n${JSON.stringify(rawData)}`
                        }
                    ]
                })
            });

            const formatData = await formatResponse.json();
            const formatted = formatData.choices[0].message.content.trim();
            results.push(`✅ ${formatted}`);

        } catch (error) {
            results.push(`⚠️ ERROR looking up — ${id}`);
        }
    }

    return res.status(200).json({ results });
}
