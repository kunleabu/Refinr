import test from 'node:test';
import assert from 'node:assert/strict';
import { ResearchError, verifyActor, sessionActionsEnabled, supabaseConfig } from '../lib/research/auth.js';
import { createRepository, publicPull, publicSession } from '../lib/research/repository.js';
import { createResearchHandler, canonicalHash } from '../lib/research/orchestration.js';
import { selectPapers, newEvidence, formatRows, selectAcquired, paperAliases, rankRows } from '../lib/research/presentation.js';
const A='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', B='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const S='11111111-1111-4111-8111-111111111111', P='22222222-2222-4222-8222-222222222222', ID='33333333-3333-4333-8333-333333333333', KEY='44444444-4444-4444-8444-444444444444';
const config={url:'https://rqwtphusjztwtlbmkmgf.supabase.co',anonKey:'fake-staging-anon',serviceKey:'fake-staging-service'};
const env={SEARCH_BY_IDEA_SESSIONS_ENABLED:'true',NODE_ENV:'test'};
const response=(data,status=200)=>({ok:status>=200&&status<300,status,json:async()=>structuredClone(data)});
const metadata={id:'doi:10.1234/test',doi:'10.1234/test',title:'Learning in schools',year:2020,authors:[{family:'Smith',given:'Jane'}],type:'article-journal',provenance:[{source:'openalex',id:'W1',rank:1}],identifiers:{doi:'10.1234/test',openalex:'W1'},citationCounts:{openalex:10},sourceRecords:[],abstract:'Health outcomes in schools'};
const session={id:S,owner_id:A,row_version:2,context_revision:1,citation_style:'Harvard',retrieval_query:'learning',year_from:2019,year_to:2021};
const row={id:ID,session_id:S,canonical_key:metadata.id,metadata,row_version:0,last_presented_revision:null,last_presented_at:null,last_viewed_at:null,saved_at:null,cited_at:null,rejected_at:null,merged_into_id:null};
const reservation={pullId:P,disposition:'execute',receiptVersion:1,attemptToken:'private-execution-token',attemptSources:{openalex:{cursor:'advanced'}},sourceConfig:{openalex:1,crossref:1},query:'learning',yearFrom:2019,yearTo:2021};
const result={papers:[metadata],sourceStatus:{openalex:{status:'ok',returned:3,total:100}},continuation:{version:1,query:'learning',yearFrom:2019,yearTo:2021,sources:{openalex:{cursor:'next'}}}};
async function invoke(handler,body,headers={authorization:'Bearer fake-user-token'}) {
    const res={statusCode:200,status(n){this.statusCode=n;return this;},json(v){this.data=v;return this;}};
    await handler({method:'POST',body,headers},res);return res;
}
function harness(overrides={}) {
    const calls=[], observations=[];
    const receipt={id:P,session_id:S,request_id:KEY,pull_kind:'initial',context_revision:1,receipt_version:1,execution_status:'running',acquisition_status:'pending',acquired_paper_ids:[],output_continuation:{},source_progress:{},response_snapshot:{},attempt_requests:{}};
    let actor, searchCalls=0, committed=false;
    const repo={
        getSession:async()=>structuredClone(session),findPull:async()=>null,
        getPull:async()=>structuredClone(receipt),findAliases:async()=>[],paperRows:async(s,ids)=>ids.length?[structuredClone(row)]:[],
        listPapers:async()=>[structuredClone(row)],listSessions:async()=>[structuredClone(session)],
        rpc:async(name,args)=>{
            calls.push({name,args});
            if(name==='begin_research_pull'||name==='retry_failed_research_sources')return structuredClone(reservation);
            if(name==='complete_research_pull') {
                committed=true;receipt.execution_status='idle';receipt.receipt_version=2;
                const statuses=Object.values(args.p_source_results).map(s=>s.status);
                receipt.acquisition_status=statuses.every(s=>s==='error')?'failed':statuses.includes('error')?'partial':'complete';
                receipt.source_progress=args.p_source_results;receipt.attempt_result_hash=args.p_result_hash;receipt.acquired_paper_ids=args.p_papers.length?[ID]:[];
                receipt.response_snapshot={acquisitionSaved:true,presentedPaperIds:args.p_present_aliases.length?[ID]:[],continuationAppliedSources:['openalex']};
                return {persisted:true};
            }
            if(name==='create_research_session'||name==='update_research_session')return {persisted:true,session:structuredClone(session)};
            if(name==='delete_research_session')return {persisted:true,deleted:true,sessionId:S};
            if(name==='update_research_paper')return {persisted:true,paper:structuredClone(row)};
            if(name==='present_research_papers')return {persisted:true,presentedPaperIds:args.p_paper_ids,contextRevision:1};
            if(name==='fail_research_pull')return {persisted:true};
            throw Error('Unexpected RPC');
        }
    };
    const deps={env,config,fetchImpl:async(url,opts)=>{observations.push({url,opts});return response({id:A});},
        repositoryFactory:({actor:a})=>{actor=a;return repo;},
        search:async(opts,transport)=>{searchCalls++;assert.ok(calls.some(c=>c.name==='begin_research_pull'||c.name==='retry_failed_research_sources'));observations.push({searchOptions:opts,transport});return structuredClone(result);},
        formatter:async()=>{assert.ok(committed||!calls.some(c=>c.name==='begin_research_pull'));return 'Formatted reference';},...overrides};
    return {handler:createResearchHandler(deps),repo,deps,calls,receipt,observations,get actor(){return actor;},get searchCalls(){return searchCalls;}};
}
const acquire={action:'pull.acquire',sessionId:S,requestId:KEY,expectedVersion:2,contextRevision:1,pullKind:'initial',limit:2};

