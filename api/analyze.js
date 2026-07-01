// ═══════════════════════════════════════════════════════════════════
// analyze.js — Document Intelligence Engine
// Philosophy: deterministic rules first, AI only for genuine ambiguity
//
// action: 'extract'  → rules (pdf-parse + heading search + pattern
//                       detection + deterministic splitting +
//                       entry validation). AI (Groq) only cleans
//                       entries that failed rule-based validation.
// action: 'deepdive' → Claude API (pure reasoning, non-deterministic)
// ═══════════════════════════════════════════════════════════════════

// ── RULE LAYER 1: Reference section heading detection ──────────────
const REFERENCE_HEADINGS = [
  'references', 'bibliography', 'works cited', 'literature cited',
  'sources', 'reference list', 'cited works', 'citations',
  'literature review', 'list of references', 'list of works cited'
];

function findReferenceSectionStart(text) {
  const lines = text.split('\n');
  // Search from the bottom up — reference sections are always near the end
  for (let i = lines.length - 1; i >= Math.floor(lines.length * 0.3); i--) {
    const line = lines[i].trim().toLowerCase().replace(/[^a-z\s]/g, '').trim();
    if (line.length === 0 || line.length > 40) continue;
    if (REFERENCE_HEADINGS.includes(line)) {
      // Return character offset AFTER the heading line
      const offset = lines.slice(0, i + 1).join('\n').length;
      return offset;
    }
  }
  return -1;
}

// ── RULE LAYER 2: Validation scoring ──────────────────────────────
// Scores how "reference-list-like" a block is, purely by pattern density
function scoreReferenceBlock(text) {
  if (!text || text.length < 50) return 0;
  const per500 = text.length / 500;
  const years = (text.match(/\b(19|20)\d{2}\b/g) || []).length;
  const dois = (text.match(/10\.\d{4,9}\/\S+/g) || []).length;
  const urls = (text.match(/https?:\/\/\S+/g) || []).length;
  const authors = (text.match(/\b[A-Z][a-z]+,\s?[A-Z]\./g) || []).length;
  const numberedEntries = (text.match(/^\s*\d+[\.\)]\s+[A-Z]/gm) || []).length;
  const bracketedEntries = (text.match(/^\s*\[\d+\]/gm) || []).length;
  return (years + dois * 2 + urls + authors + numberedEntries + bracketedEntries) / Math.max(per500, 1);
}

const VALIDATION_THRESHOLD = 2.5;

// ── RULE LAYER 3: Isolate the reference block ──────────────────────
function isolateReferenceBlock(fullText) {
  // Try heading-based extraction first
  const headingOffset = findReferenceSectionStart(fullText);
  if (headingOffset !== -1) {
    const candidate = fullText.substring(headingOffset).trim();
    const score = scoreReferenceBlock(candidate);
    if (score >= VALIDATION_THRESHOLD) {
      return { block: candidate, method: 'heading_match', score };
    }
  }

  // Fall back to progressive end-windows, validating each
  for (const size of [6000, 10000, 16000]) {
    const candidate = fullText.substring(Math.max(0, fullText.length - size));
    const score = scoreReferenceBlock(candidate);
    if (score >= VALIDATION_THRESHOLD) {
      return { block: candidate, method: `fallback_window_${size}`, score };
    }
  }

  return { block: null, method: 'not_found', score: 0 };
}

// ── RULE LAYER 4: Pattern detection ───────────────────────────────
// Detect which reference format the list uses
function detectReferencePattern(text) {
  const lines = text.split('\n').filter(l => l.trim().length > 10);
  if (!lines.length) return 'unknown';

  const numbered = lines.filter(l => /^\s*\d+[\.\)]\s+[A-Z]/.test(l)).length;
  const bracketed = lines.filter(l => /^\s*\[\d+\]/.test(l)).length;
  const authorFirst = lines.filter(l => /^[A-Z][a-z]+,\s?[A-Z]\./.test(l.trim())).length;
  const authorAmpersand = lines.filter(l => /^[A-Z][a-z]+,\s?[A-Z][a-z]*\s?(&|and)\s?/.test(l.trim())).length;

  const total = lines.length;
  if (numbered / total > 0.3) return 'numbered';
  if (bracketed / total > 0.3) return 'bracketed';
  if ((authorFirst + authorAmpersand) / total > 0.25) return 'author_first';
  return 'unknown';
}

// ── RULE LAYER 5: Deterministic reference splitters ───────────────
function splitByNumbered(text) {
  // Split on lines starting with "1." "2." "1)" "2)" etc.
  const refs = text.split(/\n(?=\s*\d+[\.\)]\s+[A-Z])/);
  return refs.map(r => r.replace(/^\s*\d+[\.\)]\s+/, '').replace(/\s+/g, ' ').trim()).filter(r => r.length > 20);
}

