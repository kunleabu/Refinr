import { createHash } from 'node:crypto';
import { ResearchError, UUID, sessionActionsEnabled, supabaseConfig, verifyActor } from './auth.js';
import { createRepository, publicSession, publicPull } from './repository.js';
import { searchPapers } from '../retrieval/search.js';
import { sources } from '../retrieval/sources.js';
import { selectPapers, selectAcquired, rankRows, formatRows } from './presentation.js';

const SOURCE_CONFIG = { openalex: 1, crossref: 1 };
const PIPELINE_VERSION = 'phase1-v1';
const FIELDS = {
    'session.create': ['requestId','idea','context','format'],
    'session.list': ['after','limit'], 'session.get': ['sessionId'],
    'session.update': ['sessionId','expectedVersion','patch','format','query','archived'],
    'session.delete': ['sessionId','expectedVersion'],
    'pull.get': ['sessionId','pullId'], 'papers.list': ['sessionId','after','limit','state'],
    'pull.acquire': ['sessionId','requestId','expectedVersion','contextRevision','pullKind','limit'],
    'pull.retry': ['sessionId','pullId','requestId','expectedReceiptVersion','limit'],
    'papers.present': ['sessionId','expectedVersion','contextRevision','paperIds','limit'],
    'paper.update': ['sessionId','paperId','expectedVersion','operation','contextRevision','rejectionScope','reason']
};
export const ACTIONS = Object.freeze(Object.keys(FIELDS));
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const invalid = code => { throw new ResearchError(400, code); };
function uuid(v) { if (typeof v !== 'string' || !UUID.test(v)) invalid('INVALID_ID'); return v.toLowerCase(); }
function version(v, min = 0) { if (!Number.isSafeInteger(v) || v < min) invalid('INVALID_VERSION'); return v; }
function text(v, max = 2000) { if (typeof v !== 'string' || !v.trim() || v.trim().length > max) invalid('INVALID_TEXT'); return v.trim(); }
// Validate complexity before JSON serialization or any recursive request processing.
function boundedJSON(value) {
    const pending = [{ value, depth: 0 }], visited = new Set();
    let nodes = 0;
    while (pending.length) {
        const { value: v, depth } = pending.pop();
        if (++nodes > 10000 || depth > 32) invalid('REQUEST_TOO_COMPLEX');
        if (v !== null && typeof v === 'object') {
            if (visited.has(v)) invalid('INVALID_JSON');
            visited.add(v);
            for (const child of Object.values(v)) pending.push({ value: child, depth: depth + 1 });
        }
    }
    try { if (Buffer.byteLength(JSON.stringify(value)) > 65536) invalid('REQUEST_TOO_LARGE'); }
    catch (err) { if (err instanceof ResearchError) throw err; invalid('INVALID_JSON'); }
}
function identityFields(v) {
    if (!object(v) && !Array.isArray(v)) return;
    for (const [key, value] of Object.entries(v)) {
        if (/^(actor|owner|user)(?:_?id|_?user_?id)?$/i.test(key) || key === 'p_actor') invalid('FORGED_IDENTITY');
        identityFields(value);
    }
}
function year(v) {
    if (v === null || v === '') return null;
    if (!['string','number'].includes(typeof v) || !/^\d+$/.test(String(v)) || Number(v) < 1 || Number(v) > 9999) invalid('INVALID_YEAR');
    return Number(v);
}
function context(v, patch = false) {
    if (!object(v)) invalid('INVALID_CONTEXT');
    const keys = ['topic','yearFrom','yearTo','population','location','selectedAngle','exclusions','extraConstraints'];
    if (Object.keys(v).some(k => !keys.includes(k))) invalid('UNKNOWN_CONTEXT_FIELD');
    const result = { ...v };
    if (!patch || Object.hasOwn(v, 'topic')) result.topic = text(v.topic);
    for (const k of ['yearFrom','yearTo']) if (Object.hasOwn(v, k)) result[k] = year(v[k]);
    if (result.yearFrom && result.yearTo && result.yearFrom > result.yearTo) invalid('INVALID_YEAR_RANGE');
    for (const k of ['population','location']) if (Object.hasOwn(v, k)) {
        if (v[k] !== null && typeof v[k] !== 'string') invalid('INVALID_CONTEXT_TEXT');
        if (v[k]?.length > 2000) invalid('INVALID_CONTEXT_TEXT');
        result[k] = v[k]?.trim() || null;
    }
    if (Object.hasOwn(v, 'selectedAngle') && v.selectedAngle !== null && !object(v.selectedAngle)) invalid('INVALID_ANGLE');
    if (Object.hasOwn(v, 'exclusions') && (!Array.isArray(v.exclusions) || v.exclusions.some(x => typeof x !== 'string' || x.length > 2000))) invalid('INVALID_EXCLUSIONS');
    if (Object.hasOwn(v, 'extraConstraints') && !object(v.extraConstraints)) invalid('INVALID_EXTRA_CONSTRAINTS');
    return patch ? result : { yearFrom: null, yearTo: null, population: null, location: null, selectedAngle: null, exclusions: [], extraConstraints: {}, ...result };
}
export function canonicalHash(value) {
    function sorted(v) { return Array.isArray(v) ? v.map(sorted) : object(v) ? Object.fromEntries(Object.keys(v).sort().map(k => [k, sorted(v[k])])) : v; }
    return createHash('sha256').update(JSON.stringify(sorted(value))).digest('hex');
}
function validate(body) {
    if (!object(body) || !ACTIONS.includes(body.action)) invalid('UNKNOWN_ACTION');
    boundedJSON(body);
    identityFields(body);
    if (Object.keys(body).some(k => k !== 'action' && !FIELDS[body.action].includes(k))) invalid('UNKNOWN_FIELD');
    const b = { ...body };
    for (const k of ['sessionId','pullId','paperId','requestId','after']) if (Object.hasOwn(b, k)) b[k] = uuid(b[k]);
    for (const k of ['expectedVersion','expectedReceiptVersion','contextRevision']) if (Object.hasOwn(b, k)) b[k] = version(b[k], k === 'expectedVersion' ? 0 : 1);
    if (b.action !== 'session.create' && b.action !== 'session.list' && !b.sessionId) invalid('INVALID_ID');
    if (['session.create','pull.acquire','pull.retry'].includes(b.action) && !b.requestId) invalid('INVALID_ID');
    if (['pull.get','pull.retry'].includes(b.action) && !b.pullId || b.action === 'paper.update' && !b.paperId) invalid('INVALID_ID');
    if (['session.update','session.delete','pull.acquire','papers.present','paper.update'].includes(b.action)) version(b.expectedVersion);
    if (b.action === 'pull.retry') version(b.expectedReceiptVersion, 1);
    if (['pull.acquire','papers.present'].includes(b.action)) version(b.contextRevision, 1);
    b.limit ??= ['session.list','papers.list'].includes(b.action) ? 20 : 10;
    if (!Number.isInteger(b.limit) || b.limit < 1 || b.limit > (['session.list','papers.list'].includes(b.action) ? 40 : 10)) invalid('INVALID_LIMIT');
    if (b.action === 'session.create') { b.idea = text(b.idea); b.context = context(b.context ?? { topic: b.idea }); b.format = text(b.format ?? 'Harvard', 512); }
    if (b.action === 'session.update') {
        b.patch = context(b.patch ?? {}, true);
        if (Object.hasOwn(b,'format')) b.format = text(b.format, 512);
        if (Object.hasOwn(b,'query')) b.query = text(b.query);
        if (Object.hasOwn(b,'archived') && typeof b.archived !== 'boolean') invalid('INVALID_ARCHIVED');
    }
    if (b.action === 'pull.acquire') { b.pullKind ??= 'initial'; if (!['initial','additional'].includes(b.pullKind)) invalid('INVALID_PULL_KIND'); }
    if (b.action === 'papers.list' && b.state !== undefined && !['all','saved','cited','rejected','viewed'].includes(b.state)) invalid('INVALID_PAPER_STATE');
    if (b.action === 'papers.present' && b.paperIds !== undefined) {
        if (!Array.isArray(b.paperIds) || b.paperIds.length > 40) invalid('INVALID_PAPER_IDS');
        b.paperIds = b.paperIds.map(uuid);
    }
    if (b.action === 'paper.update') {
        if (!['view','save','unsave','reject','undo_reject','cite','uncite'].includes(b.operation)) invalid('INVALID_PAPER_ACTION');
        if (Object.hasOwn(b,'reason')) b.reason = b.reason === null ? null : text(b.reason);
        if (Object.hasOwn(b,'rejectionScope') && !['context','session'].includes(b.rejectionScope)) invalid('INVALID_REJECTION_SCOPE');
        if (b.operation === 'reject' && (b.rejectionScope ?? 'context') === 'context') version(b.contextRevision, 1);
    }
    return b;
}
function page(rows, limit) {
    const items = rows.slice(0, limit);
    return { items, next: rows.length > limit ? items.at(-1).id : null };
}