test('production gate cannot be enabled by flag on production deployments',()=>{
    assert.equal(sessionActionsEnabled({...env,VERCEL_ENV:'production'}),false);
    assert.equal(sessionActionsEnabled({...env,NODE_ENV:'production'}),false);
    assert.equal(sessionActionsEnabled({...env,NODE_ENV:'production',VERCEL_ENV:'preview'}),true);
    assert.equal(sessionActionsEnabled({}),false);
});
test('Supabase configuration rejects unsafe destinations and missing credentials',()=>{
    assert.deepEqual(supabaseConfig({SUPABASE_URL:config.url,SUPABASE_ANON_KEY:'a',SUPABASE_SERVICE_KEY:'s'}),{url:config.url,anonKey:'a',serviceKey:'s'});
    for(const url of ['http://local.invalid','https://user:password@rqwtphusjztwtlbmkmgf.supabase.co',config.url+'?token=fake','https://production.invalid'])assert.throws(()=>supabaseConfig({SUPABASE_URL:url}),ResearchError);
});
test('Auth calls verified user endpoint with bearer and anon key, derives actor UUID',async()=>{
    let observed;
    const id=await verifyActor({headers:{authorization:'Bearer fake-token'}},{config,fetchImpl:async(url,opts)=>{observed={url,opts};return response({id:A});}});
    assert.equal(id,A);assert.equal(observed.url,config.url+'/auth/v1/user');assert.equal(observed.opts.headers.apikey,config.anonKey);assert.equal(observed.opts.redirect,'error');
});
for(const [name,fetchImpl,status] of [
    ['invalid',async()=>response({},401),401],['expired',async()=>response({},403),401],
    ['unavailable',async()=>{throw Error('secret upstream stack');},503],['invalid UUID',async()=>response({id:'not-a-uuid'}),401],
    ['malformed response',async()=>({ok:true,json:async()=>{throw Error('private');}}),503],['server failure',async()=>response({},500),503]
])test(`Auth ${name} never grants access or exposes upstream details`,async()=>{
    const h=harness({fetchImpl});const r=await invoke(h.handler,{action:'session.get',sessionId:S});assert.equal(r.statusCode,status);assert.equal(h.calls.length,0);assert.ok(!JSON.stringify(r.data).includes('private'));
});
test('anonymous request is rejected before repository use',async()=>{
    const h=harness();const r=await invoke(h.handler,{action:'session.get',sessionId:S},{});assert.equal(r.statusCode,401);assert.equal(h.actor,undefined);
});
test('dispatcher rejects unknown, disabled and explicit null actions without fallback',async()=>{
    for(const [action,status] of [['nonsense',400],['session.get',503],[null,400]]) {
        const h=harness({env:{}});const r=await invoke(h.handler,{action,sessionId:S});assert.equal(r.statusCode,status);assert.equal(h.searchCalls,0);
    }
});
test('forged identity and authoritative continuation/token/config fields are rejected',async()=>{
    for(const field of ['actor','owner_id','actor_user_id','userId','p_actor','sourceConfig','continuation','attemptToken']) {
        const h=harness();const r=await invoke(h.handler,{...acquire,[field]:B});assert.equal(r.statusCode,400,field);assert.equal(h.calls.length,0);
    }
    const h=harness();assert.equal((await invoke(h.handler,{action:'session.create',requestId:KEY,idea:'learning',context:{topic:'x',extraConstraints:{ownerId:B}}})).statusCode,400);
});
test('malformed IDs, versions, years, enums and oversized requests fail before persistence',async()=>{
    for(const body of [{...acquire,sessionId:'x'},{...acquire,expectedVersion:-1},{...acquire,contextRevision:0},{...acquire,limit:11},{...acquire,pullKind:'other'},
        {action:'session.create',requestId:KEY,idea:'x',context:{topic:'x',yearFrom:2022,yearTo:2020}},
        {action:'paper.update',sessionId:S,paperId:ID,expectedVersion:0,operation:'reject',rejectionScope:null},
        {action:'session.create',requestId:KEY,idea:'x',context:{topic:'x',extraConstraints:{large:'x'.repeat(70000)}}}]) {
        const h=harness();assert.equal((await invoke(h.handler,body)).statusCode,400);assert.equal(h.calls.length,0);
    }
});
test('hashes are deterministic, normalize object key order and bind semantic intent',()=>{
    assert.equal(canonicalHash({b:2,a:{z:3,y:4}}),canonicalHash({a:{y:4,z:3},b:2}));assert.notEqual(canonicalHash({contextRevision:1}),canonicalHash({contextRevision:2}));
});
test('session create normalizes creation payload and exposes no owner/internal snapshot',async()=>{
    const h=harness();const r=await invoke(h.handler,{action:'session.create',requestId:KEY,idea:' learning ',context:{topic:' learning ',yearFrom:'2019'}});
    assert.equal(r.statusCode,200);assert.equal(h.actor,A);const args=h.calls[0].args;assert.equal(args.p_original_idea,'learning');assert.equal(args.p_context.yearFrom,2019);assert.equal(args.p_creation_hash.length,64);assert.equal(r.data.session.owner_id,undefined);
});
test('all non-acquisition actions map to approved RPC/read contracts without retrieval',async()=>{
    const shapes=[['session.list',{}],['session.get',{sessionId:S}],['session.update',{sessionId:S,expectedVersion:2,patch:{population:'adults'}}],['session.delete',{sessionId:S,expectedVersion:2}],['pull.get',{sessionId:S,pullId:P}],['papers.list',{sessionId:S,state:'saved'}],['papers.present',{sessionId:S,expectedVersion:2,contextRevision:1,paperIds:[ID]}],['paper.update',{sessionId:S,paperId:ID,expectedVersion:0,operation:'view'}]];
    for(const [action,body] of shapes){const h=harness();assert.equal((await invoke(h.handler,{action,...body})).statusCode,200,action);assert.equal(h.searchCalls,0);}
});
test('session update forwards only supplied fields and expected version',async()=>{
    const h=harness();await invoke(h.handler,{action:'session.update',sessionId:S,expectedVersion:2,format:' APA ',patch:{population:' adults '}});
    assert.deepEqual(h.calls[0].args,{p_session:S,p_expected_version:2,p_patch:{population:'adults'},p_style:'APA'});
});
test('repository reads include verified owner and establish ownership before child access',async()=>{
    const urls=[];const repo=createRepository({config,actor:A,fetchImpl:async(url)=>{urls.push(new URL(url));return response(url.includes('research_sessions?')?[session]:[]);}});
    await repo.getPull(S,P).catch(e=>assert.equal(e.code,'PULL_NOT_FOUND'));assert.equal(urls[0].searchParams.get('owner_id'),'eq.'+A);assert.equal(urls[1].searchParams.get('session_id'),'eq.'+S);
    assert.ok(!urls[1].searchParams.get('select').includes('attempt_token'));
});
test('repository B cannot read A children when ownership lookup denies access',async()=>{
    let requests=0;const repo=createRepository({config,actor:B,fetchImpl:async(url)=>{requests++;assert.equal(new URL(url).searchParams.get('owner_id'),'eq.'+B);return response([]);}});
    for(const fn of [()=>repo.getPull(S,P),()=>repo.paperRows(S,[ID]),()=>repo.listPapers(S,{limit:20})])await assert.rejects(fn, e=>e.status===404);
    assert.equal(requests,3);
});
test('repository RPC overrides caller actor and only permits approved functions',async()=>{
    let body;const repo=createRepository({config,actor:A,fetchImpl:async(url,opts)=>{body=JSON.parse(opts.body);return response({persisted:true});}});
    await repo.rpc('delete_research_session',{p_actor:B,p_session:S,p_expected_version:0});assert.equal(body.p_actor,A);
    await assert.rejects(()=>repo.rpc('arbitrary_sql',{}),e=>e.status===400);
});
test('repository projects safe errors and distinguishes uncertain writes from failed reads',async()=>{
    const repo=createRepository({config,actor:A,fetchImpl:async()=>response({code:'PT409',message:'STALE_VERSION',details:'secret stack',hint:'private'},409)});
    await assert.rejects(()=>repo.rpc('delete_research_session',{}),e=>e.status===409&&e.code==='STALE_VERSION'&&!e.extra.details);
    const broken=createRepository({config,actor:A,fetchImpl:async()=>{throw Error('password secret');}});
    await assert.rejects(()=>broken.rpc('delete_research_session',{}),e=>e.status===503&&e.extra.outcomeUnknown===true);
    await assert.rejects(()=>broken.getSession(S),e=>e.status===503&&e.extra.outcomeUnknown===false);
});
test('repository keyset lists bound results and do not accept arbitrary state filters',async()=>{
    let url;const repo=createRepository({config,actor:A,fetchImpl:async(u)=>{url=new URL(u);return response([]);}});
    await repo.listSessions({after:S,limit:20});assert.equal(url.searchParams.get('id'),'gt.'+S);assert.equal(url.searchParams.get('limit'),'21');assert.equal(url.searchParams.get('owner_id'),'eq.'+A);
});
test('public projections never expose attempt tokens, hashes, internal snapshots or owner',()=>{
    const projected=JSON.stringify(publicPull({id:P,attempt_token:'secret',attempt_requests:{secret:true},attempt_result_snapshot:{secret:true},request_hash:'secret'}));assert.ok(!projected.includes('secret'));
    assert.equal(publicSession({...session,creation_hash:'secret'}).creation_hash,undefined);
});
test('acquisition retrieves only reserved adapters with native continuation and persists before format',async()=>{
    const h=harness();const r=await invoke(h.handler,acquire);assert.equal(r.statusCode,200);assert.equal(h.searchCalls,1);
    const obs=h.observations.find(o=>o.searchOptions);assert.deepEqual(Object.keys(obs.transport.adapters),['openalex']);assert.deepEqual(obs.searchOptions.continuation.sources,{openalex:{cursor:'advanced'}});
    const completion=h.calls.find(c=>c.name==='complete_research_pull');assert.equal(completion.args.p_source_results.openalex.returned,3);assert.deepEqual(completion.args.p_papers[0].authors,metadata.authors);assert.equal(r.data.papers[0].id,ID);assert.equal(r.data.papers[0].canonicalKey,metadata.id);assert.ok(!JSON.stringify(r.data).includes('private-execution-token'));
});
test('retry uses approved source subset and same pull, not a new acquisition',async()=>{
    const h=harness();await invoke(h.handler,{action:'pull.retry',sessionId:S,pullId:P,requestId:KEY,expectedReceiptVersion:2});assert.equal(h.calls[0].name,'retry_failed_research_sources');assert.equal(h.calls[0].args.p_pull,P);assert.equal(h.calls.some(c=>c.name==='begin_research_pull'),false);
});
test('partial-source completion strips errors, retains all acquired papers and raw source counts',async()=>{
    const h=harness({search:async()=>({papers:[metadata,{...metadata,id:'doi:10.1234/other',doi:'10.1234/other'}],sourceStatus:{openalex:{status:'ok',returned:20,total:100},crossref:{status:'error',error:'secret stack'}},continuation:{sources:{openalex:{cursor:'next'},crossref:{offset:40}}}})});
    const original=h.repo.rpc;h.repo.rpc=async(name,args)=>name==='begin_research_pull'?{...reservation,attemptSources:{openalex:{},crossref:{offset:40}}}:original(name,args);
    const r=await invoke(h.handler,{...acquire,limit:1});assert.equal(r.statusCode,200);const c=h.calls.find(c=>c.name==='complete_research_pull');assert.equal(c.args.p_papers.length,2);assert.equal(c.args.p_present_aliases.length,1);assert.deepEqual(c.args.p_source_results.crossref,{status:'error'});assert.equal(c.args.p_source_results.openalex.returned,20);
});
test('both-source failure returns 502 only after failed receipt persistence',async()=>{
    const h=harness({search:async()=>({papers:[],sourceStatus:{openalex:{status:'error'}},continuation:{sources:{openalex:{cursor:'advanced'}}}})});
    const r=await invoke(h.handler,acquire);assert.equal(r.statusCode,502);assert.equal(r.data.persisted,true);assert.equal(r.data.pull.acquisitionStatus,'failed');assert.equal(r.data.papers.length,0);assert.ok(h.calls.some(c=>c.name==='complete_research_pull'));
});
test('exact replay with stale submitted versions delegates to RPC and never retrieves',async()=>{
    const h=harness();h.repo.findPull=async()=>({request_hash:'existing'});h.repo.getSession=async()=>({...session,context_revision:2,row_version:20});
    const original=h.repo.rpc;h.repo.rpc=async(name,args)=>name==='begin_research_pull'?{pullId:P,disposition:'in_progress'}:original(name,args);
    const r=await invoke(h.handler,acquire);assert.equal(r.statusCode,202);assert.equal(h.searchCalls,0);assert.equal(r.data.papers.length,0);
});
test('intent hashes remain stable on expected-version retries but conflict on changed intent',async()=>{
    const hashes=[];
    for(const b of [acquire,{...acquire,expectedVersion:999},{...acquire,contextRevision:2}]) {
        const h=harness();h.repo.findPull=async()=>({});const original=h.repo.rpc;h.repo.rpc=async(name,args)=>{if(name==='begin_research_pull')hashes.push(args.p_request_hash);return original(name,args);};await invoke(h.handler,b);
    }
    assert.equal(hashes[0],hashes[1]);assert.notEqual(hashes[0],hashes[2]);
});
test('new acquisition with stale context fails before reservation',async()=>{
    const h=harness();h.repo.getSession=async()=>({...session,context_revision:2});const r=await invoke(h.handler,acquire);assert.equal(r.statusCode,409);assert.equal(h.calls.length,0);
});
test('uncertain reservation is reconciled without retrieving or acquiring a second pull',async()=>{
    const h=harness();h.repo.findPull=async()=>h.receipt.request_hash?h.receipt:null;
    h.repo.rpc=async()=>{h.receipt.request_hash=canonicalHash({sessionId:S,contextRevision:1,pullKind:'initial',limit:2});throw new ResearchError(503,'PERSISTENCE_UNAVAILABLE',{outcomeUnknown:true});};
    const r=await invoke(h.handler,acquire);assert.equal(r.statusCode,202);assert.equal(h.searchCalls,0);assert.equal(r.data.pull.id,P);
});
test('uncertain completion reconciles committed result hash and never marks it failed',async()=>{
    const h=harness();const original=h.repo.rpc;h.repo.rpc=async(name,args)=>{const r=await original(name,args);if(name==='complete_research_pull')throw new ResearchError(503,'PERSISTENCE_UNAVAILABLE',{outcomeUnknown:true});return r;};
    const r=await invoke(h.handler,acquire);assert.equal(r.statusCode,200);assert.equal(r.data.acquisitionSaved,true);assert.equal(h.calls.some(c=>c.name==='fail_research_pull'),false);assert.equal(h.searchCalls,1);
});
test('uncertain uncommitted completion cannot claim success, advance state or mark failure',async()=>{
    const h=harness();const original=h.repo.rpc;h.repo.rpc=async(name,args)=>{if(name==='complete_research_pull')throw new ResearchError(503,'PERSISTENCE_UNAVAILABLE',{outcomeUnknown:true});return original(name,args);};
    const r=await invoke(h.handler,acquire);assert.equal(r.statusCode,503);assert.equal(r.data.outcomeUnknown,true);assert.equal(r.data.persisted,undefined);assert.equal(h.receipt.execution_status,'running');assert.equal(h.calls.some(c=>c.name==='fail_research_pull'),false);
});
test('confirmed completion conflict marks only current attempt failed and returns original safe conflict',async()=>{
    const h=harness();const original=h.repo.rpc;h.repo.rpc=async(name,args)=>{if(name==='complete_research_pull')throw new ResearchError(409,'IDENTITY_CONFLICT');return original(name,args);};
    const r=await invoke(h.handler,acquire);assert.equal(r.statusCode,409);assert.equal(r.data.error,'IDENTITY_CONFLICT');assert.ok(h.calls.some(c=>c.name==='fail_research_pull'));assert.equal(r.data.acquisitionSaved,undefined);
});
test('stale-context durable completion returns truthful 409 acquisitionSaved and no discovery',async()=>{
    const h=harness();const original=h.repo.rpc;h.repo.rpc=async(name,args)=>{const r=await original(name,args);if(name==='complete_research_pull')h.receipt.response_snapshot.needsContextRefresh=true;return r;};
    const r=await invoke(h.handler,acquire);assert.equal(r.statusCode,409);assert.equal(r.data.acquisitionSaved,true);assert.deepEqual(r.data.papers,[]);
});
test('formatting failure leaves durable acquisition and UUIDs visible',async()=>{
    const h=harness({formatter:async()=>{throw Error('private formatter details');}});const r=await invoke(h.handler,acquire);assert.equal(r.statusCode,200);assert.equal(r.data.acquisitionSaved,true);assert.equal(r.data.papers[0].id,ID);assert.equal(r.data.papers[0].formattingError,'Citation formatting unavailable');assert.ok(!JSON.stringify(r.data).includes('private'));
});
test('post-commit read failure preserves acknowledged persistence without marking acquisition failed',async()=>{
    const h=harness();h.repo.getPull=async()=>{throw new ResearchError(503,'PERSISTENCE_UNAVAILABLE');};const r=await invoke(h.handler,acquire);assert.equal(r.statusCode,503);assert.equal(r.data.outcomeUnknown,false);assert.equal(r.data.persisted,true);assert.equal(r.data.acquisitionSaved,true);assert.equal(r.data.pullId,P);assert.equal(h.calls.some(c=>c.name==='fail_research_pull'),false);assert.equal(h.receipt.acquisition_status,'complete');
});
test('request processing failure leaves recoverable state if failure RPC is unavailable',async()=>{
    const h=harness({search:async()=>{throw Error('internal secret');}});const original=h.repo.rpc;h.repo.rpc=async(name,args)=>{if(name==='fail_research_pull')throw new ResearchError(503,'PERSISTENCE_UNAVAILABLE');return original(name,args);};const r=await invoke(h.handler,acquire);assert.equal(r.statusCode,503);assert.equal(r.data.acquisitionSaved,undefined);assert.ok(!JSON.stringify(r.data).includes('secret'));
});
test('presentation suppresses lifecycle/seen papers and requires deterministic new evidence',()=>{
    assert.equal(newEvidence('learning','health outcomes',metadata),true);assert.equal(newEvidence('learning','astronomy',metadata),false);
    const seen={...row,last_presented_at:'2026-01-01',last_presented_revision:1,last_presented_query:'learning'};
    assert.deepEqual(selectPapers([seen],{...session,context_revision:2,retrieval_query:'astronomy'},10),[]);
    assert.deepEqual(selectPapers([seen],{...session,context_revision:2,retrieval_query:'health outcomes'},10),[ID]);
    for(const field of ['saved_at','cited_at','rejected_at'])assert.deepEqual(selectPapers([{...row,[field]:'now'}],session,10),[]);
});
test('session actions have no credit/payment calls',async()=>{
    const h=harness();await invoke(h.handler,acquire);assert.ok(h.observations.filter(o=>o.url).every(o=>o.url.endsWith('/auth/v1/user')));assert.ok(h.calls.every(c=>!c.name.includes('credit')&&!c.name.includes('paystack')));
});

