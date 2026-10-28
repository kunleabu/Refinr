import { ResearchError, UUID } from './auth.js';

const SESSION_FIELDS = 'id,original_idea,current_topic,year_from,year_to,population,location,selected_angle,exclusions,extra_constraints,citation_style,retrieval_query,source_config,context_revision,row_version,continuation,archived_at,created_at,updated_at';
const PAPER_FIELDS = 'id,session_id,canonical_key,metadata_version,metadata,first_retrieval_id,last_retrieval_id,first_discovered_at,last_discovered_at,last_presented_at,last_presented_revision,last_presented_query,first_viewed_at,last_viewed_at,saved_at,rejected_at,rejection_scope,rejected_revision,rejection_reason,cited_at,merged_into_id,row_version';
const PULL_FIELDS = 'id,session_id,request_id,request_hash,intent_snapshot,pull_kind,context_revision,acquisition_status,execution_status,receipt_version,attempt_no,attempt_request_id,attempt_requests,attempt_result_hash,attempt_result_snapshot,acquired_paper_ids,input_continuation,output_continuation,source_progress,response_snapshot';
const RPCS = new Set(['create_research_session','update_research_session','delete_research_session','begin_research_pull','retry_failed_research_sources','complete_research_pull','fail_research_pull','present_research_papers','update_research_paper']);
const SAFE_CODES = new Set(`AUTH_REQUIRED SESSION_NOT_FOUND PULL_NOT_FOUND PAPER_NOT_FOUND STALE_VERSION STALE_PAPER STALE_CONTEXT STALE_RECEIPT STALE_ATTEMPT IDEMPOTENCY_KEY_REUSED RESULT_KEY_REUSED PULL_IN_PROGRESS SESSION_ARCHIVED SOURCES_EXHAUSTED PAPER_ID_MERGED IDENTITY_CONFLICT INVALID_SESSION INVALID_QUERY INVALID_CONTEXT INVALID_TOPIC INVALID_YEAR INVALID_YEAR_RANGE INVALID_CONTEXT_TEXT UNKNOWN_CONTEXT_FIELD INVALID_ANGLE INVALID_EXCLUSIONS INVALID_EXTRA_CONSTRAINTS INVALID_PATCH INVALID_QUERY_OR_STYLE INVALID_SOURCES INVALID_SOURCE_VERSION INVALID_PULL INVALID_RETRY INVALID_PAPER_ACTION INVALID_REJECTION_SCOPE`.split(' '));
export function publicSession(row) {
    return Object.fromEntries(SESSION_FIELDS.split(',').filter(k => Object.hasOwn(row, k)).map(k => [k, row[k]]));
}
export function publicPull(row) {
    return { id: row.id, sessionId: row.session_id, requestId: row.request_id, pullKind: row.pull_kind,
        contextRevision: row.context_revision, receiptVersion: row.receipt_version, attemptNo: row.attempt_no,
        executionStatus: row.execution_status, acquisitionStatus: row.acquisition_status,
        acquiredPaperIds: row.acquired_paper_ids, continuation: row.output_continuation, sourceStatus: row.source_progress };
}
export function createRepository({ config, actor, fetchImpl = fetch, signal }) {
    if (!UUID.test(actor || '')) throw new ResearchError(401, 'AUTH_REQUIRED');
    async function transport(path, { method = 'GET', body } = {}) {
        let response;
        try {
            response = await fetchImpl(`${config.url}/rest/v1/${path}`, { method, redirect: 'error',
                headers: { apikey: config.serviceKey, Authorization: `Bearer ${config.serviceKey}`, 'Content-Type': 'application/json' },
                ...(body ? { body: JSON.stringify(body) } : {}),
                signal: AbortSignal.any([AbortSignal.timeout(4000), ...(signal ? [signal] : [])]) });
        } catch { throw new ResearchError(503, 'PERSISTENCE_UNAVAILABLE', { outcomeUnknown: method === 'POST' }); }
        let data;
        try { data = await response.json(); } catch { throw new ResearchError(503, 'PERSISTENCE_UNAVAILABLE', { outcomeUnknown: method === 'POST' }); }
        if (!response.ok) {
            const status = { PT400: 400, PT401: 401, PT404: 404, PT409: 409 }[data?.code];
            if (status && SAFE_CODES.has(data.message)) throw new ResearchError(status, data.message);
            throw new ResearchError(503, 'PERSISTENCE_UNAVAILABLE', { outcomeUnknown: method === 'POST' && response.status >= 500 });
        }
        return data;
    }
    const query = (table, params) => transport(`${table}?${new URLSearchParams(params)}`);
    async function getSession(id) {
        if (!UUID.test(id || '')) throw new ResearchError(400, 'INVALID_ID');
        const rows = await query('research_sessions', { select: SESSION_FIELDS, id: `eq.${id}`, owner_id: `eq.${actor}`, limit: '1' });
        if (!rows.length) throw new ResearchError(404, 'SESSION_NOT_FOUND');
        return rows[0];
    }
    async function getPull(sessionId, pullId) {
        if (!UUID.test(pullId || '')) throw new ResearchError(400, 'INVALID_ID');
        await getSession(sessionId);
        const rows = await query('research_retrievals', { select: PULL_FIELDS, session_id: `eq.${sessionId}`, id: `eq.${pullId}`, limit: '1' });
        if (!rows.length) throw new ResearchError(404, 'PULL_NOT_FOUND');
        return rows[0];
    }
    async function findPull(sessionId, requestId) {
        if (!UUID.test(requestId || '')) throw new ResearchError(400, 'INVALID_ID');
        await getSession(sessionId);
        const rows = await query('research_retrievals', { select: PULL_FIELDS, session_id: `eq.${sessionId}`, request_id: `eq.${requestId}`, limit: '1' });
        return rows[0] || null;
    }
    async function listSessions({ after, limit }) {
        return query('research_sessions', { select: SESSION_FIELDS, owner_id: `eq.${actor}`, order: 'id.asc', limit: String(limit + 1), ...(after ? { id: `gt.${after}` } : {}) });
    }
    async function listPapers(sessionId, { after, limit, state = 'all' }) {
        await getSession(sessionId);
        const filters = { all: {}, saved: { saved_at: 'not.is.null' }, cited: { cited_at: 'not.is.null' }, rejected: { rejected_at: 'not.is.null' }, viewed: { first_viewed_at: 'not.is.null' } };
        if (!Object.hasOwn(filters, state)) throw new ResearchError(400, 'INVALID_PAPER_STATE');
        return query('research_session_papers', { select: PAPER_FIELDS, session_id: `eq.${sessionId}`, merged_into_id: 'is.null', order: 'id.asc', limit: String(limit + 1), ...filters[state], ...(after ? { id: `gt.${after}` } : {}) });
    }
    async function paperRows(sessionId, ids) {
        await getSession(sessionId);
        if (!ids.length) return [];
        if (ids.length > 40 || ids.some(id => !UUID.test(id))) throw new ResearchError(400, 'INVALID_PAPER_IDS');
        const rows = await query('research_session_papers', { select: PAPER_FIELDS, session_id: `eq.${sessionId}`, id: `in.(${ids.join(',')})`, limit: '40' });
        const roots = [];
        for (const original of rows) {
            let row = original; const visited = new Set();
            while (row.merged_into_id) {
                if (visited.has(row.id)) throw new ResearchError(409, 'IDENTITY_CONFLICT');
                visited.add(row.id);
                const next = await query('research_session_papers', { select: PAPER_FIELDS, session_id: `eq.${sessionId}`, id: `eq.${row.merged_into_id}`, limit: '1' });
                if (!next.length) throw new ResearchError(404, 'PAPER_NOT_FOUND');
                row = next[0];
            }
            if (!roots.some(p => p.id === row.id)) roots.push(row);
        }
        if (rows.length !== new Set(ids).size) throw new ResearchError(404, 'PAPER_NOT_FOUND');
        return roots;
    }
    async function findAliases(sessionId, aliases) {
        await getSession(sessionId);
        const requests = [];
        // Bound each URL; all aliases originate in the validated canonical source batch.
        for (let i = 0; i < aliases.length; i += 20) {
            const quoted = aliases.slice(i, i + 20).map(a => '"' + a.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"');
            requests.push(query('research_paper_aliases', { select: 'alias,paper_id,ambiguous', session_id: `eq.${sessionId}`, alias: `in.(${quoted.join(',')})`, limit: '20' }));
        }
        return (await Promise.all(requests)).flat();
    }
    async function rpc(name, args) {
        if (!RPCS.has(name)) throw new ResearchError(400, 'INVALID_OPERATION');
        // Even trusted callers cannot accidentally override the verified actor.
        return transport(`rpc/${name}`, { method: 'POST', body: { ...args, p_actor: actor } });
    }
    return { getSession, getPull, findPull, listSessions, listPapers, paperRows, findAliases, rpc };
}
