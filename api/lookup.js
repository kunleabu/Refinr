// ── SHARED: Format raw reference text into requested citation style via Groq ──
async function formatWithGroq(rawRef, format, apiKey) {
  try {
    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        max_tokens: 300,
        messages: [
          { role: 'system', content: `Format the following reference in ${format} citation style. Return only the formatted reference, nothing else.` },
          { role: 'user', content: rawRef }
        ]
      })
    });
    const d = await r.json();
    return d.choices[0].message.content.trim();
  } catch {
    return rawRef;
  }
}

// ── SHARED: Build a raw reference string from CrossRef-style item data ──
function buildRawRef(item, doi) {
  const authors = item.author
    ? item.author.map(a => `${a.family || ''}, ${a.given || ''}`).join('; ')
    : 'Unknown Author';
  const year = item.issued?.['date-parts']?.[0]?.[0] || 'n.d.';
  const title = item.title?.[0] || 'Unknown Title';
  const journal = item['container-title']?.[0] || '';
  const volume = item.volume || '';
  const issue = item.issue || '';
  const pages = item.page || '';
  const publisher = item.publisher || '';

  let rawRef = `${authors} (${year}) ${title}`;
  if (journal) rawRef += `. ${journal}`;
  if (volume) rawRef += `, ${volume}`;
  if (issue) rawRef += `(${issue})`;
  if (pages) rawRef += `, pp. ${pages}`;
  if (publisher && !journal) rawRef += `. ${publisher}`;
  if (doi) rawRef += `. doi: ${doi}`;
  return rawRef;
}

// ── DOI / ISBN LOOKUP ────────────────────────────────────────────────────
async function lookupIdentifiers(identifiers, format, apiKey) {
  const lines = identifiers.split('\n').filter(l => l.trim().length > 0);
  let results = [];

  for (const line of lines) {
    const id = line.trim();
    if (!id) continue;

    try {
      let rawData = null;
      const isDOI = id.startsWith('10.') || id.toLowerCase().includes('doi');
      const cleanID = id.replace(/^doi:\s*/i, '').trim();

      if (isDOI) {
        const response = await fetch(`https://api.crossref.org/works/${encodeURIComponent(cleanID)}`);
        if (response.ok) {
          const data = await response.json();
          const item = data.message;
          rawData = {
            title: item.title?.[0] || 'Unknown',
            year: item.issued?.['date-parts']?.[0]?.[0] || 'Unknown',
            authors: item.author ? item.author.map(a => `${a.family || ''}, ${a.given || ''}`).join('; ') : 'Unknown',
            journal: item['container-title']?.[0] || '',
            volume: item.volume || '',
            issue: item.issue || '',
            pages: item.page || '',
            publisher: item.publisher || '',
            doi: cleanID,
            type: item.type || 'journal-article'
          };
        }
      } else {
        const cleanISBN = id.replace(/[^0-9X]/gi, '');
        const response = await fetch(`https://openlibrary.org/api/books?bibkeys=ISBN:${cleanISBN}&format=json&jscmd=data`);
        if (response.ok) {
          const data = await response.json();
          const book = data[`ISBN:${cleanISBN}`];
          if (book) {
            rawData = {
              title: book.title || 'Unknown',
              year: book.publish_date || 'Unknown',
              authors: book.authors ? book.authors.map(a => a.name).join('; ') : 'Unknown',
              publisher: book.publishers?.[0]?.name || 'Unknown',
              place: book.publish_places?.[0]?.name || '',
              isbn: cleanISBN,
              type: 'book'
            };
          }
        }
      }

      if (!rawData) {
        results.push(`❌ NOT FOUND — ${id}`);
        continue;
      }

      const formatResponse = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: 'llama-3.3-70b-versatile',
          max_tokens: 300,
          messages: [
            { role: 'system', content: `You are a professional academic reference formatter. Format the provided bibliographic data into a single properly formatted ${format} citation. Return only the formatted citation, nothing else.` },
            { role: 'user', content: `Format this into a ${format} citation:\n${JSON.stringify(rawData)}` }
          ]
        })
      });

      const formatData = await formatResponse.json();
      const formatted = formatData.choices[0].message.content.trim();
      results.push(`✅ ${formatted}`);

    } catch (error) {
      results.push(`⚠️ ERROR looking up — ${id}`);
    }
  }

  return results;
}