export function createResearchHandler(deps = {}) {
    return async function research(req, res) {
        const env = deps.env ?? process.env;
        let signal;
        try {
            if (!ACTIONS.includes(req.body?.action)) throw new ResearchError(400, 'UNKNOWN_ACTION');
            if (!sessionActionsEnabled(env)) throw new ResearchError(503, 'RESEARCH_SESSIONS_DISABLED');
            // Reserve recovery time within Vercel's unchanged 30-second invocation limit.
            signal = deps.workSignal ?? AbortSignal.timeout(23000);
            const persistenceSignal = deps.persistenceSignal ?? AbortSignal.timeout(28000);
            const b = validate(req.body);
            const config = deps.config ?? supabaseConfig(env);
            const actor = await verifyActor(req, { config, fetchImpl: deps.fetchImpl ?? fetch, signal });
            const repo = deps.repositoryFactory ? deps.repositoryFactory({ actor, signal: persistenceSignal, config }) : createRepository({ actor, signal: persistenceSignal, config, fetchImpl: deps.fetchImpl ?? fetch });
            const formatting = { formatter: deps.formatter, signal };
            const reply = (status, value) => res.status(status).json(value);
            switch (b.action) {
            case 'session.create': {
                const intent = { idea: b.idea, context: b.context, format: b.format, query: b.context.topic, sources: SOURCE_CONFIG };
                const r = await repo.rpc('create_research_session', { p_creation_request_id: b.requestId, p_creation_hash: canonicalHash(intent),
                    p_original_idea: b.idea, p_context: b.context, p_style: b.format, p_query: b.context.topic, p_source_config: SOURCE_CONFIG });
                return reply(200, { persisted: true, session: publicSession(r.session) });
            }
            case 'session.list': { const r = page(await repo.listSessions(b), b.limit); return reply(200, { sessions: r.items.map(publicSession), next: r.next }); }
            case 'session.get': return reply(200, { session: publicSession(await repo.getSession(b.sessionId)) });
            case 'session.update': {
                const r = await repo.rpc('update_research_session', { p_session: b.sessionId, p_expected_version: b.expectedVersion, p_patch: b.patch,
                    ...(b.format !== undefined ? { p_style: b.format } : {}), ...(b.query !== undefined ? { p_query: b.query } : {}), ...(b.archived !== undefined ? { p_archived: b.archived } : {}) });
                return reply(200, { persisted: true, session: publicSession(r.session) });
            }
            case 'session.delete': return reply(200, await repo.rpc('delete_research_session', { p_session: b.sessionId, p_expected_version: b.expectedVersion }));
            case 'pull.get': return reply(200, { pull: publicPull(await repo.getPull(b.sessionId, b.pullId)) });
            case 'papers.list': { const r = page(await repo.listPapers(b.sessionId, b), b.limit); const s = await repo.getSession(b.sessionId);
                return reply(200, { ...(await formatRows(r.items, s.citation_style, formatting)), next: r.next }); }
            case 'paper.update': {
                const s = await repo.getSession(b.sessionId);
                const r = await repo.rpc('update_research_paper', { p_session: b.sessionId, p_paper: b.paperId, p_expected_version: b.expectedVersion, p_action: b.operation,
                    ...(b.contextRevision !== undefined ? { p_context_revision: b.contextRevision } : {}), p_rejection_scope: b.rejectionScope ?? 'context', p_reason: b.reason ?? null });
                return reply(200, { persisted: true, ...(await formatRows([r.paper], s.citation_style, formatting)) });
            }
            case 'papers.present': {
                const s = await repo.getSession(b.sessionId);
                const candidates = b.paperIds ? await repo.paperRows(b.sessionId, b.paperIds) : await repo.listPapers(b.sessionId, { limit: 40, state: 'all' });
                const ids = selectPapers(candidates, s, b.limit);
                const r = await repo.rpc('present_research_papers', { p_session: b.sessionId, p_expected_version: b.expectedVersion, p_context_revision: b.contextRevision, p_paper_ids: ids });
                try {
                    return reply(200, { ...r, ...(await formatRows(rankRows(await repo.paperRows(b.sessionId, r.presentedPaperIds), s.retrieval_query), s.citation_style, formatting)) });
                } catch {
                    throw new ResearchError(503, 'PRESENTATION_READ_UNAVAILABLE', { persisted: true, presentationSaved: true });
                }
            }
            default: {
                const result = await acquire(b, repo, { ...deps, signal, persistenceSignal, formatting });
                return reply(result.status, result.body);
            }
            }
        } catch (err) {
            const e = err instanceof ResearchError ? err : new ResearchError(503, 'RESEARCH_OPERATION_UNAVAILABLE');
            return res.status(e.status).json({ error: e.code, ...e.extra });
        }
    };
}

