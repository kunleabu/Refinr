export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { references, documentType, title, mode } = req.body;
  if (!references || !references.length) return res.status(400).json({ error: 'No references provided' });

  const isFullPaper = documentType === 'full_paper';

  const systemPrompt = `You are an expert academic reference analyst. Your job is to perform a deep, thorough analysis of academic references and produce a professional report that supervisors and journal editors can rely on.

Be specific, honest, and constructive. Your analysis should feel like it comes from a senior academic librarian or research quality officer.`;

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

[For each reference, provide:]
[Number]. [Reference]
Status: ✅ Strong / ⚠️ Acceptable / ❌ Weak
Issue: [specific issue if any, or "None"]
Suggestion: [specific improvement if needed, or "None"]

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
⚠️ KEY CONCERNS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

[List the most important issues found — over-reliance on old sources, non-academic sources, missing information, formatting inconsistencies, suspicious citations etc. If none, say "No major concerns identified."]

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
✅ RECOMMENDATIONS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

[3-5 specific, actionable recommendations to improve the reference list quality]

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📋 SUPERVISOR VERDICT
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

[A clear, professional verdict that a supervisor could use directly: whether this reference list meets academic standards, what needs fixing before submission, and an overall assessment]`;

  try {
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
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }]
      })
    });

    const data = await response.json();

    if (data.error) {
      console.error('Claude deep dive error:', data.error);
      return res.status(500).json({ error: 'Analysis failed. Please try again.' });
    }

    const result = data.content[0].text;
    return res.status(200).json({ result });

  } catch (error) {
    console.error('Deep dive error:', error);
    return res.status(500).json({ error: 'Analysis failed. Please try again.' });
  }
}
