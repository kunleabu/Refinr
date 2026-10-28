import { validateContinuation, validateSourceState } from './continuation.js';
import { sources } from './sources.js';
import { mergePapers, rankPapers } from './papers.js';
export function validateSearch({ query, yearFrom, yearTo, continuation }, sourceNames = Object.keys(sources)) {
    if(typeof query !== 'string' || !query.trim()) throw new TypeError('Missing research idea or topic');
    if(query.length > 2000) throw new TypeError('Research idea is too long');
    function year(v) {
        if(v === undefined || v === null || v === '') return null;
        if (typeof v !== 'string' && typeof v !== 'number') throw new TypeError('Invalid year constraint');
        const n=Number(v); if(!Number.isInteger(n) || n<1 || n>9999) throw new TypeError('Invalid year constraint'); return n;
    }
    const from=year(yearFrom),to=year(yearTo);
    if(from && to && from>to) throw new TypeError('Year range is reversed');
    const constraints = {query:query.trim(),yearFrom:from,yearTo:to};
    validateContinuation(continuation, constraints, sourceNames);
    return constraints;
}
export async function searchPapers(options, { adapters=sources, fetchImpl=fetch }={}) {
    const names=Object.keys(adapters);
    const constraints=validateSearch(options, names);
    const pageSize=20;
    const states = Object.fromEntries(names.map(name => [name, options.continuation ? structuredClone(options.continuation.sources[name]) : {}]));
    const results=await Promise.allSettled(names.map(async name => {
        if (states[name] === null) return {papers:[],total:null,continuation:null};
        // Adapters receive copies: an adapter mutation cannot corrupt retry state.
        const result = await adapters[name]({...constraints,pageSize,state:structuredClone(states[name]),fetchImpl});
        validateSourceState(name, result.continuation);
        return result;
    }));
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
        } else { statuses[name]={status:'error',error:'Source temporarily unavailable'}; continuation[name]=structuredClone(states[name]); }
    });
    const filtered=records.filter(p => (!constraints.yearFrom || p.year && p.year>=constraints.yearFrom) && (!constraints.yearTo || p.year && p.year<=constraints.yearTo));
    const merged=mergePapers(filtered);
    const papers=rankPapers(merged,constraints.query);
    return {papers,sourceStatus:statuses,continuation:{version:1,query:constraints.query,yearFrom:constraints.yearFrom,yearTo:constraints.yearTo,sources:continuation},
        total:papers.length,totalIsExact:false,allSourcesFailed:results.every(r=>r.status==='rejected')};
}