test('concurrent HTTP requests delegate execution entitlement to RPC, with only one source call',async()=>{
    const h=harness();let reserved=false;
    const original=h.repo.rpc;
    h.repo.rpc=async(name,args)=>{
        if(name==='begin_research_pull'){
            if(reserved)return {pullId:P,disposition:'in_progress'};
            reserved=true;
        }
        return original(name,args);
    };
    const replies=await Promise.all([invoke(h.handler,acquire),invoke(h.handler,acquire)]);
    assert.equal(h.searchCalls,1);assert.equal(h.calls.filter(c=>c.name==='complete_research_pull').length,1);
    assert.ok(replies.every(r=>[200,202].includes(r.statusCode)));
});
test('RPC-owned stale version/ownership/intent conflicts never reach external retrieval',async()=>{
    for(const [status,code] of [[404,'SESSION_NOT_FOUND'],[409,'STALE_VERSION'],[409,'IDEMPOTENCY_KEY_REUSED'],[409,'PULL_IN_PROGRESS']]){
        const h=harness();h.repo.rpc=async()=>{throw new ResearchError(status,code);};
        const r=await invoke(h.handler,acquire);assert.equal(r.statusCode,status);assert.equal(r.data.error,code);assert.equal(h.searchCalls,0);
    }
});
test('replaying an expired or processing-failed receipt reports its real failure, not an upstream outage',async()=>{
    const h=harness();h.repo.rpc=async()=>({pullId:P,disposition:'replay'});
    h.receipt.execution_status='idle';h.receipt.acquisition_status='failed';h.receipt.response_snapshot={error:'ATTEMPT_EXPIRED',retryable:true};
    const r=await invoke(h.handler,acquire);assert.equal(r.statusCode,503);assert.equal(r.data.error,'ATTEMPT_EXPIRED');assert.equal(h.searchCalls,0);
});
test('unknown RPC errors never leak PostgreSQL details/hints/credentials',async()=>{
    const repo=createRepository({config,actor:A,fetchImpl:async()=>response({code:'42501',message:'credential secret stack',details:'internal schema',hint:'grant everything'},403)});
    await assert.rejects(()=>repo.rpc('delete_research_session',{}),e=>e.code==='PERSISTENCE_UNAVAILABLE'&&!e.message.includes('secret'));
});
test('repository follows merged UUIDs only inside the verified owned session',async()=>{
    const root='55555555-5555-4555-8555-555555555555';const urls=[];
    const repo=createRepository({config,actor:A,fetchImpl:async(url)=>{
        const u=new URL(url);urls.push(u);
        if(u.pathname.endsWith('research_sessions'))return response([session]);
        return response(u.searchParams.get('id')==='eq.'+root?[{...row,id:root}]:[{...row,merged_into_id:root}]);
    }});
    assert.equal((await repo.paperRows(S,[ID]))[0].id,root);
    assert.ok(urls.slice(1).every(u=>u.searchParams.get('session_id')==='eq.'+S));
});
test('corpus-only presentation retrieves no sources and defers final suppression to SQL',async()=>{
    const h=harness();h.repo.listPapers=async()=>[{...row,last_presented_revision:1}];
    const r=await invoke(h.handler,{action:'papers.present',sessionId:S,expectedVersion:2,contextRevision:1});assert.equal(r.statusCode,200);assert.equal(h.searchCalls,0);assert.deepEqual(h.calls.at(-1).args.p_paper_ids,[]);
});
test('acknowledged presentation followed by read failure remains truthfully persisted',async()=>{
    const h=harness();h.repo.paperRows=async()=>{throw new ResearchError(503,'PERSISTENCE_UNAVAILABLE');};
    const r=await invoke(h.handler,{action:'papers.present',sessionId:S,expectedVersion:2,contextRevision:1});
    assert.equal(r.statusCode,503);assert.equal(r.data.persisted,true);assert.equal(r.data.presentationSaved,true);
});
test('all acquired-but-unpresented records remain accessible without another logical pull',async()=>{
    const h=harness();h.repo.listPapers=async()=>[{...row,last_presented_at:null,last_viewed_at:null}];
    const r=await invoke(h.handler,{action:'papers.list',sessionId:S});assert.equal(r.data.papers[0].id,ID);assert.equal(r.data.papers[0].lifecycle.viewedAt,null);assert.equal(h.calls.length,0);assert.equal(h.searchCalls,0);
});

