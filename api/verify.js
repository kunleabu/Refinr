import { rateLimit } from './ratelimit.js';

// ── RULE LAYER: Pre-verification classifier ────────────────────────
// Determines if a reference is verifiable against academic databases
// BEFORE making any API calls. Pure rules, zero tokens.
function classifyReference(reference) {
  const ref = reference.toLowerCase();

  // ── Unverifiable: web/blog sources ──
  if (/blog|tech blog|medium\.com|substack|wordpress|blogspot/.test(ref)) {
    return { verifiable: false, reason: 'Web/blog source — not indexed in academic databases' };
  }

  // ── Unverifiable: social media ──
  if (/twitter\.com|x\.com|facebook\.com|linkedin\.com|instagram\.com/.test(ref)) {
    return { verifiable: false, reason: 'Social media source — not indexed in academic databases' };
  }

  // ── Unverifiable: preprints without DOI ──
  // arXiv preprints CAN be found but only if they have a proper arXiv ID
  if (/arxiv/i.test(ref) && !/arxiv:\d{4}\.\d{4,5}/.test(ref)) {
    return { verifiable: false, reason: 'arXiv preprint without a valid arXiv ID — cannot verify' };
  }

  // ── Unverifiable: incomplete references ──
  // Must have at least a year AND either an author or a title of substance
  const hasYear = /\b(19|20)\d{2}\b/.test(reference);
  const hasAuthor = /[A-Z][a-z]+,/.test(reference);
  const hasTitle = reference.trim().length > 40;

  if (!hasYear) {
    return { verifiable: false, reason: 'No publication year found — cannot verify' };
  }

  if (!hasAuthor && !hasTitle) {
    return { verifiable: false, reason: 'Reference appears incomplete — missing author and title' };
  }

  // ── Unverifiable: reports and grey literature ──
  if (/working paper|technical report|white paper|discussion paper|policy brief/.test(ref)) {
    return { verifiable: false, reason: 'Grey literature (working paper/report) — may not be in academic databases' };
  }

  // ── Unverifiable: personal communications, websites ──
  if (/personal communication|pers\. comm|retrieved from|available at|accessed/.test(ref)) {
    return { verifiable: false, reason: 'Website/personal communication — not indexed in academic databases' };
  }

  // ── Verifiable: has a DOI — highest confidence ──
  if (/10\.\d{4,9}\/\S+/.test(reference)) {
    return { verifiable: true, confidence: 'high', reason: 'Has DOI — direct database lookup possible' };
  }

  // ── Verifiable: has arXiv ID ──
  if (/arxiv:\d{4}\.\d{4,5}/i.test(reference)) {
    return { verifiable: true, confidence: 'medium', reason: 'arXiv preprint with valid ID' };
  }

  // ── Verifiable: standard academic reference ──
  return { verifiable: true, confidence: 'standard', reason: 'Standard academic reference' };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Rate limiting
  const ip = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown';
  const limit = rateLimit(ip, 'verify', 500);
  if (!limit.allowed) {
    return res.status(429).json({
      error: `Too many requests. Please wait ${limit.resetIn} minutes before trying again.`
    });
  }

  const { reference } = req.body;
  if (!reference) {
    return res.status(400).json({ error: 'Missing reference' });
  }

  // ── RULE CHECK: classify before any API call ───────────────────
  const classification = classifyReference(reference);

  if (!classification.verifiable) {
    return res.status(200).json({
      result: `⚪ UNVERIFIABLE — ${classification.reason}\n   Reference: ${reference}\n   ℹ️ This type of source cannot be checked against CrossRef or OpenAlex. This does not mean the reference is wrong.`,
      status: 'unverifiable'
    });
  }

  const apiKey = process.env.GROQ_API_KEY;

  try {
    let officialTitle = null;
    let officialYear = null;
    let officialAuthors = null;
    let officialJournal = null;
    let officialVolume = null;
    let officialIssue = null;
    let officialPages = null;
    let officialPublisher = null;
    let officialDOI = null;
    let source = 'CrossRef';

    // Step 1 — Try CrossRef first
    const crossrefResponse = await fetch(
      `https://api.crossref.org/works?query=${encodeURIComponent(reference)}&rows=1`
    );
    const crossrefData = await crossrefResponse.json();
    const item = crossrefData.message.items[0];

    if (item && item.score >= 5) {
      officialTitle = item.title?.[0] || null;
      officialYear = item.issued?.['date-parts']?.[0]?.[0] || null;
      officialAuthors = item.author
        ? item.author.map(a => `${a.family || ''}, ${a.given || ''}`).join('; ')
        : null;
      officialJournal = item['container-title']?.[0] || null;
      officialVolume = item.volume || null;
      officialIssue = item.issue || null;
      officialPages = item.page || null;
      officialPublisher = item.publisher || null;
      officialDOI = item.DOI || null;
    }

    // Step 2 — Try OpenAlex as backup
    if (!officialTitle) {
      source = 'OpenAlex';
      const openAlexResponse = await fetch(
        `https://api.openalex.org/works?search=${encodeURIComponent(reference)}&per-page=1`
      );
      const openAlexData = await openAlexResponse.json();
      const alexItem = openAlexData.results?.[0];

      if (alexItem) {
        officialTitle = alexItem.title || null;
        officialYear = alexItem.publication_year || null;
        officialAuthors = alexItem.authorships
          ? alexItem.authorships.map(a => a.author?.display_name || '').join('; ')
          : null;
        officialJournal = alexItem.primary_location?.source?.display_name || null;
        officialDOI = alexItem.doi || null;
      }
    }

    // Step 3 — Not found in either database
    if (!officialTitle) {
      return res.status(200).json({
        result: `❌ NOT FOUND in CrossRef or OpenAlex — please verify manually\n   Reference: ${reference}`,
        status: 'not_found'
      });
    }

    // Step 4 — Use Groq to compare and give verdict
    const compareResponse = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        max_tokens: 400,
        messages: [
          {
            role: 'system',
            content: 'You are an academic reference verifier. Compare the submitted reference with the official database record. Only flag as MISMATCH if there are significant errors such as: wrong year, wrong title, missing or wrong authors, wrong journal name, wrong volume or issue numbers. Do NOT flag as mismatch for: missing DOIs, missing full first names when initials are correct, minor punctuation differences, or capitalisation differences. Return your response in this exact format:\nSTATUS: CONFIRMED or MISMATCH or NOT_FOUND\nVERDICT: one line description\nCORRECTED: the fully corrected reference in the same citation style as the submitted one (only include this line if there is a real significant mismatch)'
          },
          {
            role: 'user',
            content: `Submitted reference: ${reference}\n\nOfficial record from ${source}:\nTitle: ${officialTitle}\nYear: ${officialYear}\nAuthors: ${officialAuthors}\nJournal: ${officialJournal || 'N/A'}\nVolume: ${officialVolume || 'N/A'}\nIssue: ${officialIssue || 'N/A'}\nPages: ${officialPages || 'N/A'}\nPublisher: ${officialPublisher || 'N/A'}\nDOI: ${officialDOI || 'N/A'}\n\nCompare carefully and return the STATUS, VERDICT, and CORRECTED reference if needed.`
          }
        ]
      })
    });

    const compareData = await compareResponse.json();
    const response_text = compareData.choices[0].message.content.trim();

    const statusMatch = response_text.match(/STATUS:\s*(CONFIRMED|MISMATCH|NOT_FOUND)/i);
    const verdictMatch = response_text.match(/VERDICT:\s*(.+)/i);
    const correctedMatch = response_text.match(/CORRECTED:\s*(.+)/i);

    const status = statusMatch?.[1]?.toUpperCase() || 'MISMATCH';
    const verdict = verdictMatch?.[1]?.trim() || response_text;
    const corrected = correctedMatch?.[1]?.trim() || null;

    let resultText = '';
    if (status === 'CONFIRMED') {
      resultText = `✅ CONFIRMED\n   Reference: ${reference}\n   Source: ${source}`;
    } else if (status === 'NOT_FOUND') {
      resultText = `❌ NOT FOUND — ${verdict}\n   Reference: ${reference}`;
    } else {
      resultText = `⚠️ MISMATCH: ${verdict}\n   Reference: ${reference}\n   Source: ${source}`;
      if (corrected) {
        resultText += `\n   ✏️ Suggested correction: ${corrected}`;
      }
    }

    return res.status(200).json({
      result: resultText,
      status: status.toLowerCase()
    });

  } catch (error) {
    return res.status(500).json({
      result: `⚠️ ERROR checking — ${reference}`,
      status: 'error'
    });
  }
}