function splitByBracketed(text) {
  // Split on lines starting with [1] [2] etc.
  const refs = text.split(/\n(?=\s*\[\d+\])/);
  return refs.map(r => r.replace(/^\s*\[\d+\]\s*/, '').replace(/\s+/g, ' ').trim()).filter(r => r.length > 20);
}

function splitByAuthorFirst(text) {
  // Each reference starts with "Lastname, F." or "Lastname, Firstname"
  // New reference = new line starting with capital letter + comma
  const lines = text.split('\n');
  const refs = [];
  let current = '';

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const isNewRef = /^[A-Z][a-z]+(,\s?[A-Z]|\s+[A-Z][a-z]+,)/.test(trimmed) ||
                     /^[A-Z][a-z]+,\s?[A-Z]\.\s?/.test(trimmed);

    if (isNewRef && current.length > 20) {
      refs.push(current.replace(/\s+/g, ' ').trim());
      current = trimmed;
    } else {
      current = current ? current + ' ' + trimmed : trimmed;
    }
  }
  if (current.length > 20) refs.push(current.replace(/\s+/g, ' ').trim());
  return refs;
}

function splitUnknownPattern(text) {
  // Last resort: split on double newlines, or lines that look like
  // they start a new reference (year near the start, capital letter start)
  const byDoubleNewline = text.split(/\n\n+/).map(r => r.replace(/\s+/g, ' ').trim()).filter(r => r.length > 20);
  if (byDoubleNewline.length > 2) return byDoubleNewline;

  // Try splitting on any line starting with a capital letter after a year pattern
  const lines = text.split('\n');
  const refs = [];
  let current = '';
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const startsNewRef = /^[A-Z]/.test(trimmed) && current.match(/\b(19|20)\d{2}\b/);
    if (startsNewRef && current.length > 20) {
      refs.push(current.replace(/\s+/g, ' ').trim());
      current = trimmed;
    } else {
      current = current ? current + ' ' + trimmed : trimmed;
    }
  }
  if (current.length > 20) refs.push(current.replace(/\s+/g, ' ').trim());
  return refs;
}

// ── RULE LAYER 6: Entry validation ────────────────────────────────
// Each extracted entry should look like a real reference
function validateEntry(entry) {
  if (!entry || entry.length < 20) return false;
  const hasYear = /\b(19|20)\d{2}\b/.test(entry);
  const hasDOI = /10\.\d{4,9}\/\S+/.test(entry);
  const hasURL = /https?:\/\/\S+/.test(entry);
  const hasAuthorPattern = /[A-Z][a-z]+,/.test(entry);
  const hasTitle = entry.length > 40; // titles add length
  return (hasYear || hasDOI || hasURL) && (hasAuthorPattern || hasTitle);
}

