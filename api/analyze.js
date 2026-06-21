export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { action } = req.body;
  if (!action) return res.status(400).json({ error: 'Missing action' });

  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

  // ── EXTRACT: Read PDF and detect document type ─────────────
  if (action === 'extract') {
    const { fileData, fileName } = req.body;
    if (!fileData) return res.status(400).json({ error: 'No file data provided' });

    try {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': ANTHROPIC_API_KEY,
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
                source: { type: 'base64', media_type: 'application/pdf', data: fileData }
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
      let parsed;
      try {
        const clean = text.replace(/```json\n?|\n?```/g, '').trim();
        parsed = JSON.parse(clean);
      } catch (e) {
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

  // ── DEEPDIVE: Full analysis with Claude ────────────────────
  if (action === 'deepdive') {
    const { references, documentType, title } = req.body;
    if (!references || !references.length) return res.status(400).json({ error: 'No references provided' });

    const systemPrompt = `You are an expert academic reference analyst. Your job is to perform a deep, thorough analysis of academic references and produce a professional report that supervisors and journal editors can rely on. Be specific, honest, and constructive. Your analysis should feel like it comes from a senior academic librarian or research quality officer.`;

    const userPrompt = `Perform a deep dive analysis of these ${references.length} academic references${title ? ` from the document "${title}"` : ''}.

REFERENCES:
${references.map((r, i) => `${i + 1}. ${r}`).join('\n')}

Produce a comprehensive analysis report in this exact format:

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📊 DEEP DIVE ANALYSIS REPORT
${title ? `Document: ${title}` : ''}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

OVERALL CREDIBILITY SCORE: [X/100]

SUMMARY
[2-3 sentences summarising the overall quality of this reference list]

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📈 REFERENCE QUALITY BREAKDOWN
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Total references: ${references.length}
Strong references (peer-reviewed, reputable): [number]
Acceptable references (credible but minor issues): [number]
Weak references (non-academic, outdated, or unverifiable): [number]
Formatting issues found: [number]

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🔍 DETAILED REFERENCE ANALYSIS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

[For each reference provide:]
[Number]. [Reference]
Status: ✅ Strong / ⚠️ Acceptable / ❌ Weak
Issue: [specific issue if any, or "None"]
Suggestion: [specific improvement if needed, or "None"]

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
⚠️ KEY CONCERNS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

[List the most important issues found. If none, say "No major concerns identified."]

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
✅ RECOMMENDATIONS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

[3-5 specific, actionable recommendations to improve the reference list quality]

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📋 SUPERVISOR VERDICT
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

[A clear professional verdict: whether this reference list meets academic standards, what needs fixing before submission, and an overall assessment]`;

    try {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-6',
          max_tokens: 4000,
          system: systemPrompt,
          messages: [{ role: 'user', content: userPrompt }]
        })
      });

      const data = await response.json();
      if (data.error) {
        console.error('Claude deep dive error:', data.error);
        return res.status(500).json({ error: 'Analysis failed. Please try again.' });
      }

      return res.status(200).json({ result: data.content[0].text });

    } catch (error) {
      console.error('Deep dive error:', error);
      return res.status(500).json({ error: 'Analysis failed. Please try again.' });
    }
  }

  return res.status(400).json({ error: 'Unknown action' });
}
