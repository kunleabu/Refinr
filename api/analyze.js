// ── analyze.js ─────────────────────────────────────────────
// Document Intelligence Engine: rule-based reference isolation
// before any AI is involved. AI only touches validated text.
//
// action: 'extract'  → pdf-parse (rules) + heading search (rules) +
//                       validation scoring (rules) + Groq (AI, only
//                       on the isolated, validated reference block)
// action: 'deepdive' → Claude API (AI) on validated reference list

// ── RULE LAYER: heading detection ───────────────────────────
const REFERENCE_HEADINGS = [
  'references', 'bibliography', 'works cited', 'literature cited',
  'sources', 'reference list', 'cited works'
];

function findReferenceSectionStart(text) {
  // Search the text line by line, from the BOTTOM up, for a line
  // that is just a heading (short, matches a known heading word).
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim().toLowerCase().replace(/[^a-z\s]/g, '').trim();
    if (line.length === 0 || line.length > 30) continue; // headings are short
    if (REFERENCE_HEADINGS.includes(line)) {
      // Return the character offset where this line starts in the original text
      const offset = lines.slice(0, i + 1).join('\n').length;
      return offset;
    }
  }
  return -1; // not found
}

// ── RULE LAYER: validation scoring ──────────────────────────
// Scores how "reference-list-like" a block of text is, without any AI.
function scoreReferenceBlock(text) {
  if (!text || text.length < 50) return 0;

  const yearMatches = (text.match(/\b(19|20)\d{2}\b/g) || []).length;
  const doiMatches = (text.match(/10\.\d{4,9}\/\S+/g) || []).length;
  const urlMatches = (text.match(/https?:\/\/\S+/g) || []).length;
  // "Lastname, F." or "Lastname, F.M." author-pattern
  const authorPatternMatches = (text.match(/\b[A-Z][a-z]+,\s?[A-Z]\.(\s?[A-Z]\.)?/g) || []).length;

  const lengthFactor = text.length / 500; // normalise per 500 chars
  const rawScore = (yearMatches + doiMatches * 2 + urlMatches + authorPatternMatches) / Math.max(lengthFactor, 1);

  return rawScore; // threshold of ~3 used below
}

const VALIDATION_THRESHOLD = 3;

// ── RULE LAYER: isolate the reference block deterministically ──
function isolateReferenceBlock(fullText) {
  // Step 1: try heading-based extraction first
  const headingOffset = findReferenceSectionStart(fullText);

  if (headingOffset !== -1) {
    const candidate = fullText.substring(headingOffset, headingOffset + 16000); // cap size sent onward
    const score = scoreReferenceBlock(candidate);
    if (score >= VALIDATION_THRESHOLD) {
      return { block: candidate, method: 'heading_match', score };
    }
  }

  // Step 2: fall back to progressive end-windows, validating each
  const windowSizes = [8000, 12000, 16000];
  for (const size of windowSizes) {
    const candidate = fullText.substring(Math.max(0, fullText.length - size));
    const score = scoreReferenceBlock(candidate);
    if (score >= VALIDATION_THRESHOLD) {
      return { block: candidate, method: 'fallback_window_' + size, score };
    }
  }

  // Step 3: nothing validated — return the best-scoring attempt anyway,
  // but flag it as unvalidated so the caller can warn the user
  const lastResort = fullText.substring(Math.max(0, fullText.length - 12000));
  return { block: lastResort, method: 'unvalidated', score: scoreReferenceBlock(lastResort) };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { action } = req.body;
  if (!action) return res.status(400).json({ error: 'Missing action' });

  // ── EXTRACT: pdf-parse + rule-based isolation + Groq (only on validated block) ──
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

      // ── RULES: isolate the reference block before any AI call ──
      const beginning = rawText.substring(0, 1500); // for title + doc type only
      const isolation = isolateReferenceBlock(rawText);

      if (isolation.method === 'unvalidated') {
        return res.status(400).json({
          error: 'We could not confidently locate a reference list in this document. Please check the PDF contains a clearly labelled References or Bibliography section, or paste your references directly instead.'
        });
      }

      // ── AI: Groq only touches the small, validated, isolated block ──
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
            content: `You are an academic document analyser. You will be given the beginning of a document (for title/type detection) and an isolated block of text that has already been confirmed to be a reference list or bibliography. Respond with ONLY a valid JSON object — no markdown, no explanation.`
          }, {
            role: 'user',
            content: `DOCUMENT BEGINNING (for title and document type only):
${beginning}

ISOLATED REFERENCE LIST BLOCK (this has already been validated as the references/bibliography section — extract structured references from THIS block only):
${isolation.block}

Return ONLY a JSON object in this exact format:
{
  "documentType": "full_paper" or "reference_list",
  "title": "document title if found in the beginning section, or null",
  "referenceCount": number,
  "references": ["complete reference 1", "complete reference 2", ...],
  "summary": "one sentence describing what you found"
}

Rules:
- "full_paper" = the beginning section has abstract, introduction, body text etc.
- "reference_list" = the beginning section is itself mostly references (little to no body text)
- Extract ALL complete, distinct references from the ISOLATED REFERENCE LIST BLOCK
- Do NOT extract in-text citations like "(Smith, 2020)" found in body paragraphs — only full bibliography-style entries
- Each reference must be a complete citation string
- Return ONLY the JSON object, nothing else`
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
        return res.status(400).json({ error: 'No references found in this document. Please check the file contains a reference list.' });
      }

      return res.status(200).json({
        documentType: parsed.documentType,
        title: parsed.title,
        referenceCount: parsed.referenceCount || parsed.references.length,
        references: parsed.references,
        summary: parsed.summary,
        extractionMethod: isolation.method // useful for debugging in Vercel logs
      });

    } catch (error) {
      console.error('PDF extract error:', error);
      return res.status(500).json({ error: 'Failed to process PDF. Please try again.' });
    }
  }

  // ── DEEPDIVE: Claude API analysis on the already-validated reference list ──
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