test('full session acquisition connects Auth, ownership reads, real Phase 1 adapters and RPC completion',async()=>{
    const events=[];let durable=null, acquired=null;
    const replyReceipt={id:P,session_id:S,request_id:KEY,pull_kind:'initial',context_revision:1,receipt_version:2,execution_status:'idle',acquisition_status:'complete',response_snapshot:{acquisitionSaved:true,presentedPaperIds:[ID]},acquired_paper_ids:[ID],source_progress:{},output_continuation:{}};
    const h=createResearchHandler({env,config,
        fetchImpl:async(value,opts)=>{
            const u=new URL(value);events.push(u.pathname);
            if(u.pathname==='/auth/v1/user')return response({id:A});
            assert.equal(opts.headers.apikey,config.serviceKey);
            if(u.pathname.endsWith('/research_sessions')){assert.equal(u.searchParams.get('owner_id'),'eq.'+A);return response([session]);}
            if(u.pathname.endsWith('/research_retrievals'))return response(u.searchParams.has('request_id')?[]:[replyReceipt]);
            if(u.pathname.endsWith('/rpc/begin_research_pull')){assert.equal(JSON.parse(opts.body).p_actor,A);return response({...reservation,attemptSources:{openalex:{},crossref:{}}});}
            if(u.pathname.endsWith('/rpc/complete_research_pull')){
                durable=JSON.parse(opts.body);acquired=durable.p_papers[0];replyReceipt.source_progress=durable.p_source_results;return response({persisted:true});
            }
            if(u.pathname.endsWith('/research_paper_aliases'))return response([]);
            if(u.pathname.endsWith('/research_session_papers'))return response([{...row,metadata:acquired}]);
            throw Error('Unplanned destination');
        },
        sourceFetch:async(value)=>{
            assert.ok(events.includes('/rest/v1/rpc/begin_research_pull'));assert.equal(durable,null);
            const u=new URL(value);events.push(u.hostname);
            if(u.hostname==='api.openalex.org')return response({results:[{id:'https://openalex.org/W1',doi:'https://doi.org/10.1234/test',title:'Learning in schools',publication_year:2020,authorships:[{author:{display_name:'Jane Smith'}}]}],meta:{count:1}});
            if(u.hostname==='api.crossref.org')return response({message:{items:[{DOI:'10.1234/test',title:['Learning in schools'],issued:{'date-parts':[[2020]]},author:[{given:'Jane',family:'Smith'}]}],'total-results':1}});
            throw Error('Unplanned scholarly destination');
        },formatter:async(csl,style)=>{assert.ok(durable);assert.equal(style,'Harvard');assert.equal(csl.DOI,'10.1234/test');return 'Formatted';}
    });
    const r=await invoke(h,acquire);assert.equal(r.statusCode,200);assert.equal(durable.p_papers.length,1);assert.equal(durable.p_papers[0].sourceRecords.length,2);assert.equal(durable.p_actor,A);assert.equal(r.data.papers[0].id,ID);
    assert.ok(events.indexOf('api.openalex.org')<events.indexOf('/rest/v1/rpc/complete_research_pull'));
});
test('real repository/handler refuses B ownership before RPC or scholarly HTTP',async()=>{
    const paths=[];
    const h=createResearchHandler({env,config,fetchImpl:async(value)=>{
        const u=new URL(value);paths.push(u.pathname);
        if(u.pathname==='/auth/v1/user')return response({id:B});
        assert.equal(u.searchParams.get('owner_id'),'eq.'+B);return response([]);
    },sourceFetch:async()=>{throw Error('Must never retrieve');}});
    const r=await invoke(h,acquire);assert.equal(r.statusCode,404);assert.equal(r.data.error,'SESSION_NOT_FOUND');assert.ok(paths.every(p=>p==='/auth/v1/user'||p==='/rest/v1/research_sessions'));
});