// ── URL LOOKUP ───────────────────────────────────────────────────────────
async function lookupByURL(urls, format, apiKey) {
  const urlList = urls.split('\n').filter(u => u.trim().length > 0);
  let results = [];

  for (const url of urlList) {
    const trimmed = url.trim();
    if (!trimmed) continue;

    try {
      let rawRef = null;

      // Step 1 — Standard DOI in URL
      const doiMatch = trimmed.match(/10\.\d{4,9}\/[^\s&?#]+/);
      if (doiMatch) {
        const doi = doiMatch[0].replace(/[.,;)\]]+$/, '');
        try {
          const r = await fetch(`https://api.crossref.org/works/${encodeURIComponent(doi)}`);
          if (r.ok) {
            const d = await r.json();
            rawRef = buildRawRef(d.message, doi);
          }
        } catch {}
      }

      // Step 2 — PubMed URL
      if (!rawRef && trimmed.includes('pubmed.ncbi.nlm.nih.gov')) {
        const pmidMatch = trimmed.match(/\/(\d+)\/?/);
        if (pmidMatch) {
          const pmid = pmidMatch[1];
          try {
            const r = await fetch(`https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=pubmed&id=${pmid}&retmode=json`);
            if (r.ok) {
              const d = await r.json();
              const article = d.result?.[pmid];
              if (article) {
                const authors = article.authors ? article.authors.map(a => a.name).join('; ') : 'Unknown Author';
                const year = article.pubdate?.split(' ')?.[0] || 'n.d.';
                const title = article.title || 'Unknown Title';
                const journal = article.fulljournalname || article.source || '';
                const volume = article.volume || '';
                const issue = article.issue || '';
                const pages = article.pages || '';
                const doi = article.elocationid?.replace('doi: ', '') || '';
                rawRef = `${authors} (${year}) ${title}`;
                if (journal) rawRef += `. ${journal}`;
                if (volume) rawRef += `, ${volume}`;
                if (issue) rawRef += `(${issue})`;
                if (pages) rawRef += `, pp. ${pages}`;
                if (doi) rawRef += `. doi: ${doi}`;
              }
            }
          } catch {}
        }
      }

      // Step 3 — Nature/Science/Cell journal slug search
      if (!rawRef && (trimmed.includes('nature.com') || trimmed.includes('science.org') || trimmed.includes('cell.com'))) {
        const slug = trimmed.split('/').pop().replace(/-/g, ' ');
        try {
          const r = await fetch(`https://api.crossref.org/works?query=${encodeURIComponent(slug)}&rows=1`);
          if (r.ok) {
            const d = await r.json();
            const item = d.message.items?.[0];
            if (item && item.score > 3) rawRef = buildRawRef(item, item.DOI);
          }
        } catch {}
      }

      // Step 4 — Fallback to Groq webpage citation
      if (!rawRef) {
        const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
          body: JSON.stringify({
            model: 'llama-3.3-70b-versatile',
            max_tokens: 300,
            messages: [
              { role: 'system', content: `Format this URL as a ${format} online/webpage citation. Include the URL and access date. Return only the formatted citation.` },
              { role: 'user', content: `Format a ${format} citation for:\n${trimmed}\nAccess date: ${new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}` }
            ]
          })
        });
        const d = await r.json();
        results.push(`✅ ${d.choices[0].message.content.trim()}`);
        continue;
      }

      const formatted = await formatWithGroq(rawRef, format, apiKey);
      results.push(`✅ ${formatted}`);

    } catch (error) {
      results.push(`⚠️ ERROR processing — ${trimmed}`);
    }
  }

  return results;
}

