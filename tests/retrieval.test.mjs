import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeDOI,normalizeOpenAlex,normalizeCrossref,mergePapers,rankPapers,toCSL} from '../lib/retrieval/papers.js';
import {searchPapers,validateSearch} from '../lib/retrieval/search.js';
import {sources} from '../lib/retrieval/sources.js';
const oa={id:'https://openalex.org/W1',doi:'https://doi.org/10.1234/ABC',title:'Learning in schools',publication_year:2020,authorships:[{author:{display_name:'Jane Smith'}}],abstract_inverted_index:{Learning:[0],works:[1]},cited_by_count:10};
const cr={DOI:'10.1234/abc',title:['Learning in schools'],issued:{'date-parts':[[2020]]},author:[{given:'Jane',family:'Smith'}],publisher:'Press',volume:'3',abstract:'<jats:p>Learning &amp; schools</jats:p>',score:99};
const a=()=>normalizeOpenAlex(oa), b=()=>normalizeCrossref(cr);
test('DOI normalization preserves valid suffix punctuation',()=>{assert.equal(normalizeDOI(' DOI:10.1234/AbC '),'10.1234/abc');assert.equal(normalizeDOI('https://dx.doi.org/10.1234%2FAbC'),'10.1234/abc');assert.equal(normalizeDOI('10.1234/a(b)'),'10.1234/a(b)');assert.equal(normalizeDOI('bad'),null);});
test('OpenAlex normalization reconstructs inverted abstracts and preserves IDs',()=>{assert.equal(a().abstract,'Learning works');assert.equal(a().identifiers.openalex,oa.id);assert.equal(a().authors[0].family,'Smith');assert.equal(a().year,2020);});
test('Crossref normalization strips JATS and keeps bibliographic metadata',()=>{assert.equal(b().abstract,'Learning & schools');assert.equal(b().publisher,'Press');assert.equal(b().volume,'3');assert.equal(toCSL(b()).DOI,'10.1234/abc');});
test('DOI duplicate reconciliation retains complementary fields and provenance',()=>{const [p]=mergePapers([a(),b()]);assert.equal(p.provenance.length,2);assert.equal(p.publisher,'Press');assert.equal(p.abstract,'Learning & schools');assert.equal(p.identifiers.openalex,oa.id);assert.equal(p.citedBy,10);assert.equal(p.id,'doi:10.1234/abc');});
test('conservative no-DOI fallback and stable identities',()=>{const x=normalizeOpenAlex({...oa,doi:null}),y=normalizeCrossref({...cr,DOI:null});assert.equal(mergePapers([x,y]).length,1);assert.equal(x.id,y.id);assert.equal(mergePapers([x,y])[0].id,x.id);assert.deepEqual(mergePapers([x,y]),mergePapers([y,x]));});
test('similar titles, years, authors and conflicting DOIs remain distinct',()=>{for(const changes of [{title:['Learning in school']},{issued:{'date-parts':[[2021]]}},{author:[{given:'John',family:'Smith'}]}]){assert.equal(mergePapers([normalizeOpenAlex({...oa,doi:null}),normalizeCrossref({...cr,DOI:null,...changes})]).length,2);}assert.equal(mergePapers([a(),normalizeCrossref({...cr,DOI:'10.1234/other'})]).length,2);});
test('DOI-less record cannot bridge two conflicting DOI records',()=>{assert.equal(mergePapers([a(),normalizeCrossref({...cr,DOI:'10.1234/other'}),normalizeOpenAlex({...oa,doi:null})]).length,3);});
test('relevance outranks citations and ranking is deterministic',()=>{const relevant=a(),popular={...b(),id:'other',title:'Unrelated science',abstract:null,citedBy:100000};assert.equal(rankPapers([popular,relevant],'Learning schools')[0].id,relevant.id);assert.deepEqual(rankPapers([popular,relevant],'Learning schools'),rankPapers([relevant,popular],'Learning schools'));});
const success=papers=>async()=>({papers,total:papers.length,continuation:null});
test('year constraints enforced locally and invalid ranges rejected',async()=>{const r=await searchPapers({query:'learning',yearFrom:2021},{adapters:{openalex:success([a()])}});assert.equal(r.papers.length,0);assert.throws(()=>validateSearch({query:'x',yearFrom:2022,yearTo:2020}));assert.throws(()=>validateSearch({query:'x',yearFrom:'abc'}));});
test('either source may fail without losing the other',async()=>{for(const failed of ['openalex','crossref']){const adapters={openalex:success([a()]),crossref:success([b()])};adapters[failed]=async()=>{throw Error('HTTP 503')};const r=await searchPapers({query:'learning'}, {adapters});assert.equal(r.papers.length,1);assert.equal(r.sourceStatus[failed].status,'error');assert.equal(r.allSourcesFailed,false);}const r=await searchPapers({query:'x'},{adapters:{openalex:async()=>{throw Error('down')},crossref:async()=>{throw Error('down')}}});assert.equal(r.allSourcesFailed,true);});
test('adapters use separate pagination and year filters concurrently',async()=>{const urls=[];let active=0,max=0;const fetchImpl=async url=>{urls.push(url);active++;max=Math.max(max,active);await new Promise(r=>setTimeout(r,5));active--;return {ok:true,json:async()=>url.hostname==='api.openalex.org'?{results:[oa],meta:{count:100,next_cursor:'next'}}:{message:{items:[cr],'total-results':100}}};};const r=await searchPapers({query:'learning',yearFrom:2019,yearTo:2021},{fetchImpl});assert.equal(max,2);assert.equal(r.papers.length,1);assert.equal(r.papers[0].sourceRecords.length,2);assert.deepEqual(r.continuation.sources,{openalex:{cursor:'next'},crossref:{offset:1}});assert.ok(urls[0].searchParams.get('filter').includes('2019-2021'));assert.ok(urls[1].searchParams.get('filter').includes('until-pub-date:2021-12-31'));assert.equal(urls[0].searchParams.get('sort'),null);});