// Fix-pass regressions: state below models only the reviewed transaction outputs,
// not PostgreSQL locking, RLS, or Auth/PostgREST boundary behavior.
function protectedHarness(overrides = {}) {
    const h = harness(overrides);
    const state = { corpus: [], continuation: {openalex:{cursor:'advanced'},crossref:{offset:40}}, lifecycle: {}, completions: 0 };
    const original = h.repo.rpc;
    h.repo.rpc = async (name, args) => {
        const reply = await original(name,args);
        if (name === 'complete_research_pull') {
            state.completions++;
            state.corpus = structuredClone(args.p_papers);
            for (const [source,outcome] of Object.entries(args.p_source_results)) {
                if (outcome.status === 'ok') state.continuation[source] = structuredClone(outcome.continuation);
            }
            h.receipt.output_continuation = {sources:structuredClone(state.continuation)};
        }
        return reply;
    };
    return {h,state};
}

test('settled real Phase 1 partial result survives work expiry and replay never reacquires',async()=>{
    const work = new AbortController();let upstreamCalls=0;
    const {h,state}=protectedHarness({workSignal:work.signal,search:undefined,
        sourceFetch:async(value,opts)=>{
            upstreamCalls++;
            if(new URL(value).hostname==='api.openalex.org')return response({results:[{id:'W1',doi:'10.1234/test',title:'Learning in schools',publication_year:2020,authorships:[{author:{display_name:'Jane Smith'}}]}],meta:{count:100,next_cursor:'next'}});
            return new Promise((resolve,reject)=>{
                opts.signal.addEventListener('abort',()=>reject(Error('private timeout details')),{once:true});
                setImmediate(()=>work.abort());
            });
        }});
    const original=h.repo.rpc;
    h.repo.rpc=async(name,args)=>name==='begin_research_pull'?{...reservation,attemptSources:{openalex:{cursor:'advanced'},crossref:{offset:40}}}:original(name,args);
    const r=await invoke(h.handler,acquire);
    assert.equal(r.statusCode,200);assert.equal(r.data.acquisitionSaved,true);
    assert.equal(state.corpus.length,1);assert.deepEqual(state.continuation,{openalex:{cursor:'next'},crossref:{offset:40}});
    assert.equal(h.receipt.acquisition_status,'partial');assert.deepEqual(state.lifecycle,{});
    assert.equal(h.calls.some(c=>c.name==='fail_research_pull'),false);
    h.repo.findPull=async()=>h.receipt;h.repo.rpc=async()=>({pullId:P,disposition:'replay'});
    assert.equal((await invoke(h.handler,acquire)).data.acquisitionSaved,true);
    assert.equal(upstreamCalls,2);assert.equal(state.completions,1);
});
test('expired persistence budget prevents completion and protects corpus/continuation/lifecycle',async()=>{
    const persist=new AbortController();
    const {h,state}=protectedHarness({persistenceSignal:persist.signal,search:async()=>{persist.abort();return structuredClone(result);}});
    const before=structuredClone(state);const r=await invoke(h.handler,acquire);
    assert.equal(r.statusCode,503);assert.equal(r.data.error,'RESEARCH_DEADLINE_EXCEEDED');assert.deepEqual(state,before);
    assert.equal(h.calls.some(c=>c.name==='complete_research_pull'),false);assert.equal(h.receipt.acquisition_status,'pending');
});
for(const reconciled of [false,true])for(const failure of ['session','papers'])test(`confirmed completion remains saved after ${reconciled?'reconciled':'acknowledged'} ${failure} read failure`,async()=>{
    const {h,state}=protectedHarness();const original=h.repo.rpc;
    h.repo.rpc=async(name,args)=>{
        const r=await original(name,args);
        if(name==='complete_research_pull'){
            if(failure==='session')h.repo.getSession=async()=>{throw new ResearchError(503,'PERSISTENCE_UNAVAILABLE');};
            else h.repo.paperRows=async()=>{throw new ResearchError(503,'PERSISTENCE_UNAVAILABLE');};
            if(reconciled)throw new ResearchError(503,'PERSISTENCE_UNAVAILABLE',{outcomeUnknown:true});
        }
        return r;
    };
    const r=await invoke(h.handler,acquire);
    assert.equal(r.statusCode,503);assert.equal(r.data.persisted,true);assert.equal(r.data.acquisitionSaved,true);
    assert.equal(r.data.outcomeUnknown,false);assert.equal(r.data.pullId,P);
    assert.equal(state.completions,1);assert.deepEqual(state.corpus,result.papers);assert.deepEqual(state.continuation.openalex,{cursor:'next'});
    assert.deepEqual(state.lifecycle,{});assert.equal(h.receipt.execution_status,'idle');assert.equal(h.calls.some(c=>c.name==='fail_research_pull'),false);
});
for(const reconciled of [false,true])test(`formatting failure preserves ${reconciled?'reconciled':'acknowledged'} durable state`,async()=>{
    const {h,state}=protectedHarness({formatter:async()=>{throw Error('private stack');}});
    const original=h.repo.rpc;
    h.repo.rpc=async(name,args)=>{const r=await original(name,args);if(reconciled&&name==='complete_research_pull')throw new ResearchError(503,'PERSISTENCE_UNAVAILABLE',{outcomeUnknown:true});return r;};
    const r=await invoke(h.handler,acquire);assert.equal(r.statusCode,200);assert.equal(r.data.persisted,true);assert.equal(r.data.acquisitionSaved,true);assert.equal(r.data.pull.id,P);
    assert.equal(r.data.papers[0].formattingError,'Citation formatting unavailable');assert.equal(state.completions,1);assert.deepEqual(state.corpus,result.papers);assert.deepEqual(state.lifecycle,{});
    assert.equal(h.calls.some(c=>c.name==='fail_research_pull'),false);assert.ok(!JSON.stringify(r.data).includes('private'));
});
test('reservation reconciliation response failure preserves known receipt without claiming acquisition',async()=>{
    const h=harness();let reads=0;
    h.repo.findPull=async()=>++reads===1?null:{...h.receipt,request_hash:canonicalHash({sessionId:S,contextRevision:1,pullKind:'initial',limit:2})};
    h.repo.rpc=async()=>{h.repo.getSession=async()=>{throw new ResearchError(503,'PERSISTENCE_UNAVAILABLE');};throw new ResearchError(503,'PERSISTENCE_UNAVAILABLE',{outcomeUnknown:true});};
    const r=await invoke(h.handler,acquire);assert.equal(r.statusCode,503);assert.equal(r.data.persisted,true);assert.equal(r.data.acquisitionSaved,false);assert.equal(r.data.outcomeUnknown,false);assert.equal(r.data.pullId,P);assert.equal(h.searchCalls,0);
});
test('receipt registration between lookup and changed-context read resolves replay through RPC',async()=>{
    const h=harness();let reads=0;
    h.repo.findPull=async()=>++reads===1?null:{...h.receipt,request_hash:canonicalHash({sessionId:S,contextRevision:1,pullKind:'initial',limit:2})};
    h.repo.getSession=async()=>({...session,context_revision:2});
    h.repo.rpc=async(name,args)=>{h.calls.push({name,args});return {pullId:P,disposition:'replay'};};
    const r=await invoke(h.handler,acquire);assert.equal(reads,2);assert.equal(r.statusCode,202);assert.equal(h.searchCalls,0);assert.equal(h.calls[0].name,'begin_research_pull');
});
test('replay-race resolution still leaves changed intent to authoritative RPC conflict',async()=>{
    const h=harness();let reads=0;h.repo.findPull=async()=>++reads===1?null:{request_hash:'different'};
    h.repo.getSession=async()=>({...session,context_revision:2});h.repo.rpc=async()=>{throw new ResearchError(409,'IDEMPOTENCY_KEY_REUSED');};
    const before=structuredClone(h.receipt);const r=await invoke(h.handler,acquire);assert.equal(r.statusCode,409);assert.equal(r.data.error,'IDEMPOTENCY_KEY_REUSED');assert.equal(h.searchCalls,0);assert.deepEqual(h.receipt,before);
});
const SECOND='55555555-5555-4555-8555-555555555555';
const weakRow={...row,id:SECOND,metadata:{...metadata,id:'doi:10.1234/weak',doi:'10.1234/weak',title:'Astronomy',abstract:null,citedBy:99999}};
for(const action of ['pull.acquire','papers.present'])test(`${action} restores relevance ordering from shuffled owned rows`,async()=>{
    const h=harness();h.repo.paperRows=async(s,ids)=>ids.length?[weakRow,row]:[];
    const original=h.repo.rpc;h.repo.rpc=async(name,args)=>{
        const r=await original(name,args);
        if(name==='complete_research_pull')h.receipt.response_snapshot.presentedPaperIds=[SECOND,ID];
        if(name==='present_research_papers')r.presentedPaperIds=[SECOND,ID];return r;
    };
    const r=await invoke(h.handler,action==='pull.acquire'?acquire:{action,sessionId:S,expectedVersion:2,contextRevision:1,paperIds:[SECOND,ID]});
    assert.equal(r.statusCode,200);assert.deepEqual(r.data.papers.map(p=>p.id),[ID,SECOND]);
});
test('acquisition eligibility precedes limit while full corpus persists and later paper needs no reacquisition',async()=>{
    const second={...weakRow.metadata,title:'Learning in schools',abstract:'Health outcomes'};
    const {h,state}=protectedHarness({search:async()=>({...structuredClone(result),papers:[metadata,second]})});
    state.lifecycle[ID]={saved_at:'2026-01-01'};
    h.repo.findAliases=async()=>[{alias:metadata.id,paper_id:ID,ambiguous:false}];
    h.repo.paperRows=async(s,ids)=>!ids.length?[]:h.receipt.execution_status==='running'?[{...row,saved_at:'2026-01-01'}]:[{...weakRow,metadata:second}];
    const original=h.repo.rpc;h.repo.rpc=async(name,args)=>{const r=await original(name,args);if(name==='complete_research_pull')h.receipt.response_snapshot.presentedPaperIds=[SECOND];return r;};
    const r=await invoke(h.handler,{...acquire,limit:1});assert.equal(r.statusCode,200);assert.equal(r.data.papers[0].id,SECOND);
    assert.equal(state.corpus.length,2);assert.deepEqual(h.calls.find(c=>c.name==='complete_research_pull').args.p_present_aliases,[second.id]);
    assert.deepEqual(state.lifecycle[ID],{saved_at:'2026-01-01'});assert.equal(h.searchCalls,0);assert.equal(state.completions,1);
});
function nested(depth) {let value='ok';for(let i=0;i<depth;i++)value={x:value};return value;}
test('request complexity permits depth boundary and rejects deeper JSON before Auth or persistence',async()=>{
    for(const [depth,status] of [[30,200],[31,400],[8000,400]]){
        const h=harness();const before=structuredClone(h.receipt);
        const r=await invoke(h.handler,{action:'session.create',requestId:KEY,idea:'learning',context:{topic:'learning',extraConstraints:nested(depth)}});
        assert.equal(r.statusCode,status);
        if(status===400){assert.equal(r.data.error,'REQUEST_TOO_COMPLEX');assert.equal(h.observations.length,0);assert.equal(h.calls.length,0);assert.deepEqual(h.receipt,before);}
    }
});
test('request node budget rejects wide valid JSON without stack errors or state changes',async()=>{
    const h=harness();const before=structuredClone(h.receipt);
    const r=await invoke(h.handler,{action:'session.create',requestId:KEY,idea:'learning',context:{topic:'learning',extraConstraints:{nodes:Array(10001).fill(0)}}});
    assert.equal(r.statusCode,400);assert.equal(r.data.error,'REQUEST_TOO_COMPLEX');assert.equal(h.calls.length,0);assert.deepEqual(h.receipt,before);
});

