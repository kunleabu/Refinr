export const config = { api: { bodyParser: { sizeLimit: '10mb' } } };

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { fileData, fileName } = req.body;
  if (!fileData) return res.status(400).json({ error: 'No file data provided' });

  try {
    // Send PDF to Claude for reading and classification
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 4000,
        messages: [{
          role: 'user',
          content: [
            {
              type: 'document',
              source: {
                type: 'base64',
                media_type: 'application/pdf',
                data: fileData
              }
            },
            {
              type: 'text',
              text: `Analyse this document carefully and respond with ONLY a JSON object in this exact format:
{
  "documentType": "full_paper" or "reference_list",
  "title": "document title if found, or null",
  "referenceCount": number of references found,
  "references": ["reference 1", "reference 2", ...],
  "summary": "one sentence describing what you found"
}

Rules:
- If the document contains a full academic paper (with abstract, introduction, body text, methodology, conclusion etc.) set documentType to "full_paper"
- If the document contains only or mostly a list of references/bibliography, set documentType to "reference_list"
- Extract ALL references you can find in the document
- Each reference should be a complete citation string
- Do not include any text outside the JSON object`
            }
          ]
        }]
      })
    });

    const data = await response.json();

    if (data.error) {
      console.error('Claude API error:', data.error);
      return res.status(500).json({ error: 'Failed to read PDF. Please try again.' });
    }

    const text = data.content[0].text.trim();

    // Parse the JSON response
    let parsed;
    try {
      // Strip any markdown code blocks if present
      const clean = text.replace(/```json\n?|\n?```/g, '').trim();
      parsed = JSON.parse(clean);
    } catch (e) {
      console.error('JSON parse error:', e, 'Raw text:', text);
      return res.status(500).json({ error: 'Could not read document structure. Please try again.' });
    }

    return res.status(200).json({
      documentType: parsed.documentType,
      title: parsed.title,
      referenceCount: parsed.referenceCount,
      references: parsed.references || [],
      summary: parsed.summary
    });

  } catch (error) {
    console.error('PDF extract error:', error);
    return res.status(500).json({ error: 'Failed to process PDF. Please try again.' });
  }
}