// ── MAIN EXTRACTION PIPELINE ───────────────────────────────────────
async function extractReferences(fileData, fileName) {
  // Step 1: Parse PDF text (rules — pdf-parse)
  const pdfParse = (await import('pdf-parse/lib/pdf-parse.js')).default;
  const buffer = Buffer.from(fileData, 'base64');
  const pdfData = await pdfParse(buffer);
  const rawText = pdfData.text;

  if (!rawText || rawText.trim().length < 50) {
    throw new Error('Could not extract text from this PDF. Please try a different file.');
  }

  // Step 2: Detect document type from beginning (rules)
  const beginning = rawText.substring(0, 2000);
  const hasBodyText = /abstract|introduction|methodology|conclusion|discussion/i.test(beginning);
  const documentType = hasBodyText ? 'full_paper' : 'reference_list';

  // Try to extract title from beginning
  const titleMatch = beginning.match(/^(.{10,120})\n/);
  const title = titleMatch ? titleMatch[1].trim() : null;

  // Step 3: Isolate reference block (rules)
  const isolation = isolateReferenceBlock(rawText);

  if (!isolation.block) {
    throw new Error('We could not confidently locate a reference list in this document. Please check the PDF contains a clearly labelled References or Bibliography section, or paste your references directly instead.');
  }

  // Step 4: Detect pattern (rules)
  const pattern = detectReferencePattern(isolation.block);

  // Step 5: Split deterministically (rules)
  let references = [];
  if (pattern === 'numbered') references = splitByNumbered(isolation.block);
  else if (pattern === 'bracketed') references = splitByBracketed(isolation.block);
  else if (pattern === 'author_first') references = splitByAuthorFirst(isolation.block);
  else references = splitUnknownPattern(isolation.block);

  // Step 6: Validate entries (rules)
  const valid = references.filter(r => validateEntry(r));
  const invalid = references.filter(r => !validateEntry(r));
  const validationRate = references.length > 0 ? valid.length / references.length : 0;

  // Step 7: If >80% passed validation, return — no AI needed
  if (validationRate >= 0.80 && valid.length >= 3) {
    return {
      documentType,
      title,
      references: valid,
      referenceCount: valid.length,
      summary: `Found ${valid.length} references using deterministic ${pattern} pattern matching.`,
      extractionMethod: `rules_${pattern}`,
      validationRate: Math.round(validationRate * 100)
    };
  }

  // Step 8: <80% passed — use Groq ONLY on the failed entries or the whole
  // block if pattern was unknown. Groq cleans up genuine ambiguity only.
  const blockForGroq = invalid.length > 0 && valid.length > 3
    ? invalid.join('\n')  // only the problematic entries
    : isolation.block;    // unknown pattern — send the whole block

  const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.GROQ_API_KEY}`
    },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      max_tokens: 6000,
      messages: [{
        role: 'system',
        content: `You are an academic reference parser. You will be given text that is confirmed to be from a reference list or bibliography. Extract each complete reference as a separate item. Return ONLY a JSON array of strings — no other text, no markdown, no explanation. Each string must be one complete reference.`
      }, {
        role: 'user',
        content: `Extract all complete references from this text as a JSON array of strings:\n\n${blockForGroq.substring(0, 8000)}`
      }]
    })
  });

  const groqData = await groqRes.json();

  if (!groqData.choices?.[0]?.message?.content) {
    // Groq failed — return what rules found rather than nothing
    if (valid.length >= 3) {
      return {
        documentType, title,
        references: valid,
        referenceCount: valid.length,
        summary: `Found ${valid.length} references. Some entries could not be fully parsed.`,
        extractionMethod: `rules_partial_${pattern}`,
        validationRate: Math.round(validationRate * 100)
      };
    }
    throw new Error('Could not extract references from this document. Please try pasting your references directly.');
  }

  // Parse Groq's response
  let groqRefs = [];
  try {
    const text = groqData.choices[0].message.content.trim();
    const clean = text.replace(/```json\n?|\n?```/g, '').trim();
    groqRefs = JSON.parse(clean);
    if (!Array.isArray(groqRefs)) groqRefs = [];
  } catch (e) {
    groqRefs = [];
  }

  // Merge: validated rule-based refs + Groq-cleaned refs
  const allRefs = [...valid, ...groqRefs.filter(r => typeof r === 'string' && r.length > 20)];
  const unique = [...new Map(allRefs.map(r => [r.substring(0, 40), r])).values()];

  return {
    documentType, title,
    references: unique,
    referenceCount: unique.length,
    summary: `Found ${unique.length} references (${valid.length} by rules, ${groqRefs.length} by AI cleanup).`,
    extractionMethod: `hybrid_${pattern}`,
    validationRate: Math.round(validationRate * 100)
  };
}

// ── MAIN HANDLER ───────────────────────────────────────────────────
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { action } = req.body;
  if (!action) return res.status(400).json({ error: 'Missing action' });

  // ── EXTRACT ────────────────────────────────────────────────────
  if (action === 'extract') {
    const { fileData, fileName } = req.body;
    if (!fileData) return res.status(400).json({ error: 'No file data provided' });

    try {
      const result = await extractReferences(fileData, fileName);
      return res.status(200).json(result);
    } catch (error) {
      console.error('Extract error:', error.message);
      return res.status(error.message.includes('confidently') || error.message.includes('extract text') ? 400 : 500).json({ error: error.message });
    }
  }

  // ── DEEPDIVE: Claude API — pure reasoning, non-deterministic ───
  if (action === 'deepdive') {
    const { references, documentType, title } = req.body;
    if (!references || !references.length) return res.status(400).json({ error: 'No references provided' });

    const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

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
          system: `You are an expert academic reference analyst. Perform a deep, thorough analysis of academic references and produce a professional report that supervisors and journal editors can rely on. Be specific, honest, and constructive.`,
          messages: [{
            role: 'user',
            content: `Perform a deep dive analysis of these ${references.length} academic references${title ? ` from "${title}"` : ''}.

REFERENCES:
${references.map((r, i) => `${i + 1}. ${r}`).join('\n')}

Produce a comprehensive analysis report in this exact format:

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📊 DEEP DIVE ANALYSIS REPORT${title ? `\nDocument: ${title}` : ''}
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

[For each reference:]
[Number]. [Reference]
Status: ✅ Strong / ⚠️ Acceptable / ❌ Weak
Issue: [specific issue or "None"]
Suggestion: [specific improvement or "None"]

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
⚠️ KEY CONCERNS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

[Most important issues found, or "No major concerns identified."]

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
✅ RECOMMENDATIONS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

[3-5 specific, actionable recommendations]

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📋 SUPERVISOR VERDICT
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

[Clear professional verdict on whether this reference list meets academic standards and what needs fixing before submission]`
          }]
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
