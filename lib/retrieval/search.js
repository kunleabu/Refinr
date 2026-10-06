import { sources } from './sources.js';
import { mergePapers, rankPapers } from './papers.js';
export function validateSearch({ query, yearFrom, yearTo, continuation }) {
    if(typeof query !== 'string' || !query.trim()) throw new TypeError('Missing research idea or topic');
    if(query.length > 2000) throw new TypeError('Research idea is too long');
    function year(v) {
        if(v === undefined || v === null || v === '') return null;
        if (typeof v !== 'string' && typeof v !== 'number') throw new TypeError('Invalid year constraint');
        const n=Number(v); if(!Number.isInteger(n) || n<1 || n>9999) throw new TypeError('Invalid year constraint'); return n;
    }
    const from=year(yearFrom),to=year(yearTo);
    if(from && to && from>to) throw new TypeError('Year range is reversed');
    if (continuation && (continuation.version !== 1 || continuation.query !== query.trim() || continuation.yearFrom !== from || continuation.yearTo !== to || !continuation.sources || typeof continuation.sources !== 'object')) throw new TypeError('Continuation does not match this search');
    return {query:query.trim(),yearFrom:from,yearTo:to};
}
export async function searchPapers(options, { adapters=sources, fetchImpl=fetch }={}) {
    const constraints=validateSearch(options);
    const pageSize=20;
    const names=Object.keys(adapters);
    const results=await Promise.allSettled(names.map(name => Promise.resolve().then(() => options.continuation && options.continuation.sources?.[name] === null ? Promise.resolve({papers:[],total:null,continuation:null}) : adapters[name]({...constraints,pageSize,state:options.continuation?.sources?.[name],fetchImpl}))));
    const statuses={}, continuation={}, records=[];
    results.forEach((result,i) => {
        const name=names[i];
        if(result.status==='fulfilled') {
            statuses[name]={status:'ok',total:result.value.total,returned:result.value.papers.length};
            continuation[name]=result.value.continuation;
            records.push(...result.value.papers.map((p, index) => {
                const record = { ...p, provenance: p.provenance.map(s => ({ ...s, rank: index + 1 })) };
                return { ...record, sourceRecords: [structuredClone(record)] };
            }));
        } else { statuses[name]={status:'error',error:result.reason?.message || 'Source unavailable'}; continuation[name]=options.continuation?.sources?.[name] || {}; }
    });
    const filtered=records.filter(p => (!constraints.yearFrom || p.year && p.year>=constraints.yearFrom) && (!constraints.yearTo || p.year && p.year<=constraints.yearTo));
    const merged=mergePapers(filtered);
    const papers=rankPapers(merged,constraints.query);
    return {papers,sourceStatus:statuses,continuation:{version:1,query:constraints.query,yearFrom:constraints.yearFrom,yearTo:constraints.yearTo,sources:continuation},
        total:papers.length,totalIsExact:false,allSourcesFailed:results.every(r=>r.status==='rejected')};
}
