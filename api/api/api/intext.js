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
                        content: "You are an academic reference expert. Given a list of references, generate the corresponding in-text citation for each one. Rules: 1 author = (Smith, 2020). 2 authors = (Smith and Jones, 2020). 3 or more authors = (Smith et al., 2020). Return each in-text citation on its own line next to the author name so the user knows which is which. Format: In-text: (Smith, 2020) — Smith, J. (2020) Full reference here."
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
