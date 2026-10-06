import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import handler from '../api/searchbyidea.js';
const originalFetch=globalThis.fetch;
const oa={id:'https://openalex.org/W1',doi:'https://doi.org/10.1234/test',title:'Learning in schools',publication_year:2020,authorships:[{author:{display_name:'Jane Smith'}}]};
const cr={DOI:'10.1234/test',title:['Learning in schools'],issued:{'date-parts':[[2020]]},author:[{given:'Jane',family:'Smith'}],publisher:'Press'};
async function request(body,method='POST') {
    const res={statusCode:200,status(code){this.statusCode=code;return this;},json(data){this.data=data;return this;}};
    await handler({method,body},res);return res;
}
test('API preserves response contract, stable IDs, style selection and real citeproc formatting',async()=>{
    const urls=[];
    globalThis.fetch=async value=>{
        const url=new URL(value);urls.push(url);
        if(url.hostname==='api.openalex.org') return {ok:true,json:async()=>({results:[oa],meta:{count:100,next_cursor:'next'}})};
        if(url.hostname==='api.crossref.org') return {ok:true,json:async()=>({message:{items:[cr],'total-results':100}})};
        // Exercise the existing formatter's built-in CSL/locale fallback without live network.
        return {ok:false,status:503};
    };
    try {
        const r=await request({idea:'learning',format:'APA'});
        assert.equal(r.statusCode,200);assert.equal(r.data.papers.length,1);
        const p=r.data.papers[0];assert.equal(p.id,'doi:10.1234/test');
        assert.ok(p.formatted.includes('Learning in schools'));assert.ok(p.formatted.includes('Smith'));
        assert.equal(p.formatted,r.data.formatted);assert.deepEqual(p.authors,['Smith, Jane']);
        assert.equal(p.sourceRecords.length,2);assert.equal(p.formattingError,null);
        assert.ok(urls.some(u=>u.pathname.endsWith('/apa.csl')));
        assert.ok(urls.every(u=>['api.openalex.org','api.crossref.org','raw.githubusercontent.com'].includes(u.hostname)));
    } finally {globalThis.fetch=originalFetch;}
});
test('API handles partial failure and both-source failure explicitly',async()=>{
    try {
        globalThis.fetch=async value=>new URL(value).hostname==='api.openalex.org'?{ok:true,json:async()=>({results:[oa],meta:{count:1}})}:{ok:false,status:503};
        const partial=await request({idea:'learning'});assert.equal(partial.statusCode,200);assert.equal(partial.data.sourceStatus.crossref.status,'error');assert.equal(partial.data.papers.length,1);
        globalThis.fetch=async()=>({ok:false,status:503});
        const failed=await request({idea:'learning'});assert.equal(failed.statusCode,502);assert.equal(failed.data.sourceStatus.openalex.status,'error');
    } finally {globalThis.fetch=originalFetch;}
});
test('API rejects malformed requests and mismatched continuation',async()=>{
    assert.equal((await request({},'GET')).statusCode,405);
    for(const body of [{},{idea:42},{idea:'x',yearFrom:2022,yearTo:2020},{idea:'x',continuation:{version:1,query:'different'}}]) assert.equal((await request(body)).statusCode,400);
});
test('frontend loads selected references by stable ID, independent of array position and citation newlines',async()=>{
    const html=await readFile(new URL('../index.html',import.meta.url),'utf8');
    const start=html.indexOf('function loadIdeaReferences(){');
    const end=html.indexOf('\n}',start)+2;
    const input={value:'Existing reference',scrollIntoView(){}};
    let closed=false;
    const context={ideaPapers:[{id:'second',formatted:'Second reference\nwith continuation'},{id:'first',formatted:'First reference'}],document:{querySelectorAll:()=>[{dataset:{paperId:'first'}}],getElementById:id=>id==='referencesInput'?input:{classList:{add(){}},textContent:''}},showOutput(){},closeModal:()=>{closed=true;}};
    vm.createContext(context);vm.runInContext(html.slice(start,end),context);
    context.loadIdeaReferences();assert.equal(input.value,'Existing reference\nFirst reference');assert.equal(closed,true);
});

test('API serializes only safe source errors for partial and total failure',async()=>{
    const sensitive='Bearer fake-review-secret https://user:password@private.invalid/internal\n at internalFunction (/srv/private.js:42)';
    try {
        for(const partial of [true,false]) {
            globalThis.fetch=async value=>{
                if(partial && new URL(value).hostname==='api.openalex.org') return {ok:true,json:async()=>({results:[oa],meta:{count:1}})};
                if(new URL(value).hostname==='raw.githubusercontent.com') return {ok:false,status:503};
                throw Error(sensitive);
            };
            const r=await request({idea:'learning'});
            assert.equal(r.statusCode,partial?200:502);
            assert.deepEqual(r.data.sourceStatus.crossref,{status:'error',error:'Source temporarily unavailable'});
            assert.ok(!JSON.stringify(r.data).includes('private.invalid'));assert.ok(!JSON.stringify(r.data).includes('fake-review-secret'));assert.ok(!JSON.stringify(r.data).includes('internalFunction'));
        }
    } finally {globalThis.fetch=originalFetch;}
});
