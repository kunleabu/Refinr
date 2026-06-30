// ============================================================
// REFINR — Document Intelligence Engine
// Handles: PDF text extraction, reference-section isolation,
// structural validation, and routing to the Credibility Engine
// (deep dive) only when genuinely needed.
//
// Design principle: rules find the reference list; AI only
// touches text we have already validated is worth analysing.
// ============================================================

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

// pdf-parse is loaded dynamically inside the handler (not at module top-level).
// Some versions of pdf-parse run file-system side effects on import that can
// crash a serverless function before any of our code executes. Dynamic import
// inside a try/catch lets us surface a clean error instead of a bare 500.
async function loadPdfParser() {
    const mod = await import('pdf-parse/lib/pdf-parse.js').catch(() => import('pdf-parse'));
    return mod.default || mod;
}

// ── Rule Engine: heading detection ──────────────────────────
const REFERENCE_HEADINGS = [
    'references', 'reference list', 'bibliography', 'works cited',
    'literature cited', 'sources', 'cited works', 'list of references'
];

function findReferenceSectionStart(text) {
    const lowerText = text.toLowerCase();
    let bestIndex = -1;
    let bestHeading = null;

    for (const heading of REFERENCE_HEADINGS) {
        // Look for the heading as its own line/segment, not buried mid-sentence.
        // Match: start-of-line OR preceded by newline/whitespace, heading word,
        // then end-of-line or punctuation — to avoid matching "references to X" in body text.
        const pattern = new RegExp('(?:^|\\n)\\s*' + heading.replace(/\s+/g, '\\s+') + '\\s*\\n', 'gi');
        let match;
        while ((match = pattern.exec(lowerText)) !== null) {
            // Prefer the LAST occurrence — reference sections are near the end,
            // and "references" can appear earlier in a table of contents.
            if (match.index > bestIndex) {
                bestIndex = match.index + match[0].length;
                bestHeading = heading;
            }
        }
    }

    return bestIndex === -1 ? null : { startIndex: bestIndex, heading: bestHeading };
}

