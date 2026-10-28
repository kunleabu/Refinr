import test from 'node:test';
import assert from 'node:assert/strict';
import { extractMetadata } from '../lib/metadata.js';
import auth from '../api/auth.js';
import clean from '../api/clean.js';
import lookup from '../api/lookup.js';
const response=()=>({status(code){this.code=code;return this;},json(body){this.body=body;return this;}});
test('Lookup → Clean preserves every supplied author, title and pages without verification',async()=>{
 const originalFetch=global.fetch;
 const authors='Anderson Brown Clark Davis Evans Foster Green Harris Irving Jones King Lewis Miller Nelson Owens Parker Quinn Roberts Smith Turner Underwood Vincent White Young'.split(' ').map(family=>({family,given:'J.'}));
 const requests=[];
 // Exercise real Lookup, formatter and Clean with deterministic CSL fallback assets.
 global.fetch=async url=>{requests.push(String(url));if(String(url).includes('api.crossref.org'))return {ok:true,json:async()=>({message:{author:authors,issued:{'date-parts':[[2020]]},title:['A study of research quality'],'container-title':['Nature'],volume:'12',issue:'3',page:'123-145',DOI:'10.1234/fixture'}})};throw Error('Offline CSL assets');};
 try{
  const found=response();await lookup({method:'POST',headers:{},body:{action:'identifiers',identifiers:'10.1234/fixture',format:'Harvard'}},found);
  assert.equal(found.code,200);const supplied=found.body.results[0].replace(/^✅\s*/,'');
  const metadata=extractMetadata(supplied).cslJson;
  assert.deepEqual(metadata.author,authors);assert.equal(metadata.page,'123-145');assert.equal(metadata.title,'A study of research quality');assert.equal(metadata.volume,'12');assert.equal(metadata.issue,'3');
  requests.length=0;
  const result=response();await clean({method:'POST',headers:{},body:{references:supplied,format:'Harvard'}},result);
  assert.equal(result.code,200);for(const author of authors)assert.ok(result.body.result.includes(author.family),author.family);
  assert.match(result.body.result,/123[–-]145/);assert.ok(!requests.some(url=>/crossref|openalex/.test(url)),'Clean does not verify supplied references');
 }finally{global.fetch=originalFetch;}
});
test('Metadata retains spaced page ranges and full author sections',()=>{
 const item=extractMetadata('Smith, J. and Jones, M. (2020) ‘A study of research quality’. Nature, 12, (3), pp. 123 – 145.').cslJson;
 assert.equal(item.author.length,2);assert.equal(item.page,'123-145');assert.equal(item.issue,'3');assert.equal(item.volume,'12');
});
for(const action of ['signin','profile'])for(const scenario of ['failure','missing','zero'])test(`${action}: authoritative credits ${scenario}`,async()=>{
 const originalFetch=global.fetch;
 global.fetch=async url=>String(url).includes('/profiles')?{ok:scenario!=='failure',json:async()=>scenario==='failure'?{error:'unavailable'}:scenario==='missing'?[]:[{credits:0}]}:{ok:true,json:async()=>({id:'user',email:'reader@example.test',user:{id:'user',email:'reader@example.test'},access_token:'token'})};
 try{const result=response();await auth({method:'POST',headers:{authorization:'Bearer token'},body:{action,email:'reader@example.test',password:'fixture'}},result);assert.equal(result.code,200);assert.equal(result.body.user.credits,scenario==='zero'?0:null);}finally{global.fetch=originalFetch;}
});
for(const scenario of ['failure','missing','zero'])test(`Google profile ${scenario} never invents a balance`,async()=>{
 const originalFetch=global.fetch;const writes=[];
 global.fetch=async(url,options={})=>{
  if(String(url).includes('/auth/v1/user'))return {ok:true,json:async()=>({id:'user',email:'reader@example.test'})};
  if(options.method==='POST'){writes.push(options);return {ok:false,json:async()=>({error:'creation failed'})};}
  return {ok:scenario!=='failure',json:async()=>scenario==='failure'?{error:'unavailable'}:scenario==='missing'?[]:[{credits:0}]};
 };
 try{const result=response();await auth({method:'POST',headers:{},body:{action:'signin',provider:'google',access_token:'fixture'}},result);assert.equal(result.code,200);assert.equal(result.body.user.credits,scenario==='zero'?0:null);assert.equal(writes.length,scenario==='missing'?1:0);}finally{global.fetch=originalFetch;}
});

test('Mixed full names, Unicode surnames and long initials are preserved',()=>{const item=extractMetadata('García, María and Smith, J. A. B. C. (2020) A study of research quality. Nature, 12(3), 123–145.').cslJson;assert.deepEqual(item.author,[{family:'García',given:'María'},{family:'Smith',given:'J.A.B.C.'}]);});
