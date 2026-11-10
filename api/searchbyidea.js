// Search by Idea: deterministic multi-source retrieval, existing CSL formatting.
import { formatSingle } from '../lib/formatter.js';
import { searchPapers, validateSearch } from '../lib/retrieval/search.js';
import { toCSL } from '../lib/retrieval/papers.js';
import { createResearchHandler } from '../lib/research/orchestration.js';
import { verifyActor, supabaseConfig, ResearchError } from '../lib/research/auth.js';

const researchHandler = createResearchHandler();
const ANONYMOUS_PREVIEW_LIMIT = 5;

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({error:'Method not allowed'});
    if (Object.hasOwn(req.body || {}, 'action')) return researchHandler(req, res);
    const { idea, format='Harvard', yearFrom, yearTo, continuation, preview=false } = req.body || {};
    if (preview !== false && preview !== true) return res.status(400).json({error:'Invalid preview option'});
    // Full legacy retrieval requires a verified user; anonymous callers always get the preview.
    // Credit authorization still needs to be consolidated into a server-side transaction.
    if (!preview) {
        try { await verifyActor(req, { config: supabaseConfig() }); }
        catch (err) {
            if (err instanceof ResearchError) return res.status(err.status).json({error:err.code});
            return res.status(503).json({error:'AUTH_UNAVAILABLE'});
        }
    }
    const options = {query:idea,yearFrom,yearTo,continuation};
    try { validateSearch(options); }
    catch(err) { return res.status(400).json({error:err.message}); }
    try {
        const result = await searchPapers(options);
        const failedSources=Object.entries(result.sourceStatus).filter(([,status])=>status.status==='error').map(([name])=>name);
        const incomplete=failedSources.length>0;
        if(result.allSourcesFailed) return res.status(502).json({error:'All scholarly sources are unavailable',sourceStatus:result.sourceStatus,failedSources,incomplete:true,continuation:result.continuation});
        const acquiredCount=result.papers.length;
        const selected=preview?result.papers.slice(0,ANONYMOUS_PREVIEW_LIMIT):result.papers;
        // Sequential formatting reuses the existing style cache instead of fetching the same CSL file in parallel.
        const papers = [];
        for (const paper of selected) {
            let formatted='',formattingError=null;
            try { formatted=await formatSingle(toCSL(paper),format); }
            catch { formattingError='Citation formatting unavailable'; }
            papers.push({...paper, authors:paper.authors.map(a=>[a.family,a.given].filter(Boolean).join(', ')),
                doiUrl:paper.doi?`https://doi.org/${paper.doi}`:null,formatted,formattingError});
        }
        return res.status(200).json({papers,formatted:papers.map(p=>p.formatted).filter(Boolean).join('\n'),
            total:result.total,totalIsExact:result.totalIsExact,sourceStatus:result.sourceStatus,failedSources,incomplete,continuation:result.continuation,
            preview,previewLimit:preview?ANONYMOUS_PREVIEW_LIMIT:null,acquiredCount,
            ...(!papers.length?{message:'No papers found for this topic. Try different keywords.'}:{})});
    } catch(err) {
        console.error('Search by idea error:',err.message);
        return res.status(500).json({error:'Search failed. Please try again.'});
    }
}
