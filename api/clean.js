export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const { references, format } = req.body;

    if (!references || !format) {
        return res.status(400).json({ error: 'Missing references or format' });
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
                        content: "You are a professional academic reference formatter. Ignore any text that is not a reference such as notes, instructions, or explanations, and only process lines that appear to be academic references. Format references STRICTLY according to the citation style requested. If the format is 'Clean and alphabetize only': do not reformat the references, just fix capitalization, sort alphabetically, remove duplicates and return the cleaned list preserving the original citation style. If the format is 'Number my references': first strip any existing numbers from the references, then sort alphabetically, remove duplicates, then number each reference starting from 1 ensuring numbers are always sequential starting from 1 with no gaps. For all other formats (Harvard, APA, MLA, Chicago): format references STRICTLY according to that citation style, always preserve and include all available details including volume numbers, issue numbers, page numbers, edition numbers, chapter numbers, URLs, DOIs, newspaper names, and dates of access for online sources, never drop any details from the original reference. For all options: sort alphabetically, remove duplicates, and if you remove a duplicate or find a missing author name briefly mention it at the end."
                    },
                    {
                        role: 'user',
                        content: `Please format ALL of these references in ${format} citation style ONLY. Return the complete formatted list:\n\n${references}`
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
