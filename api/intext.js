export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const { references } = req.body;

    if (!references) {
        return res.status(400).json({ error: 'Missing references' });
    }

    try {
        const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${process.env.GROQ_API_KEY}`
            },
            body: JSON.stringify({
                model: 'llama-3.3-70b-versatile',
                messages: [
                    {
                        role: 'system',
                        content: "You are an academic reference expert. Given a list of references, generate ONLY the in-text citations. Rules: 1 author = (Smith, 2020). 2 authors = (Smith and Jones, 2020). 3 or more authors = (Smith et al., 2020). Return ONLY a clean numbered list of in-text citations, one per line. No explanations, no notes, no extra text. Just the citations."
                    },
                    {
                        role: 'user',
                        content: `Generate in-text citations for all of these references:\n\n${references}`
                    }
                ]
            })
        });

        const data = await response.json();
        const result = data.choices[0].message.content;
        return res.status(200).json({ result });

    } catch (error) {
        return res.status(500).json({ error: 'Something went wrong. Please try again.' });
    }
}