// ── Rule Engine: validate a text block actually looks like a reference list ──
function scoreReferenceLikelihood(text) {
    if (!text || text.trim().length < 50) return 0;

    const sampleLength = Math.min(text.length, 4000);
    const sample = text.substring(0, sampleLength);

    const yearMatches = (sample.match(/\b(19|20)\d{2}\b/g) || []).length;
    const doiMatches = (sample.match(/10\.\d{4,9}\/\S+/g) || []).length;
    const urlMatches = (sample.match(/https?:\/\/\S+/g) || []).length;
    // "Lastname, F." or "Lastname, F.M." style author patterns
    const authorPatternMatches = (sample.match(/\b[A-Z][a-zA-Z'-]+,\s?[A-Z]\.(\s?[A-Z]\.)?/g) || []).length;
    // Lines that look like hanging-indent / numbered reference entries
    const lineStarts = sample.split('\n').filter(line => {
        const trimmed = line.trim();
        return /^(\[\d+\]|\d+[\.\)]|\([A-Z])/.test(trimmed) || /^[A-Z][a-zA-Z'-]+,/.test(trimmed);
    }).length;

    // Normalise to a density score per 500 characters
    const unit = sampleLength / 500;
    const score =
        (yearMatches / unit) * 2 +
        (doiMatches / unit) * 3 +
        (urlMatches / unit) * 1 +
        (authorPatternMatches / unit) * 3 +
        (lineStarts / unit) * 2;

    return score;
}

const VALIDATION_THRESHOLD = 4; // tuned conservatively; raise if false positives appear

// ── Rule Engine: locate and validate the reference section ─────────────────
function extractReferenceCandidate(fullText) {
    // Attempt 1 — heading-based extraction
    const heading = findReferenceSectionStart(fullText);
    if (heading) {
        const candidate = fullText.substring(heading.startIndex);
        const trimmedCandidate = candidate.length > 16000 ? candidate.substring(0, 16000) : candidate;
        const score = scoreReferenceLikelihood(trimmedCandidate);
        if (score >= VALIDATION_THRESHOLD) {
            return { text: trimmedCandidate, method: 'heading_match', heading: heading.heading, score };
        }
    }

    // Attempt 2 — progressive end-window fallback, validated at each size
    const windowSizes = [8000, 12000, 16000];
    for (const size of windowSizes) {
        const candidate = fullText.substring(Math.max(0, fullText.length - size));
        const score = scoreReferenceLikelihood(candidate);
        if (score >= VALIDATION_THRESHOLD) {
            return { text: candidate, method: 'end_window_fallback', windowSize: size, score };
        }
    }

    // Attempt 3 — nothing validated; return the largest end window anyway,
    // but flag it clearly so the caller can warn the user.
    const fallback = fullText.substring(Math.max(0, fullText.length - 16000));
    return { text: fallback, method: 'unvalidated_fallback', score: scoreReferenceLikelihood(fallback) };
}

// ── AI: structure already-validated reference text into a clean array ──────
async function structureReferencesWithGroq(referenceText, beginningText) {
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${GROQ_API_KEY}`
        },
        body: JSON.stringify({
            model: 'llama-3.3-70b-versatile',
            temperature: 0,
            messages: [
                {
                    role: 'system',
                    content: "You are a document structuring assistant. You will be given two pieces of text: (1) the BEGINNING of an academic document (for title and document-type detection), and (2) a block of text that has ALREADY BEEN IDENTIFIED as the reference list / bibliography section. Your only job is to: (a) extract the document title if present, (b) determine if the BEGINNING text shows signs of a full academic paper (abstract, introduction, methodology, results sections) versus just being a bare reference list with no other content, and (c) split the REFERENCE SECTION text into individual, complete reference entries as an array of strings, exactly as they appear, without reformatting or correcting them. Do NOT include in-text citations like (Smith, 2020) — only complete bibliographic entries with author, year, title and source details. If the reference section block contains non-reference content at the start or end (like page headers, footnotes unrelated to references, or document metadata), exclude that content from the entries. Return ONLY valid JSON in this exact shape: {\"title\": \"...\", \"documentType\": \"full_paper\" or \"reference_list\", \"references\": [\"...\", \"...\"], \"summary\": \"one short sentence\"}. No markdown, no explanation, no code fences — JSON only."
                },
                {
                    role: 'user',
                    content: `BEGINNING OF DOCUMENT:\n${beginningText}\n\n---\n\nIDENTIFIED REFERENCE SECTION:\n${referenceText}`
                }
            ]
        })
    });

    if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Groq structuring failed: ${errText}`);
    }

    const data = await response.json();
    const raw = data.choices[0].message.content.trim();
    const cleaned = raw.replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim();

    try {
        return JSON.parse(cleaned);
    } catch (e) {
        throw new Error('Could not parse structured reference data from AI response');
    }
}

// ── Credibility Engine: deep dive analysis via Claude ───────────────────────
async function runDeepDiveAnalysis(references, documentType, title) {
    if (!ANTHROPIC_API_KEY) {
        throw new Error('Deep dive analysis is not configured on the server yet.');
    }

    const refList = references.map((r, i) => `${i + 1}. ${r}`).join('\n');

    const systemPrompt = "You are an academic credibility analyst working inside Refinr's Credibility Engine. You perform deep, evidence-based review of reference lists for researchers, supervisors and journal editors. You are thorough, specific and conservative — never invent details you cannot infer, and clearly distinguish between things you can verify from the text given versus things that would require external lookup. Your report must be genuinely useful to a supervisor deciding whether to approve a submission.";

    const userPrompt = `Document title: ${title || 'Untitled document'}\nDocument type: ${documentType === 'full_paper' ? 'Full academic paper' : 'Reference list only'}\n\nHere are the ${references.length} references extracted from this document:\n\n${refList}\n\nProduce a structured credibility report covering:\n\n1. OVERALL CREDIBILITY SCORE (0-100) with one-line justification\n2. SOURCE QUALITY — flag any references that appear to be non-academic, predatory journals, unreliable websites, or missing critical bibliographic details\n3. RECENCY — note if the reference list is unusually outdated for the apparent field, or well-balanced between foundational and recent work\n4. DIVERSITY — flag over-reliance on a small number of authors, journals, or self-citation patterns if apparent from the list\n5. FORMATTING CONSISTENCY — note if the references appear to mix multiple citation styles inconsistently\n6. RECOMMENDATIONS — 3 to 5 concrete, actionable suggestions to strengthen this reference list\n\nFormat your response as clean readable text with clear section headers, suitable to show directly to a supervisor or student. Do not use markdown bold/asterisks — use plain text section headers in capitals.`;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-api-key': ANTHROPIC_API_KEY,
            'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
            model: 'claude-sonnet-4-6',
            max_tokens: 2000,
            system: systemPrompt,
            messages: [{ role: 'user', content: userPrompt }]
        })
    });

    if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Claude deep dive failed: ${errText}`);
    }

    const data = await response.json();
    return data.content.map(block => block.text || '').join('\n').trim();
}

// ── Main handler ─────────────────────────────────────────────────────────
export default async function handler(req, res) {
    try {
        return await routeRequest(req, res);
    } catch (fatalErr) {
        // Last-resort catch — ensures the client always gets a readable error
        // instead of a bare 500 with no information.
        console.error('Fatal error in /api/analyze:', fatalErr);
        return res.status(500).json({
            error: `Unexpected server error: ${fatalErr.message}`,
            stage: 'fatal'
        });
    }
}

async function routeRequest(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const { action } = req.body;

    // ── ACTION: extract ──────────────────────────────────────────────────
    if (action === 'extract') {
        const { fileData, fileName } = req.body;

        if (!fileData) {
            return res.status(400).json({ error: 'Missing file data' });
        }

        try {
            const buffer = Buffer.from(fileData, 'base64');

            let pdfData;
            try {
                const pdfParse = await loadPdfParser();
                pdfData = await pdfParse(buffer);
            } catch (parseErr) {
                return res.status(500).json({
                    error: `PDF parsing library failed to load or process this file: ${parseErr.message}`,
                    stage: 'pdf_parse'
                });
            }

            const fullText = pdfData.text;

            if (!fullText || fullText.trim().length < 100) {
                return res.status(400).json({
                    error: 'Could not extract readable text from this PDF. It may be a scanned image without selectable text.'
                });
            }

            const beginningText = fullText.substring(0, 2000);
            const candidate = extractReferenceCandidate(fullText);

            if (candidate.method === 'unvalidated_fallback' && candidate.score < VALIDATION_THRESHOLD) {
                return res.status(422).json({
                    error: 'Could not confidently locate a reference list in this document. The file may not contain a standard reference section, or the PDF text extraction may have failed for that section. Try a different file or paste your references directly.'
                });
            }

            const structured = await structureReferencesWithGroq(candidate.text, beginningText);

            if (!structured.references || structured.references.length === 0) {
                return res.status(422).json({
                    error: 'A reference-like section was found but no individual references could be identified within it.'
                });
            }

            return res.status(200).json({
                title: structured.title || fileName,
                documentType: structured.documentType || 'reference_list',
                references: structured.references,
                summary: structured.summary || `${structured.references.length} references found`,
                extractionMethod: candidate.method,
                extractionScore: Math.round(candidate.score * 10) / 10
            });

        } catch (err) {
            return res.status(500).json({ error: `Could not process document: ${err.message}` });
        }
    }

    // ── ACTION: deepdive ─────────────────────────────────────────────────
    if (action === 'deepdive') {
        const { references, documentType, title } = req.body;

        if (!references || references.length === 0) {
            return res.status(400).json({ error: 'No references provided for analysis' });
        }

        try {
            const result = await runDeepDiveAnalysis(references, documentType, title);
            return res.status(200).json({ result });
        } catch (err) {
            return res.status(500).json({ error: err.message });
        }
    }

    return res.status(400).json({ error: 'Invalid action' });
}
