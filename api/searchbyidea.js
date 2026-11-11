// Search by Idea: deterministic multi-source retrieval, existing CSL formatting.
import { formatSingle } from '../lib/formatter.js';
import { searchPapers, validateSearch } from '../lib/retrieval/search.js';
import { toCSL } from '../lib/retrieval/papers.js';
import { createResearchHandler } from '../lib/research/orchestration.js';
import { verifyActor, supabaseConfig, ResearchError } from '../lib/research/auth.js';

const researchHandler = createResearchHandler();
const ANONYMOUS_PREVIEW_LIMIT = 5;

export default async function handler(req, res) {
    if (req.method === 'GET') return res.status(200).json({serverChargedSearch:process.env.REFINR_SERVER_CHARGED_SEARCH === 'true'});
    if (req.method !== 'POST') return res.status(405).json({error:'Method not allowed'});
    if (Object.hasOwn(req.body || {}, 'action')) return researchHandler(req, res);
    const { idea, format='Harvard', yearFrom, yearTo, continuation, preview=false } = req.body || {};
    if (preview !== false && preview !== true) return res.status(400).json({error:'Invalid preview option'});
    // Full legacy retrieval requires a verified user; anonymous callers always get the preview.
    // Credit authorization still needs to be consolidated into a server-side transaction.
    let actorId = null;
    if (!preview) {
        try { actorId = await verifyActor(req, { config: supabaseConfig() }); }
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
        if (!preview && process.env.REFINR_SERVER_CHARGED_SEARCH === 'true' && papers.length) {
            const requestId = req.body?.requestId;
            if (typeof requestId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId)) {
                return res.status(400).json({error:'REQUEST_ID_REQUIRED'});
            }
            const config = supabaseConfig();
            const debit = await fetch(`${config.url}/rest/v1/rpc/refinr_debit_credits`, {
                method:'POST',
                headers:{Authorization:`Bearer ${config.serviceKey}`,apikey:config.serviceKey,'Content-Type':'application/json'},
                body:JSON.stringify({p_user_id:actorId,p_amount:2,p_description:'Search by idea',p_request_id:requestId})
            });
            if (!debit.ok) {
                const detail=await debit.json().catch(()=>({}));
                if(detail.message==='INSUFFICIENT_CREDITS') return res.status(402).json({error:'INSUFFICIENT_CREDITS'});
                if(detail.message==='REQUEST_ID_CONFLICT') return res.status(409).json({error:'REQUEST_ID_CONFLICT'});
                return res.status(503).json({error:'CREDIT_CHARGE_UNAVAILABLE'});
            }
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
