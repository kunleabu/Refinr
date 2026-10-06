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
test('adapters use separate pagination and year filters concurrently',async()=>{const urls=[];let active=0,max=0;const fetchImpl=async url=>{urls.push(url);active++;max=Math.max(max,active);await new Promise(r=>setTimeout(r,5));active--;return {ok:true,json:async()=>url.hostname==='api.openalex.org'?{results:[oa],meta:{count:100,next_cursor:'next'}}:{message:{items:[cr],'total-results':100}}};};const r=await searchPapers({query:'learning',yearFrom:2019,yearTo:2021},{fetchImpl});assert.equal(max,2);assert.equal(r.papers.length,1);assert.equal(r.papers[0].sourceRecords.length,2);assert.deepEqual(r.continuation.sources,{openalex:{cursor:'next'},crossref:{offset:20}});assert.ok(urls[0].searchParams.get('filter').includes('2019-2021'));assert.ok(urls[1].searchParams.get('filter').includes('until-pub-date:2021-12-31'));assert.equal(urls[0].searchParams.get('sort'),null);});

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