test('fallback preserves meaningful title punctuation and requires full authors',()=>{
    const x=normalizeOpenAlex({...oa,doi:null,title:'Learning with C++'});
    const y=normalizeCrossref({...cr,DOI:null,title:['Learning with C']});
    assert.equal(mergePapers([x,y]).length,2);
    const shortA=normalizeOpenAlex({...oa,doi:null,authorships:[{author:{display_name:'Smith'}}]});
    const shortB=normalizeCrossref({...cr,DOI:null,author:[{family:'Smith'}],URL:'https://example.org/paper'});
    assert.equal(mergePapers([shortA,shortB]).length,2);
});
test('continuation is query-bound, skips exhausted sources and retains failed source state',async()=>{
    const initial=await searchPapers({query:'learning'},{adapters:{openalex:success([a()]),crossref:async()=>{throw Error('down')}}});
    assert.deepEqual(initial.continuation.sources.crossref,{});
    let retried=false;
    const next=await searchPapers({query:'learning',continuation:initial.continuation},{adapters:{openalex:async()=>{throw Error('must not run')},crossref:async()=>{retried=true;return {papers:[b()],total:1,continuation:null}}}});
    assert.equal(retried,true);assert.equal(next.sourceStatus.openalex.returned,0);assert.equal(next.papers.length,1);
    await assert.rejects(()=>searchPapers({query:'different',continuation:initial.continuation}),/Continuation/);
});
test('source relevance ranks support ranking before citation count',()=>{
    const relevant={...a(),id:'first',provenance:[{source:'openalex',rank:1}],citedBy:0};
    const popular={...a(),id:'second',provenance:[{source:'crossref',rank:20}],citedBy:10000};
    assert.equal(rankPapers([popular,relevant],'learning')[0].id,'first');
});

test('DOI URLs exclude query and fragment tracking',()=>{
    assert.equal(normalizeDOI('https://doi.org/10.1234/ABC?utm_source=x#section'),'10.1234/abc');
});
test('duplicate incomplete records retain source-native stable identity',()=>{
    const p=normalizeOpenAlex({id:'https://openalex.org/W2',title:'Incomplete'});
    assert.equal(mergePapers([p,p]).length,1);assert.equal(mergePapers([p,p])[0].id,p.id);
});
test('synchronous adapter errors are isolated too',async()=>{
    const r=await searchPapers({query:'learning'},{adapters:{openalex:success([a()]),crossref:()=>{throw Error('down')}}});
    assert.equal(r.papers.length,1);assert.equal(r.sourceStatus.crossref.status,'error');
});

