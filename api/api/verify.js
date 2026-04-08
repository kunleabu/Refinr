export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const { reference } = req.body;

    if (!reference) {
        return res.status(400).json({ error: 'Missing reference' });
    }

    try {
        // Step 1 — Search CrossRef
        const crossrefResponse = await fetch(
            `https://api.crossref.org/works?query=${encodeURIComponent(reference)}&rows=1`
        );
        const crossrefData = await crossrefResponse.json();
        const item = crossrefData.message.items[0];

        if (!item || item.score < 5) {
            return res.status(200).json({ result: `❌ NOT FOUND — ${reference}` });
        }

        // Step 2 — Extract official details
        const officialTitle = item.title ? item.title[0] : 'Unknown';
        const officialYear = item.issued?.['date-parts']?.[0]?.[0] || 'Unknown';
        const officialAuthors = item.author
            ? item.author.map(a => `${a.family || ''}, ${a.given || ''}`).join('; ')
            : 'Unknown';
        const score = item.score || 0;

        // Step 3 — Use Groq to compare and verdict
        const compareResponse = await fetch('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${process.env.GROQ_API_KEY}`
            },
            body: JSON.stringify({
                model: 'llama-3.3-70b-versatile',
                max_tokens: 200,
                messages: [
                    {
                        role: 'system',
                        content: 'You are an academic reference verifier. Compare the submitted reference with the official CrossRef record and return a one-line verdict. Format: ✅ CONFIRMED or ⚠️ MISMATCH: [brief description of what is wrong]. Be concise.'
                    },
                    {
                        role: 'user',
                        content: `Submitted reference: ${reference}\n\nOfficial CrossRef record:\nTitle: ${officialTitle}\nYear: ${officialYear}\nAuthors: ${officialAuthors}\nRelevance score: ${score}\n\nIf the relevance score is below 5, say NOT FOUND. Otherwise compare and give verdict.`
                    }
                ]
            })
        });

        const compareData = await compareResponse.json();
        const verdict = compareData.choices[0].message.content.trim();
        return res.status(200).json({ 
            result: `${verdict}\n   Reference: ${reference}` 
        });

    } catch (error) {
        return res.status(500).json({ error: `⚠️ ERROR checking — ${reference}` });
    }
}