test('eligibility fallback requires full identity, ignores ambiguous hashes, and never hides conflicting DOI',async()=>{
    const saved={...row,saved_at:'now'};
    const bib=paperAliases(metadata).find(a=>a.startsWith('bibmeta:'));
    const cases=[
        {alias:bib,existing:saved,ambiguous:false,expected:[]},
        {alias:bib,existing:{...saved,metadata:{...metadata,title:'Learning in schools: different study'}},ambiguous:false,expected:[metadata.id]},
        {alias:bib,existing:saved,ambiguous:true,expected:[metadata.id]},
        {alias:metadata.id,existing:{...saved,metadata:{...metadata,doi:'10.1234/other'}},ambiguous:false,expected:[metadata.id]},
        {alias:'openalex:W1',existing:saved,ambiguous:false,expected:[]},
    ];
    for(const c of cases){
        const repo={findAliases:async()=>[{alias:c.alias,paper_id:ID,ambiguous:c.ambiguous}],paperRows:async()=>[c.existing]};
        assert.deepEqual(await selectAcquired([metadata],session,repo,10),c.expected);
    }
});
test('eligibility finds lifecycle on legitimate DOI upgrade via full bibliographic identity',async()=>{
    const old={...row,metadata:{...metadata,id:'bib:old',doi:null},saved_at:'now'};
    const bib=paperAliases(metadata).find(a=>a.startsWith('bibmeta:'));
    const repo={findAliases:async()=>[{alias:bib,paper_id:ID,ambiguous:false}],paperRows:async()=>[old]};
    assert.deepEqual(await selectAcquired([metadata],session,repo,10),[]);
});
test('eligibility lookup failure after reservation leaves corpus/continuation/lifecycle unchanged',async()=>{
    const {h,state}=protectedHarness();const before=structuredClone(state);
    h.repo.findAliases=async()=>{throw new ResearchError(503,'PERSISTENCE_UNAVAILABLE');};
    const r=await invoke(h.handler,acquire);assert.equal(r.statusCode,503);assert.equal(r.data.acquisitionSaved,undefined);
    assert.deepEqual(state,before);assert.equal(h.receipt.acquisition_status,'pending');assert.equal(h.calls.some(c=>c.name==='complete_research_pull'),false);assert.ok(h.calls.some(c=>c.name==='fail_research_pull'));
});
test('uncertain uncommitted completion preserves protected state and never claims acquisition saved',async()=>{
    const {h,state}=protectedHarness();const before=structuredClone(state);const receiptBefore=structuredClone(h.receipt);const original=h.repo.rpc;
    h.repo.rpc=async(name,args)=>{if(name==='complete_research_pull')throw new ResearchError(503,'PERSISTENCE_UNAVAILABLE',{outcomeUnknown:true});return original(name,args);};
    const r=await invoke(h.handler,acquire);assert.equal(r.statusCode,503);assert.equal(r.data.outcomeUnknown,true);assert.equal(r.data.acquisitionSaved,undefined);
    assert.deepEqual(state,before);assert.deepEqual(h.receipt,receiptBefore);assert.equal(h.calls.some(c=>c.name==='fail_research_pull'),false);
});
test('alias eligibility reads enforce ownership before querying child data',async()=>{
    const urls=[];const repo=createRepository({config,actor:B,fetchImpl:async(url)=>{urls.push(url);return response([]);}});
    await assert.rejects(()=>repo.findAliases(S,[metadata.id]),e=>e.status===404);
    assert.equal(urls.length,1);assert.ok(new URL(urls[0]).pathname.endsWith('/research_sessions'));assert.equal(new URL(urls[0]).searchParams.get('owner_id'),'eq.'+B);
});
test('alias lookup chunks and quotes PostgREST filters without widening session scope',async()=>{
    const urls=[];const keys=Array.from({length:41},(_,i)=>`openalex:W${i}`);keys[0]='source:punctuation,"quoted"\\value';
    const repo=createRepository({config,actor:A,fetchImpl:async(url)=>{
        const u=new URL(url);urls.push(u);if(u.pathname.endsWith('/research_sessions'))return response([session]);return response([]);
    }});
    assert.deepEqual(await repo.findAliases(S,keys),[]);
    const queries=urls.filter(u=>u.pathname.endsWith('/research_paper_aliases'));assert.equal(queries.length,3);
    assert.ok(queries.every(u=>u.searchParams.get('session_id')==='eq.'+S&&u.searchParams.get('select')==='alias,paper_id,ambiguous'));
    assert.ok(queries[0].searchParams.get('alias').includes('\\"quoted\\"\\\\value'));
});
test('relevance tie-breaking is stable while corpus-list cursor order is preserved',async()=>{
    const tie={...row,id:SECOND};assert.deepEqual(rankRows([tie,row],session.retrieval_query).map(p=>p.id),[ID,SECOND]);
    const h=harness();h.repo.listPapers=async()=>[weakRow,row];
    const r=await invoke(h.handler,{action:'papers.list',sessionId:S});assert.deepEqual(r.data.papers.map(p=>p.id),[SECOND,ID]);
});
test('eligibility batches more than forty existing identity candidates without changing read limits',async()=>{
    const keys=Array.from({length:41},(_,i)=>`00000000-0000-4000-8000-${String(i).padStart(12,'0')}`),sizes=[];
    const repo={findAliases:async()=>keys.map(paper_id=>({alias:metadata.id,paper_id,ambiguous:false})),paperRows:async(s,ids)=>{sizes.push(ids.length);return ids.map(id=>({...row,id}));}};
    assert.deepEqual(await selectAcquired([metadata],session,repo,1),[metadata.id]);assert.deepEqual(sizes,[40,1]);
});
test('eligibility keeps complementary abstract evidence when newly retrieved metadata has none',async()=>{
    const seen={...row,last_presented_at:'now',last_presented_revision:1,last_presented_query:'learning'};
    const fresh={...metadata,abstract:null};
    const repo={findAliases:async()=>[{alias:metadata.id,paper_id:ID,ambiguous:false}],paperRows:async()=>[seen]};
    assert.deepEqual(await selectAcquired([fresh],{...session,context_revision:2,retrieval_query:'health outcomes'},repo,1),[metadata.id]);
});
test('stale completion and guarded failure cannot overwrite a newer attempt protected state',async()=>{
    const {h,state}=protectedHarness();const original=h.repo.rpc;
    h.repo.rpc=async(name,args)=>{
        if(name==='complete_research_pull'){
            h.receipt.attempt_no=2;h.receipt.receipt_version=3;
            state.continuation.openalex={cursor:'newer'};state.corpus=[weakRow.metadata];state.lifecycle[SECOND]={saved_at:'now'};
            throw new ResearchError(409,'STALE_ATTEMPT');
        }
        if(name==='fail_research_pull')throw new ResearchError(409,'STALE_ATTEMPT');
        return original(name,args);
    };
    const r=await invoke(h.handler,acquire);assert.equal(r.statusCode,409);assert.equal(r.data.error,'STALE_ATTEMPT');assert.equal(r.data.acquisitionSaved,undefined);
    assert.equal(h.receipt.attempt_no,2);assert.equal(h.receipt.receipt_version,3);assert.deepEqual(state.continuation.openalex,{cursor:'newer'});
    assert.deepEqual(state.corpus,[weakRow.metadata]);assert.deepEqual(state.lifecycle,{[SECOND]:{saved_at:'now'}});assert.equal(state.completions,0);
});
