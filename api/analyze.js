// ── analyze.js ─────────────────────────────────────────────
// action: 'extract' → uses Groq only (free, no Claude tokens)
// action: 'deepdive' → uses Claude API (10 credits)

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { action } = req.body;
  if (!action) return res.status(400).json({ error: 'Missing action' });

  // ── EXTRACT: Read PDF using pdf-parse + Groq (FREE, no Claude tokens) ──
  if (action === 'extract') {
    const { fileData, fileName } = req.body;
    if (!fileData) return res.status(400).json({ error: 'No file data provided' });

    try {
      const pdfParse = (await import('pdf-parse/lib/pdf-parse.js')).default;
      const buffer = Buffer.from(fileData, 'base64');
      const pdfData = await pdfParse(buffer);
      const rawText = pdfData.text;

      if (!rawText || rawText.trim().length < 50) {
        return res.status(400).json({ error: 'Could not extract text from this PDF. Please try a different file.' });
      }

      const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.GROQ_API_KEY}`
        },
        body: JSON.stringify({
          model: 'llama-3.3-70b-versatile',
          max_tokens: 4000,
          messages: [{
            role: 'system',
            content: `You are an academic document analyser. Respond with ONLY a valid JSON object — no markdown, no explanation, no extra text.`
          }, {
            role: 'user',
            content: `Analyse this document text and return ONLY a JSON object in this exact format:
{
  "documentType": "full_paper" or "reference_list",
  "title": "document title if found, or null",
  "referenceCount": number,
  "references": ["complete reference 1", "complete reference 2", ...],
  "summary": "one sentence describing what you found"
}

Rules:
- "full_paper" = has abstract, introduction, body text, methodology, conclusion etc.
- "reference_list" = only or mostly a list of references/bibliography
- Extract ALL complete references you can find
- Each reference must be a complete citation string
- Return ONLY the JSON object, nothing else

DOCUMENT TEXT:
${rawText.substring(0, 12000)}`
          }]
        })
      });

      const groqData = await groqRes.json();

      if (!groqData.choices?.[0]?.message?.content) {
        return res.status(500).json({ error: 'Could not analyse document. Please try again.' });
      }

      const text = groqData.choices[0].message.content.trim();
      let parsed;
      try {
        const clean = text.replace(/```json\n?|\n?```/g, '').trim();
        parsed = JSON.parse(clean);
      } catch (e) {
        return res.status(500).json({ error: 'Could not read document structure. Please try again.' });
      }

      if (!parsed.references || parsed.references.length === 0) {
        return res.status(400).json({ error: 'No references found in this document. Please check the file contains references.' });
      }

      return res.status(200).json({
        documentType: parsed.documentType,
        title: parsed.title,
        referenceCount: parsed.referenceCount || parsed.references.length,
        references: parsed.references,
        summary: parsed.summary
      });

    } catch (error) {
      console.error('PDF extract error:', error);
      return res.status(500).json({ error: 'Failed to process PDF. Please try again.' });
    }
  }

  // ── DEEPDIVE: Full analysis with Claude API (10 credits) ──
  if (action === 'deepdive') {
    const { references, documentType, title } = req.body;
    if (!references || !references.length) return res.status(400).json({ error: 'No references provided' });

    const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

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