// ── TITLE LOOKUP ─────────────────────────────────────────────────────────
async function lookupByTitle(titles, format, apiKey) {
  const titleList = titles.split('\n').filter(t => t.trim().length > 0);
  let results = [];

  for (const title of titleList) {
    const query = title.trim();
    if (!query) continue;

    try {
      const crossrefResponse = await fetch(`https://api.crossref.org/works?query=${encodeURIComponent(query)}&rows=1`);
      const crossrefData = await crossrefResponse.json();
      const item = crossrefData.message.items[0];

      if (!item || item.score < 3) {
        const openAlexResponse = await fetch(`https://api.openalex.org/works?search=${encodeURIComponent(query)}&per-page=1`);
        const openAlexData = await openAlexResponse.json();
        const alexItem = openAlexData.results?.[0];

        if (!alexItem) {
          results.push(`❌ NOT FOUND — "${query}"`);
          continue;
        }

        const authors = alexItem.authorships ? alexItem.authorships.map(a => a.author?.display_name || '').join('; ') : 'Unknown Author';
        const year = alexItem.publication_year || 'n.d.';
        const foundTitle = alexItem.title || 'Unknown Title';
        const journal = alexItem.primary_location?.source?.display_name || '';
        const doi = alexItem.doi || '';

        let rawRef = `${authors} (${year}) ${foundTitle}`;
        if (journal) rawRef += `. ${journal}`;
        if (doi) rawRef += `. doi: ${doi}`;

        const formatted = await formatWithGroq(rawRef, format, apiKey);
        results.push(`✅ ${formatted}`);
        continue;
      }

      const authors = item.author ? item.author.map(a => `${a.family || ''}, ${a.given || ''}`).join('; ') : 'Unknown Author';
      const year = item.issued?.['date-parts']?.[0]?.[0] || 'n.d.';
      const foundTitle = item.title?.[0] || 'Unknown Title';
      const journal = item['container-title']?.[0] || '';
      const volume = item.volume || '';
      const issue = item.issue || '';
      const pages = item.page || '';
      const publisher = item.publisher || '';
      const doi = item.DOI || '';

      let rawRef = `${authors} (${year}) ${foundTitle}`;
      if (journal) rawRef += `. ${journal}`;
      if (volume) rawRef += `, ${volume}`;
      if (issue) rawRef += `(${issue})`;
      if (pages) rawRef += `, pp. ${pages}`;
      if (publisher && !journal) rawRef += `. ${publisher}`;
      if (doi) rawRef += `. doi: ${doi}`;

      const formatted = await formatWithGroq(rawRef, format, apiKey);
      results.push(`✅ ${formatted}\n 🔗 DOI: ${doi}`);

    } catch (error) {
      results.push(`⚠️ ERROR searching — "${query}"`);
    }
  }

  return results;
}

// ── MAIN HANDLER ─────────────────────────────────────────────────────────
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { action, identifiers, urls, titles, format } = req.body;
  const apiKey = process.env.GROQ_API_KEY;

  if (!format) {
    return res.status(400).json({ error: 'Missing format' });
  }

  try {
    // Default to 'identifiers' action for backward compatibility with old frontend calls
    const lookupAction = action || (identifiers ? 'identifiers' : urls ? 'url' : titles ? 'title' : null);

    if (lookupAction === 'identifiers') {
      if (!identifiers) return res.status(400).json({ error: 'Missing identifiers' });
      const results = await lookupIdentifiers(identifiers, format, apiKey);
      return res.status(200).json({ results });
    }

    if (lookupAction === 'url') {
      if (!urls) return res.status(400).json({ error: 'Missing urls' });
      const results = await lookupByURL(urls, format, apiKey);
      return res.status(200).json({ results });
    }

    if (lookupAction === 'title') {
      if (!titles) return res.status(400).json({ error: 'Missing titles' });
      const results = await lookupByTitle(titles, format, apiKey);
      return res.status(200).json({ results });
    }

    return res.status(400).json({ error: 'Invalid or missing action. Use "identifiers", "url", or "title".' });

  } catch (error) {
    console.error('Lookup error:', error);
    return res.status(500).json({ error: 'Lookup failed. Please try again.' });
  }
}
