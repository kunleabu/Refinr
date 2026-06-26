export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { idea, format, yearFrom, yearTo } = req.body;
  if (!idea) return res.status(400).json({ error: 'Missing search idea' });

  const citationFormat = format || 'Harvard';
  const resultLimit = 20; // increased from 8

  try {
    // ── Step 1: Search OpenAlex — sort by relevance score not citation count ──
    const searchQuery = encodeURIComponent(idea);

    // Build year filter if provided
    let yearFilter = '';
    if (yearFrom && yearTo) yearFilter = `,publication_year:${yearFrom}-${yearTo}`;
    else if (yearFrom) yearFilter = `,publication_year:>${yearFrom}`;
    else if (yearTo) yearFilter = `,publication_year:<${yearTo}`;

    const openAlexUrl = `https://api.openalex.org/works?search=${searchQuery}&per_page=${resultLimit}&select=id,title,authorships,publication_year,primary_location,doi,type,abstract_inverted_index&sort=relevance_score:desc${yearFilter ? `&filter=${yearFilter.slice(1)}` : ''}`;

    const openAlexRes = await fetch(openAlexUrl, {
      headers: { 'User-Agent': 'Refinr/1.0 (mailto:hello.refinr@gmail.com)' }
    });

    const openAlexData = await openAlexRes.json();

    if (!openAlexData.results || openAlexData.results.length === 0) {
      return res.status(200).json({ papers: [], formatted: '', total: 0, message: 'No papers found. Try different keywords.' });
    }

    // ── Step 2: Structure the raw data including DOI links ──
    const papers = openAlexData.results.map(function(work) {
      const authors = (work.authorships || [])
        .slice(0, 6)
        .map(function(a) { return a.author?.display_name || ''; })
        .filter(Boolean);

      const journal = work.primary_location?.source?.display_name || '';
      const doi = work.doi ? work.doi.replace('https://doi.org/', '') : '';
      const doiUrl = work.doi || (doi ? `https://doi.org/${doi}` : '');
      const openAlexId = work.id || '';

      // Reconstruct abstract from inverted index if available
      let abstract = '';
      if (work.abstract_inverted_index) {
        try {
          const words = {};
          for (const [word, positions] of Object.entries(work.abstract_inverted_index)) {
            positions.forEach(pos => { words[pos] = word; });
          }
          abstract = Object.keys(words).sort((a, b) => a - b).map(k => words[k]).join(' ').substring(0, 300);
        } catch {}
      }

      return {
        title: work.title || 'Unknown title',
        authors,
        year: work.publication_year || '',
        journal,
        doi,
        doiUrl,
        openAlexUrl: openAlexId ? `https://openalex.org/${openAlexId.split('/').pop()}` : '',
        abstract,
        type: work.type || 'article'
      };
    });

    // ── Step 3: Format with Groq ──
    const papersText = papers.map(function(p, i) {
      return `${i + 1}. Title: ${p.title}
Authors: ${p.authors.join(', ') || 'Unknown'}
Year: ${p.year}
Journal: ${p.journal || 'N/A'}
DOI: ${p.doi || 'N/A'}`;
    }).join('\n\n');

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
          content: `You are an academic reference formatter. Format each paper as a proper ${citationFormat} reference. Return ONLY the formatted references, numbered, one per line. No explanations, no preamble. If a DOI is available, include it at the end. Use exact author names, titles, years and journals provided — do not invent or change any details.`
        }, {
          role: 'user',
          content: `Format these papers as ${citationFormat} references:\n\n${papersText}`
        }]
      })
    });

    const groqData = await groqRes.json();
    const formattedRefs = groqData.choices[0].message.content;

    return res.status(200).json({
      papers,
      formatted: formattedRefs,
      total: openAlexData.meta?.count || papers.length,
      format: citationFormat
    });

  } catch (error) {
    console.error('Search by idea error:', error);
    return res.status(500).json({ error: 'Search failed. Please try again.' });
  }
}