async function receiptResponse(b, repo, receipt, disposition, formatting) {
    const s = await repo.getSession(b.sessionId);
    // An historical stale response remains truthful without offering stale-context discoveries.
    const response = receipt.response_snapshot ?? {};
    const stale = response.needsContextRefresh === true || receipt.context_revision !== s.context_revision;
    const shown = stale ? [] : response.presentedPaperIds ?? [];
    const display = await formatRows(rankRows(await repo.paperRows(b.sessionId, shown), s.retrieval_query).slice(0, b.limit), s.citation_style, formatting);
    const body = { persisted: true, disposition, pull: publicPull(receipt), acquisitionSaved: response.acquisitionSaved === true,
        ...(stale ? { needsContextRefresh: true } : {}), ...display };
    if (stale && response.acquisitionSaved) return { status: 409, body };
    if (receipt.execution_status === 'running') return { status: 202, body };
    const failure = response.error;
    if (failure) {
        const known = ['ATTEMPT_EXPIRED','TIMEOUT','PROCESSING_FAILURE','UPSTREAM_FAILURE','IDENTITY_CONFLICT'].includes(failure) ? failure : 'ACQUISITION_FAILED';
        return { status: known === 'IDENTITY_CONFLICT' ? 409 : known === 'UPSTREAM_FAILURE' ? 502 : 503,
            body: { ...body, error: known, retryable: true } };
    }
    if (receipt.acquisition_status === 'failed') return { status: 502, body: { ...body, acquisitionSaved: false, error: 'All scholarly sources are unavailable', retryable: true } };
    return { status: 200, body };
}
async function acquire(b, repo, deps) {
    let reservation;
    const retry = b.action === 'pull.retry';
    const intent = retry ? { sessionId: b.sessionId, pullId: b.pullId, operation: 'retry', limit: b.limit }
        : { sessionId: b.sessionId, contextRevision: b.contextRevision, pullKind: b.pullKind, limit: b.limit };
    const intentHash = canonicalHash(intent);
    if (!retry) {
        const existing = await repo.findPull(b.sessionId, b.requestId);
        const s = await repo.getSession(b.sessionId);
        if (!existing && s.context_revision !== b.contextRevision && !await repo.findPull(b.sessionId, b.requestId)) throw new ResearchError(409, 'STALE_CONTEXT');
    }
    try {
        reservation = await repo.rpc(retry ? 'retry_failed_research_sources' : 'begin_research_pull', retry
            ? { p_session: b.sessionId, p_pull: b.pullId, p_expected_receipt_version: b.expectedReceiptVersion, p_retry_request_id: b.requestId, p_retry_hash: intentHash }
            : { p_session: b.sessionId, p_expected_version: b.expectedVersion, p_request_id: b.requestId, p_request_hash: intentHash, p_pull_kind: b.pullKind, p_intent: intent, p_pipeline_version: PIPELINE_VERSION });
    } catch (err) {
        if (!(err instanceof ResearchError) || !err.extra.outcomeUnknown) throw err;
        // Never retrieve when reservation acknowledgement (and private token) was lost.
        try {
            const r = retry ? await repo.getPull(b.sessionId, b.pullId) : await repo.findPull(b.sessionId, b.requestId);
            const savedHash = retry ? r?.attempt_requests?.[b.requestId] : r?.request_hash;
            if (r && savedHash === intentHash) return await savedResponse(b, repo, r, r.execution_status === 'running' ? 'in_progress' : 'replay', deps.formatting);
            if (r && savedHash) throw new ResearchError(409, 'IDEMPOTENCY_KEY_REUSED');
        } catch (readError) { if (readError instanceof ResearchError && (readError.status === 409 || readError.extra.persisted)) throw readError; }
        throw new ResearchError(503, 'PERSISTENCE_UNAVAILABLE', { outcomeUnknown: true });
    }
    if (reservation.disposition !== 'execute') {
        return await savedResponse(b, repo, await repo.getPull(b.sessionId, reservation.pullId), reservation.disposition, deps.formatting);
    }
    const base = { p_session: b.sessionId, p_pull: reservation.pullId, p_attempt_token: reservation.attemptToken, p_expected_receipt_version: reservation.receiptVersion };
    let result, resultHash;
    try {
        if (deps.signal.aborted) throw new ResearchError(503, 'RESEARCH_DEADLINE_EXCEEDED');
        const names = Object.keys(reservation.attemptSources);
        if (names.some(name => !Object.hasOwn(sources, name) || reservation.sourceConfig?.[name] !== SOURCE_CONFIG[name])) throw new ResearchError(409, 'UNSUPPORTED_SOURCE_VERSION');
        const adapters = Object.fromEntries(names.map(name => [name, sources[name]]));
        const fetchImpl = async (url, options = {}) => (deps.sourceFetch ?? fetch)(url, { ...options,
            signal: AbortSignal.any([deps.signal, ...(options.signal ? [options.signal] : [])]) });
        result = await (deps.search ?? searchPapers)({ query: reservation.query, yearFrom: reservation.yearFrom, yearTo: reservation.yearTo,
            continuation: { version: 1, query: reservation.query, yearFrom: reservation.yearFrom, yearTo: reservation.yearTo, sources: reservation.attemptSources } }, { adapters, fetchImpl });
        if (deps.persistenceSignal.aborted || (deps.signal.aborted && !Object.values(result.sourceStatus).some(s => s.status === 'ok'))) throw new ResearchError(503, 'RESEARCH_DEADLINE_EXCEEDED');
        if (result.papers.length > 40 || Buffer.byteLength(JSON.stringify(result.papers)) > 2_000_000) throw new ResearchError(503, 'ACQUISITION_BATCH_TOO_LARGE');
        const outcomes = Object.fromEntries(names.map(name => [name, result.sourceStatus[name].status === 'error' ? { status: 'error' }
            : { status: 'ok', returned: result.sourceStatus[name].returned, total: result.sourceStatus[name].total, continuation: result.continuation.sources[name] }]));
        const selected = await selectAcquired(result.papers, await repo.getSession(b.sessionId), repo, b.limit);
        resultHash = canonicalHash({ sourceResults: outcomes, papers: result.papers, presentAliases: selected });
        await repo.rpc('complete_research_pull', { ...base, p_result_hash: resultHash, p_source_results: outcomes, p_papers: result.papers, p_present_aliases: selected });
    } catch (err) {
        const uncertain = err instanceof ResearchError && err.extra.outcomeUnknown;
        if (uncertain) {
            try {
                const receipt = await repo.getPull(b.sessionId, reservation.pullId);
                if (resultHash && receipt.attempt_result_hash === resultHash) return await savedResponse(b, repo, receipt, 'committed', deps.formatting);
            } catch (readError) { if (readError instanceof ResearchError && readError.extra.persisted) throw readError; /* An unavailable read cannot establish rollback. */ }
            throw new ResearchError(503, 'PERSISTENCE_UNAVAILABLE', { outcomeUnknown: true, pullId: reservation.pullId });
        }
        // A confirmed rejection rolls back completion. Mark failure separately, never overwrite a newer/committed attempt.
        const failureCode = err instanceof ResearchError && err.code === 'IDENTITY_CONFLICT' ? 'IDENTITY_CONFLICT' : deps.signal.aborted ? 'TIMEOUT' : 'PROCESSING_FAILURE';
        try {
            await repo.rpc('fail_research_pull', { ...base, p_result_hash: canonicalHash({ failureCode }), p_failure_code: failureCode });
        } catch { /* Lease expiry remains the recovery mechanism. */ }
        if (err instanceof ResearchError) throw err;
        throw new ResearchError(503, 'ACQUISITION_PROCESSING_FAILED', { pullId: reservation.pullId });
    }
    // Read failure here must not mark an already committed acquisition failed.
    try {
        return await savedResponse(b, repo, await repo.getPull(b.sessionId, reservation.pullId), 'committed', deps.formatting);
    } catch {
        throw savedReadError(reservation.pullId, true);
    }
}

function savedReadError(pullId, acquisitionSaved) {
    return new ResearchError(503, 'PERSISTENCE_RESPONSE_UNAVAILABLE', { persisted: true, acquisitionSaved, outcomeUnknown: false, pullId });
}
async function savedResponse(b, repo, receipt, disposition, formatting) {
    try { return await receiptResponse(b, repo, receipt, disposition, formatting); }
    catch { throw savedReadError(receipt.id, receipt.response_snapshot?.acquisitionSaved === true); }
}
