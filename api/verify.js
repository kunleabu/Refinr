export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const { reference } = req.body;
    if (!reference) {
        return res.status(400).json({ error: 'Missing reference' });
    }

    const apiKey = process.env.GROQ_API_KEY;

    try {
        // Step 1 — Try CrossRef first
        let officialTitle = null;
        let officialYear = null;
        let officialAuthors = null;
        let source = 'CrossRef';

        const crossrefResponse = await fetch(
            `https://api.crossref.org/works?query=${encodeURIComponent(reference)}&rows=1`
        );
        const crossrefData = await crossrefResponse.json();
        const item = crossrefData.message.items[0];

        if (item && item.score >= 5) {
            officialTitle = item.title ? item.title[0] : null;
            officialYear = item.issued?.['date-parts']?.[0]?.[0] || null;
            officialAuthors = item.author
                ? item.author.map(a => `${a.family || ''}, ${a.given || ''}`).join('; ')
                : null;
        }

        // Step 2 — If CrossRef didn't find it, try OpenAlex as backup
        if (!officialTitle) {
            source = 'OpenAlex';
            const openAlexResponse = await fetch(
                `https://api.openalex.org/works?search=${encodeURIComponent(reference)}&per-page=1`
            );
            const openAlexData = await openAlexResponse.json();
            const alexItem = openAlexData.results?.[0];

            if (alexItem) {
                officialTitle = alexItem.title || null;
                officialYear = alexItem.publication_year || null;
                officialAuthors = alexItem.authorships
                    ? alexItem.authorships.map(a => a.author?.display_name || '').join('; ')
                    : null;
            }
        }

        // Step 3 — If neither database found it
        if (!officialTitle) {
            return res.status(200).json({
                result: `❌ NOT FOUND in CrossRef or OpenAlex — please verify manually\n   Reference: ${reference}`
            });
        }

        // Step 4 — Use Groq to compare and give verdict
        const compareResponse = await fetch('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`
            },
            body: JSON.stringify({
                model: 'llama-3.3-70b-versatile',
                max_tokens: 200,
                messages: [
                    {
                        role: 'system',
                        content: 'You are an academic reference verifier. Compare the submitted reference with the official database record and return a one-line verdict. Format: ✅ CONFIRMED or ⚠️ MISMATCH: [brief description of what is wrong]. Be concise.'
                    },
                    {
                        role: 'user',
                        content: `Submitted reference: ${reference}\n\nOfficial record from ${source}:\nTitle: ${officialTitle}\nYear: ${officialYear}\nAuthors: ${officialAuthors}\n\nCompare and give verdict.`
                    }
                ]
            })
        });

        const compareData = await compareResponse.json();
        const verdict = compareData.choices[0].message.content.trim();
        return res.status(200).json({
            result: `${verdict}\n   Reference: ${reference}\n   Source: ${source}`
        });

    } catch (error) {
        return res.status(500).json({ error: `⚠️ ERROR checking — ${reference}` });
    }
}
