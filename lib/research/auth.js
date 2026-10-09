// Research actions only. Legacy requests keep their existing authentication flow.
export class ResearchError extends Error {
    constructor(status, code, extra = {}) {
        super(code); this.status = status; this.code = code; this.extra = extra;
    }
}
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function supabaseConfig(env = process.env) {
    try {
        const url = new URL(env.SUPABASE_URL);
        if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !/^[a-z]{20}\.supabase\.co$/.test(url.hostname)) throw Error();
        if (env.SUPABASE_PROJECT_ID && url.hostname !== `${env.SUPABASE_PROJECT_ID}.supabase.co`) throw Error();
        if (!env.SUPABASE_ANON_KEY || !env.SUPABASE_SERVICE_KEY) throw Error();
        return { url: url.origin, anonKey: env.SUPABASE_ANON_KEY, serviceKey: env.SUPABASE_SERVICE_KEY };
    } catch { throw new ResearchError(503, 'RESEARCH_CONFIGURATION_UNAVAILABLE'); }
}
export function sessionActionsEnabled(env = process.env) {
    return env.SEARCH_BY_IDEA_SESSIONS_ENABLED === 'true' && env.VERCEL_ENV !== 'production'
        && !(env.NODE_ENV === 'production' && !env.VERCEL_ENV);
}
export async function verifyActor(req, { config, fetchImpl = fetch, signal } = {}) {
    const header = req.headers?.authorization;
    const match = typeof header === 'string' && /^Bearer ([^\s]+)$/i.exec(header);
    if (!match) throw new ResearchError(401, 'AUTH_REQUIRED');
    let response;
    try {
        response = await fetchImpl(`${config.url}/auth/v1/user`, { redirect: 'error',
            headers: { Authorization: `Bearer ${match[1]}`, apikey: config.anonKey },
            signal: AbortSignal.any([AbortSignal.timeout(4000), ...(signal ? [signal] : [])]) });
    } catch { throw new ResearchError(503, 'AUTH_UNAVAILABLE'); }
    if (response.status === 401 || response.status === 403) throw new ResearchError(401, 'INVALID_AUTHENTICATION');
    if (!response.ok) throw new ResearchError(503, 'AUTH_UNAVAILABLE');
    let user;
    try { user = await response.json(); } catch { throw new ResearchError(503, 'AUTH_UNAVAILABLE'); }
    if (!UUID.test(user?.id || '')) throw new ResearchError(401, 'INVALID_AUTHENTICATION');
    return user.id.toLowerCase();
}