test('phrase-matched academic title beats superficial overlap despite source rank and citations',()=>{
    const relevant={...a(),id:'phrase',title:'Machine-learning methods for higher education',abstract:null,citedBy:0,provenance:[{source:'openalex',rank:20}]};
    const superficial={...a(),id:'overlap',title:'Higher machine education and learning methods',abstract:null,citedBy:100000,provenance:[{source:'crossref',rank:1}]};
    const query='How can machine learning methods be used in higher education?';
    const ranked=rankPapers([superficial,relevant],query);
    assert.equal(ranked[0].id,'phrase');assert.ok(ranked[0].ranking.titlePhrase>ranked[1].ranking.titlePhrase);
    assert.deepEqual(ranked,rankPapers([relevant,superficial],query));
});
test('ranking normalizes punctuation and hyphenation without changing paper identity',()=>{
    const p={...a(),title:'Machine–learning: higher education',abstract:null};
    assert.equal(rankPapers([p],'machine-learning higher education')[0].ranking.relevance,rankPapers([p],'machine learning higher education')[0].ranking.relevance);
    assert.equal(rankPapers([p],'machine learning')[0].id,p.id);
});
test('title phrase matches outweigh abstract-only matches and negation is retained',()=>{
    const title={...a(),id:'title',title:'Machine learning education',abstract:null};
    const abstract={...a(),id:'abstract',title:'Overview',abstract:'Machine learning education'};
    assert.equal(rankPapers([abstract,title],'machine learning education')[0].id,'title');
    const negative={...a(),id:'negative',title:'Not effective learning',abstract:null};
    const positive={...a(),id:'positive',title:'Effective learning',abstract:null};
    assert.equal(rankPapers([positive,negative],'not effective learning')[0].id,'negative');
});
test('exhausted sources stay exhausted through repeated continuation requests',async()=>{
    const continuation={version:1,query:'learning',yearFrom:null,yearTo:null,sources:{openalex:null,crossref:null}};
    const adapters={openalex:()=>{assert.fail('Exhausted source restarted')},crossref:()=>{assert.fail('Exhausted source restarted')}};
    const first=await searchPapers({query:'learning',continuation},{adapters});
    const second=await searchPapers({query:'learning',continuation:first.continuation},{adapters});
    assert.deepEqual(second.continuation,continuation);assert.equal(second.papers.length,0);
});
test('advanced failed sources retry the exact page without restarting or adapter mutation',async()=>{
    const continuation={version:1,query:'learning',yearFrom:2019,yearTo:2021,sources:{openalex:{cursor:'page-two'},crossref:{offset:20}}};
    const original=structuredClone(continuation), observed=[];
    const failing=Object.fromEntries(['openalex','crossref'].map(name=>[name,({state})=>{observed.push([name,structuredClone(state)]);if(name==='openalex')state.cursor='corrupted';else state.offset=0;throw Error('temporary');}]));
    const failure=await searchPapers({query:'learning',yearFrom:2019,yearTo:2021,continuation},{adapters:failing});
    assert.deepEqual(failure.continuation,original);assert.deepEqual(continuation,original);
    const retry=await searchPapers({query:'learning',yearFrom:2019,yearTo:2021,continuation:failure.continuation},{adapters:{
        openalex:async({state})=>{assert.deepEqual(state,{cursor:'page-two'});return {papers:[a()],total:100,continuation:{cursor:'page-three'}};},
        crossref:async({state})=>{assert.deepEqual(state,{offset:20});return {papers:[b()],total:100,continuation:{offset:40}};}
    }});
    assert.deepEqual(retry.continuation.sources,{openalex:{cursor:'page-three'},crossref:{offset:40}});
    assert.deepEqual(observed,[['openalex',{cursor:'page-two'}],['crossref',{offset:20}]]);
});
test('incomplete, malformed and query/year-mismatched continuation is rejected before retrieval',async()=>{
    const base={version:1,query:'learning',yearFrom:2019,yearTo:2021,sources:{openalex:{cursor:'next'},crossref:{offset:20}}};
    const adapters={openalex:()=>assert.fail('Invalid continuation reached source'),crossref:()=>assert.fail('Invalid continuation reached source')};
    for(const continuation of [false,[],{...base,query:'other'},{...base,yearFrom:2018},{...base,yearTo:2022},{...base,sources:{openalex:null}},{...base,sources:{openalex:{cursor:''},crossref:{offset:20}}},{...base,sources:{openalex:{cursor:'next'},crossref:{offset:-1}}},{...base,sources:{openalex:{cursor:'next'},crossref:{offset:'20'}}}]){
        await assert.rejects(()=>searchPapers({query:'learning',yearFrom:2019,yearTo:2021,continuation},{adapters}),/Continuation|continuation/);
    }
});
test('native adapters resume advanced state and Crossref advances by actual returned rows',async()=>{
    const urls=[];
    const fetchImpl=async url=>{urls.push(url);return {ok:true,json:async()=>url.hostname==='api.openalex.org'?{results:[oa],meta:{count:100,next_cursor:'page-three'}}:{message:{items:[cr],'total-results':100}}};};
    const continuation={version:1,query:'learning',yearFrom:null,yearTo:null,sources:{openalex:{cursor:'page-two'},crossref:{offset:20}}};
    const r=await searchPapers({query:'learning',continuation},{fetchImpl});
    assert.equal(urls.find(u=>u.hostname==='api.openalex.org').searchParams.get('cursor'),'page-two');
    assert.equal(urls.find(u=>u.hostname==='api.crossref.org').searchParams.get('offset'),'20');
    assert.deepEqual(r.continuation.sources,{openalex:{cursor:'page-three'},crossref:{offset:21}});
});
test('repeated upstream cursor is treated as failure and preserves requested page',async()=>{
    const continuation={version:1,query:'learning',yearFrom:null,yearTo:null,sources:{openalex:{cursor:'page-two'},crossref:null}};
    const fetchImpl=async()=>({ok:true,json:async()=>({results:[oa],meta:{next_cursor:'page-two'}})});
    const r=await searchPapers({query:'learning',continuation},{fetchImpl});
    assert.equal(r.sourceStatus.openalex.status,'error');assert.equal(r.papers.length,0);
    assert.deepEqual(r.continuation.sources,continuation.sources);
});
test('source errors never expose thrown messages, stack traces or network details',async()=>{
    const secret='Bearer fake-review-secret at https://user:password@private.invalid/internal';
    const r=await searchPapers({query:'learning'},{adapters:{openalex:success([a()]),crossref:()=>{throw Error(secret)}}});
    assert.deepEqual(r.sourceStatus.crossref,{status:'error',error:'Source temporarily unavailable'});
    assert.ok(!JSON.stringify(r).includes(secret));assert.ok(!JSON.stringify(r).includes('private.invalid'));
});
