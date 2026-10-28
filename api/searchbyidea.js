// Search by Idea: deterministic multi-source retrieval, existing CSL formatting.
import { formatSingle } from '../lib/formatter.js';
import { searchPapers, validateSearch } from '../lib/retrieval/search.js';
import { toCSL } from '../lib/retrieval/papers.js';
import { createResearchHandler } from '../lib/research/orchestration.js';

const researchHandler = createResearchHandler();

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({error:'Method not allowed'});
    if (Object.hasOwn(req.body || {}, 'action')) return researchHandler(req, res);
    const { idea, format='Harvard', yearFrom, yearTo, continuation } = req.body || {};
    const options = {query:idea,yearFrom,yearTo,continuation};
    try { validateSearch(options); }
    catch(err) { return res.status(400).json({error:err.message}); }
    try {
        const result = await searchPapers(options);
        if(result.allSourcesFailed) return res.status(502).json({error:'All scholarly sources are unavailable',sourceStatus:result.sourceStatus,continuation:result.continuation});
        // Sequential formatting reuses the existing style cache instead of fetching the same CSL file in parallel.
        const papers = [];
        for (const paper of result.papers) {
            let formatted='',formattingError=null;
            try { formatted=await formatSingle(toCSL(paper),format); }
            catch { formattingError='Citation formatting unavailable'; }
            papers.push({...paper, authors:paper.authors.map(a=>[a.family,a.given].filter(Boolean).join(', ')),
                doiUrl:paper.doi?`https://doi.org/${paper.doi}`:null,formatted,formattingError});
        }
        return res.status(200).json({papers,formatted:papers.map(p=>p.formatted).filter(Boolean).join('\n'),
            total:result.total,totalIsExact:result.totalIsExact,sourceStatus:result.sourceStatus,continuation:result.continuation,
            ...(!papers.length?{message:'No papers found for this topic. Try different keywords.'}:{})});
    } catch(err) {
        console.error('Search by idea error:',err.message);
        return res.status(500).json({error:'Search failed. Please try again.'});
    }
}
