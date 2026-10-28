-- REVIEW PROPOSAL ONLY. NOT EXECUTED. PostgreSQL/Supabase.
-- Four new research tables. No existing objects, credits, or triggers are altered.
-- Backend derives p_actor from a verified Supabase bearer token; never from body user_id.
-- All functions are SECURITY INVOKER, search_path=pg_catalog, service_role-only.
-- A retrieval row is ONE LOGICAL PULL. Attempts and presentation pages are not new pulls.
-- Lease policy: 45s from DB reservation = <=30s invocation + 15s completion/cancellation margin.
-- It is a recovery threshold, not an extension of Vercel runtime. No heartbeat/renewal.
-- Keep both reservation/retry durations equal. Session locks serialize takeover/completion;
-- orchestration must bound DB statements/batches and external calls to its remaining deadline.
BEGIN;
SET LOCAL search_path = pg_catalog;

CREATE TABLE public.research_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  creation_request_id uuid NOT NULL,
  creation_hash text NOT NULL CHECK (creation_hash ~ '^[0-9a-f]{64}$'),
  creation_snapshot jsonb NOT NULL CHECK (jsonb_typeof(creation_snapshot) = 'object'),
  original_idea text NOT NULL CHECK (length(btrim(original_idea)) BETWEEN 1 AND 2000),
  current_topic text NOT NULL CHECK (length(btrim(current_topic)) BETWEEN 1 AND 2000),
  year_from integer CHECK (year_from BETWEEN 1 AND 9999),
  year_to integer CHECK (year_to BETWEEN 1 AND 9999),
  population text,
  location text,
  selected_angle jsonb CHECK (selected_angle IS NULL OR jsonb_typeof(selected_angle) = 'object'),
  exclusions jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(exclusions) = 'array'),
  extra_constraints jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(extra_constraints) = 'object'),
  citation_style text NOT NULL DEFAULT 'Harvard' CHECK (length(btrim(citation_style)) BETWEEN 1 AND 512),
  retrieval_query text NOT NULL CHECK (length(btrim(retrieval_query)) BETWEEN 1 AND 2000),
  source_config jsonb NOT NULL CHECK (jsonb_typeof(source_config) = 'object' AND source_config <> '{}'::jsonb),
  context_revision integer NOT NULL DEFAULT 1 CHECK (context_revision > 0),
  row_version bigint NOT NULL DEFAULT 0 CHECK (row_version >= 0),
  continuation jsonb CHECK (continuation IS NULL OR jsonb_typeof(continuation) = 'object'),
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (owner_id, creation_request_id),
  CHECK (year_from IS NULL OR year_to IS NULL OR year_from <= year_to)
);

CREATE TABLE public.research_retrievals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), -- future financial entitlement identity
  session_id uuid NOT NULL REFERENCES public.research_sessions(id) ON DELETE CASCADE,
  request_id uuid NOT NULL,
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  intent_snapshot jsonb NOT NULL CHECK (jsonb_typeof(intent_snapshot) = 'object'),
  pull_kind text NOT NULL CHECK (pull_kind IN ('initial','additional')), -- classification only; NO billing
  context_revision integer NOT NULL CHECK (context_revision > 0),
  context_snapshot jsonb NOT NULL CHECK (jsonb_typeof(context_snapshot) = 'object'),
  retrieval_query text NOT NULL CHECK (length(btrim(retrieval_query)) BETWEEN 1 AND 2000),
  year_from integer CHECK (year_from BETWEEN 1 AND 9999),
  year_to integer CHECK (year_to BETWEEN 1 AND 9999),
  source_config jsonb NOT NULL CHECK (jsonb_typeof(source_config) = 'object' AND source_config <> '{}'::jsonb),
  pipeline_version text NOT NULL CHECK (length(btrim(pipeline_version)) BETWEEN 1 AND 128),
  input_continuation jsonb NOT NULL CHECK (jsonb_typeof(input_continuation) = 'object'),
  output_continuation jsonb NOT NULL CHECK (jsonb_typeof(output_continuation) = 'object'),
  source_progress jsonb NOT NULL CHECK (jsonb_typeof(source_progress) = 'object'),
  acquisition_status text NOT NULL DEFAULT 'pending' CHECK (acquisition_status IN ('pending','partial','complete','failed')),
  execution_status text NOT NULL CHECK (execution_status IN ('running','idle')),
  receipt_version bigint NOT NULL DEFAULT 1 CHECK (receipt_version > 0),
  attempt_no integer NOT NULL DEFAULT 1 CHECK (attempt_no > 0),
  attempt_token uuid NOT NULL,
  attempt_request_id uuid NOT NULL,
  attempt_requests jsonb NOT NULL CHECK (jsonb_typeof(attempt_requests) = 'object'), -- durable retry-key/hash registry; no attempt table
  attempt_request_hash text NOT NULL CHECK (attempt_request_hash ~ '^[0-9a-f]{64}$'),
  attempt_sources jsonb NOT NULL CHECK (jsonb_typeof(attempt_sources) = 'object' AND attempt_sources <> '{}'::jsonb),
  attempt_result_snapshot jsonb CHECK (attempt_result_snapshot IS NULL OR jsonb_typeof(attempt_result_snapshot) = 'object'),
  attempt_result_hash text CHECK (attempt_result_hash IS NULL OR attempt_result_hash ~ '^[0-9a-f]{64}$'),
  lease_expires_at timestamptz,
  attempt_finished_at timestamptz,
  acquired_paper_ids uuid[] NOT NULL DEFAULT '{}',
  response_snapshot jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(response_snapshot) = 'object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (session_id, request_id),
  UNIQUE (session_id, id),
  CHECK (year_from IS NULL OR year_to IS NULL OR year_from <= year_to),
  CHECK (
    (execution_status = 'running' AND lease_expires_at IS NOT NULL
      AND attempt_finished_at IS NULL AND attempt_result_hash IS NULL AND attempt_result_snapshot IS NULL)
    OR
    (execution_status = 'idle' AND lease_expires_at IS NULL
      AND attempt_finished_at IS NOT NULL)
  ),
  CHECK (acquisition_status <> 'pending' OR execution_status = 'running')
);

CREATE TABLE public.research_session_papers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), -- immutable session paper identity
  session_id uuid NOT NULL REFERENCES public.research_sessions(id) ON DELETE CASCADE,
  canonical_key text NOT NULL CHECK (length(btrim(canonical_key)) BETWEEN 1 AND 2048),
  metadata_version integer NOT NULL DEFAULT 1 CHECK (metadata_version > 0),
  metadata jsonb NOT NULL CHECK (jsonb_typeof(metadata) = 'object'),
  first_retrieval_id uuid NOT NULL,
  last_retrieval_id uuid NOT NULL,
  first_discovered_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_discovered_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_presented_at timestamptz,
  last_presented_revision integer CHECK (last_presented_revision > 0),
  last_presented_query text,
  first_viewed_at timestamptz,
  last_viewed_at timestamptz,
  saved_at timestamptz,
  rejected_at timestamptz,
  rejection_scope text CHECK (rejection_scope IN ('context','session')),
  rejected_revision integer CHECK (rejected_revision > 0),
  rejection_reason text,
  cited_at timestamptz,
  merged_into_id uuid, -- redirects preserve old receipt/API references; no destructive merge
  row_version bigint NOT NULL DEFAULT 0 CHECK (row_version >= 0),
  UNIQUE (session_id, id),
  FOREIGN KEY (session_id, first_retrieval_id) REFERENCES public.research_retrievals(session_id, id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (session_id, last_retrieval_id) REFERENCES public.research_retrievals(session_id, id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (session_id, merged_into_id) REFERENCES public.research_session_papers(session_id, id) DEFERRABLE INITIALLY DEFERRED,
  CHECK (merged_into_id IS NULL OR merged_into_id <> id),
  CHECK (last_discovered_at >= first_discovered_at),
  CHECK ((last_presented_at IS NULL AND last_presented_revision IS NULL AND last_presented_query IS NULL)
    OR (last_presented_at IS NOT NULL AND last_presented_revision IS NOT NULL AND last_presented_query IS NOT NULL)),
  CHECK ((first_viewed_at IS NULL AND last_viewed_at IS NULL)
    OR (first_viewed_at IS NOT NULL AND last_viewed_at IS NOT NULL AND last_viewed_at >= first_viewed_at)),
  CHECK (
    (rejected_at IS NULL AND rejection_scope IS NULL AND rejected_revision IS NULL)
    OR (rejected_at IS NOT NULL AND rejection_scope IS NOT NULL AND (
      (rejection_scope = 'session' AND rejected_revision IS NULL)
      OR (rejection_scope = 'context' AND rejected_revision IS NOT NULL)
    ))
  )
);

CREATE TABLE public.research_paper_aliases (
  session_id uuid NOT NULL REFERENCES public.research_sessions(id) ON DELETE CASCADE,
  alias text NOT NULL CHECK (length(btrim(alias)) BETWEEN 1 AND 2048),
  paper_id uuid,
  ambiguous boolean NOT NULL DEFAULT false,
  CHECK ((NOT ambiguous AND paper_id IS NOT NULL) OR (ambiguous AND paper_id IS NULL AND (alias LIKE 'bibmeta:%' OR alias LIKE 'bib:%'))),
  PRIMARY KEY (session_id, alias),
  FOREIGN KEY (session_id, paper_id) REFERENCES public.research_session_papers(session_id, id) ON DELETE CASCADE
);

CREATE INDEX research_sessions_owner_updated ON public.research_sessions(owner_id, updated_at DESC, id);
CREATE INDEX research_retrievals_session_created ON public.research_retrievals(session_id, created_at DESC, id);
CREATE UNIQUE INDEX research_one_running_pull ON public.research_retrievals(session_id) WHERE execution_status = 'running';
CREATE INDEX research_papers_session_presented ON public.research_session_papers(session_id, last_presented_revision) WHERE merged_into_id IS NULL;
CREATE INDEX research_papers_session_saved ON public.research_session_papers(session_id, saved_at DESC, id) WHERE saved_at IS NOT NULL AND merged_into_id IS NULL;
CREATE INDEX research_papers_first_pull ON public.research_session_papers(session_id, first_retrieval_id);
CREATE INDEX research_papers_last_pull ON public.research_session_papers(session_id, last_retrieval_id);
CREATE INDEX research_papers_redirect ON public.research_session_papers(session_id, merged_into_id) WHERE merged_into_id IS NOT NULL;
CREATE INDEX research_aliases_paper ON public.research_paper_aliases(session_id, paper_id);

ALTER TABLE public.research_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.research_retrievals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.research_session_papers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.research_paper_aliases ENABLE ROW LEVEL SECURITY;
-- API-only persistence/reads: no authenticated/anon table policies or access.
-- RLS remains enabled with no client policies (default deny).
REVOKE ALL ON public.research_sessions, public.research_retrievals, public.research_session_papers, public.research_paper_aliases FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.research_sessions, public.research_retrievals, public.research_session_papers, public.research_paper_aliases TO service_role;

CREATE FUNCTION public.research_require_actor(p_actor uuid) RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
BEGIN
  IF current_user <> 'service_role' THEN RAISE insufficient_privilege USING MESSAGE = 'BACKEND_ONLY'; END IF;
  IF p_actor IS NULL THEN RAISE SQLSTATE 'PT401' USING MESSAGE = 'AUTH_REQUIRED'; END IF;
END $$;

CREATE FUNCTION public.research_lock_session(p_actor uuid, p_session uuid) RETURNS public.research_sessions LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
DECLARE s public.research_sessions;
BEGIN
  PERFORM public.research_require_actor(p_actor);
  SELECT * INTO s FROM public.research_sessions WHERE id = p_session AND owner_id = p_actor FOR UPDATE;
  IF NOT FOUND THEN RAISE SQLSTATE 'PT404' USING MESSAGE = 'SESSION_NOT_FOUND'; END IF;
  RETURN s;
END $$;

CREATE FUNCTION public.research_check_hash(p_hash text) RETURNS void LANGUAGE plpgsql IMMUTABLE SECURITY INVOKER SET search_path = pg_catalog AS $$
BEGIN
  IF p_hash IS NULL OR p_hash !~ '^[0-9a-f]{64}$' THEN RAISE SQLSTATE 'PT400' USING MESSAGE = 'INVALID_HASH'; END IF;
END $$;

CREATE FUNCTION public.research_year(p_value jsonb) RETURNS integer LANGUAGE plpgsql IMMUTABLE SECURITY INVOKER SET search_path = pg_catalog AS $$
DECLARE n numeric; t text;
BEGIN
  IF p_value IS NULL OR p_value = 'null'::jsonb OR p_value = '""'::jsonb THEN RETURN NULL; END IF;
  IF jsonb_typeof(p_value) NOT IN ('number','string') THEN RAISE SQLSTATE 'PT400' USING MESSAGE = 'INVALID_YEAR'; END IF;
  t := p_value #>> '{}';
  IF t !~ '^[0-9]+$' THEN RAISE SQLSTATE 'PT400' USING MESSAGE = 'INVALID_YEAR'; END IF;
  n := t::numeric;
  IF n < 1 OR n > 9999 THEN RAISE SQLSTATE 'PT400' USING MESSAGE = 'INVALID_YEAR'; END IF;
  RETURN n::integer;
END $$;

CREATE FUNCTION public.research_context(p_context jsonb) RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SECURITY INVOKER SET search_path = pg_catalog AS $$
DECLARE k text; f integer; t integer;
BEGIN
  IF p_context IS NULL OR jsonb_typeof(p_context) <> 'object' THEN RAISE SQLSTATE 'PT400' USING MESSAGE = 'INVALID_CONTEXT'; END IF;
  FOR k IN SELECT jsonb_object_keys(p_context) LOOP
    IF k NOT IN ('topic','yearFrom','yearTo','population','location','selectedAngle','exclusions','extraConstraints') THEN RAISE SQLSTATE 'PT400' USING MESSAGE = 'UNKNOWN_CONTEXT_FIELD'; END IF;
  END LOOP;
  IF jsonb_typeof(p_context->'topic') IS DISTINCT FROM 'string' OR length(btrim(p_context->>'topic')) NOT BETWEEN 1 AND 2000 THEN RAISE SQLSTATE 'PT400' USING MESSAGE = 'INVALID_TOPIC'; END IF;
  f := public.research_year(p_context->'yearFrom'); t := public.research_year(p_context->'yearTo');
  IF f IS NOT NULL AND t IS NOT NULL AND f > t THEN RAISE SQLSTATE 'PT400' USING MESSAGE = 'INVALID_YEAR_RANGE'; END IF;
  FOREACH k IN ARRAY ARRAY['population','location'] LOOP
    IF p_context ? k AND jsonb_typeof(p_context->k) NOT IN ('null','string') THEN RAISE SQLSTATE 'PT400' USING MESSAGE = 'INVALID_CONTEXT_TEXT'; END IF;
  END LOOP;
  IF p_context ? 'selectedAngle' AND jsonb_typeof(p_context->'selectedAngle') NOT IN ('null','object') THEN RAISE SQLSTATE 'PT400' USING MESSAGE = 'INVALID_ANGLE'; END IF;
  IF p_context ? 'exclusions' AND jsonb_typeof(p_context->'exclusions') <> 'array' THEN RAISE SQLSTATE 'PT400' USING MESSAGE = 'INVALID_EXCLUSIONS'; END IF;
  IF p_context ? 'extraConstraints' AND jsonb_typeof(p_context->'extraConstraints') <> 'object' THEN RAISE SQLSTATE 'PT400' USING MESSAGE = 'INVALID_EXTRA_CONSTRAINTS'; END IF;
  RETURN jsonb_build_object('topic', btrim(p_context->>'topic'), 'yearFrom',f,'yearTo',t,
    'population',nullif(btrim(p_context->>'population'),''),'location',nullif(btrim(p_context->>'location'),''),
    'selectedAngle',coalesce(p_context->'selectedAngle','null'::jsonb),'exclusions',coalesce(p_context->'exclusions','[]'::jsonb),'extraConstraints',coalesce(p_context->'extraConstraints','{}'::jsonb));
END $$;

CREATE FUNCTION public.research_session_context(p_session public.research_sessions) RETURNS jsonb LANGUAGE sql IMMUTABLE SECURITY INVOKER SET search_path = pg_catalog AS $$
  SELECT jsonb_build_object('topic',p_session.current_topic,'yearFrom',p_session.year_from,'yearTo',p_session.year_to,
    'population',p_session.population,'location',p_session.location,'selectedAngle',p_session.selected_angle,
    'exclusions',p_session.exclusions,'extraConstraints',p_session.extra_constraints)
$$;

CREATE FUNCTION public.research_check_sources(p_config jsonb) RETURNS void LANGUAGE plpgsql IMMUTABLE SECURITY INVOKER SET search_path = pg_catalog AS $$
DECLARE k text; v jsonb;
BEGIN
  IF p_config IS NULL OR jsonb_typeof(p_config) <> 'object' OR p_config = '{}'::jsonb THEN RAISE SQLSTATE 'PT400' USING MESSAGE = 'INVALID_SOURCES'; END IF;
  FOR k,v IN SELECT * FROM jsonb_each(p_config) LOOP
    IF k !~ '^[a-z][a-z0-9_-]*$' OR jsonb_typeof(v) <> 'number' THEN RAISE SQLSTATE 'PT400' USING MESSAGE = 'INVALID_SOURCE_VERSION'; END IF;
    IF (v #>> '{}')::numeric < 1 OR trunc((v #>> '{}')::numeric) <> (v #>> '{}')::numeric THEN RAISE SQLSTATE 'PT400' USING MESSAGE = 'INVALID_SOURCE_VERSION'; END IF;
  END LOOP;
END $$;

CREATE FUNCTION public.research_check_state(p_source text, p_state jsonb) RETURNS void LANGUAGE plpgsql IMMUTABLE SECURITY INVOKER SET search_path = pg_catalog AS $$
DECLARE n numeric;
BEGIN
  IF p_state IS NULL THEN RAISE SQLSTATE 'PT400' USING MESSAGE = 'MISSING_SOURCE_STATE'; END IF;
  IF p_state = 'null'::jsonb THEN RETURN; END IF;
  IF jsonb_typeof(p_state) <> 'object' THEN RAISE SQLSTATE 'PT400' USING MESSAGE = 'INVALID_SOURCE_STATE'; END IF;
  IF p_state = '{}'::jsonb THEN RETURN; END IF;
  IF p_source = 'openalex' THEN
    IF (SELECT count(*) FROM jsonb_object_keys(p_state)) <> 1 OR jsonb_typeof(p_state->'cursor') IS DISTINCT FROM 'string'
      OR length(btrim(p_state->>'cursor')) NOT BETWEEN 1 AND 8192 THEN RAISE SQLSTATE 'PT400' USING MESSAGE = 'INVALID_OPENALEX_CURSOR'; END IF;
  ELSIF p_source = 'crossref' THEN
    IF (SELECT count(*) FROM jsonb_object_keys(p_state)) <> 1 OR jsonb_typeof(p_state->'offset') IS DISTINCT FROM 'number' THEN RAISE SQLSTATE 'PT400' USING MESSAGE = 'INVALID_CROSSREF_OFFSET'; END IF;
    n := (p_state->>'offset')::numeric;
    IF n < 0 OR n > 10000 OR trunc(n) <> n THEN RAISE SQLSTATE 'PT400' USING MESSAGE = 'INVALID_CROSSREF_OFFSET'; END IF;
  END IF;
END $$;

CREATE FUNCTION public.research_initial_continuation(p_query text, p_from integer, p_to integer, p_sources jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE SECURITY INVOKER SET search_path = pg_catalog AS $$
  SELECT jsonb_build_object('version',1,'query',p_query,'yearFrom',p_from,'yearTo',p_to,'sources',
    (SELECT jsonb_object_agg(k,'{}'::jsonb) FROM jsonb_object_keys(p_sources) k))
$$;

CREATE FUNCTION public.research_check_continuation(p_cont jsonb, p_query text, p_from integer, p_to integer, p_config jsonb) RETURNS void LANGUAGE plpgsql IMMUTABLE SECURITY INVOKER SET search_path = pg_catalog AS $$
DECLARE k text;
BEGIN
  IF p_cont IS NULL OR jsonb_typeof(p_cont) <> 'object' OR p_cont->'version' IS DISTINCT FROM '1'::jsonb
    OR p_cont->'query' IS DISTINCT FROM to_jsonb(p_query) OR p_cont->'yearFrom' IS DISTINCT FROM coalesce(to_jsonb(p_from),'null'::jsonb)
    OR p_cont->'yearTo' IS DISTINCT FROM coalesce(to_jsonb(p_to),'null'::jsonb) OR jsonb_typeof(p_cont->'sources') IS DISTINCT FROM 'object'
    THEN RAISE SQLSTATE 'PT400' USING MESSAGE = 'CONTINUATION_CONTEXT_MISMATCH'; END IF;
  IF (SELECT array_agg(keys.key ORDER BY keys.key) FROM jsonb_object_keys(p_cont->'sources') AS keys(key))
      IS DISTINCT FROM (SELECT array_agg(keys.key ORDER BY keys.key) FROM jsonb_object_keys(p_config) AS keys(key))
    THEN RAISE SQLSTATE 'PT400' USING MESSAGE = 'CONTINUATION_SOURCE_MISMATCH'; END IF;
  FOR k IN SELECT jsonb_object_keys(p_config) LOOP PERFORM public.research_check_state(k,p_cont->'sources'->k); END LOOP;
END $$;

CREATE FUNCTION public.research_acquisition_status(p_progress jsonb) RETURNS text LANGUAGE sql IMMUTABLE SECURITY INVOKER SET search_path = pg_catalog AS $$
  SELECT CASE WHEN bool_and(v->>'status' IN ('ok','skipped')) THEN 'complete'
    WHEN bool_or(v->>'status' = 'ok') THEN 'partial' ELSE 'failed' END FROM jsonb_each(p_progress) e(k,v)
$$;

CREATE FUNCTION public.research_receipt_reply(p_row public.research_retrievals, p_disposition text) RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER SET search_path = pg_catalog AS $$
  SELECT jsonb_build_object('persisted',true,'disposition',p_disposition,'pullId',p_row.id,'pullKind',p_row.pull_kind,
    'receiptVersion',p_row.receipt_version,'contextRevision',p_row.context_revision,'executionStatus',p_row.execution_status,
    'acquisitionStatus',p_row.acquisition_status,'acquiredPaperIds',p_row.acquired_paper_ids,'sourceStatus',p_row.source_progress,
    'continuation',p_row.output_continuation,'response',p_row.response_snapshot)
    || CASE WHEN p_disposition = 'execute' THEN jsonb_build_object('attemptToken',p_row.attempt_token,
      'attemptSources',p_row.attempt_sources,'leaseExpiresAt',p_row.lease_expires_at,'query',p_row.retrieval_query,
      'yearFrom',p_row.year_from,'yearTo',p_row.year_to,'sourceConfig',p_row.source_config) ELSE '{}'::jsonb END
$$;

CREATE FUNCTION public.create_research_session(
  p_actor uuid, p_creation_request_id uuid, p_creation_hash text, p_original_idea text,
  p_context jsonb, p_style text DEFAULT 'Harvard', p_query text DEFAULT NULL,
  p_source_config jsonb DEFAULT '{"openalex":1,"crossref":1}'
) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
DECLARE s public.research_sessions; c jsonb; snap jsonb; q text;
BEGIN
  PERFORM public.research_require_actor(p_actor); PERFORM public.research_check_hash(p_creation_hash);
  IF p_creation_request_id IS NULL OR p_original_idea IS NULL OR length(btrim(p_original_idea)) NOT BETWEEN 1 AND 2000
    OR p_style IS NULL OR length(btrim(p_style)) NOT BETWEEN 1 AND 512 THEN RAISE SQLSTATE 'PT400' USING MESSAGE = 'INVALID_SESSION'; END IF;
  c := public.research_context(p_context); q := btrim(coalesce(p_query,c->>'topic'));
  IF length(q) NOT BETWEEN 1 AND 2000 THEN RAISE SQLSTATE 'PT400' USING MESSAGE = 'INVALID_QUERY'; END IF;
  PERFORM public.research_check_sources(p_source_config);
  snap := jsonb_build_object('idea',btrim(p_original_idea),'context',c,'style',btrim(p_style),'query',q,'sources',p_source_config);
  INSERT INTO public.research_sessions(owner_id,creation_request_id,creation_hash,creation_snapshot,original_idea,current_topic,
    year_from,year_to,population,location,selected_angle,exclusions,extra_constraints,citation_style,retrieval_query,source_config)
  VALUES(p_actor,p_creation_request_id,p_creation_hash,snap,btrim(p_original_idea),c->>'topic',public.research_year(c->'yearFrom'),
    public.research_year(c->'yearTo'),c->>'population',c->>'location',nullif(c->'selectedAngle','null'::jsonb),c->'exclusions',c->'extraConstraints',btrim(p_style),q,p_source_config)
  ON CONFLICT (owner_id,creation_request_id) DO NOTHING;
  SELECT * INTO s FROM public.research_sessions WHERE owner_id = p_actor AND creation_request_id = p_creation_request_id FOR UPDATE;
  IF s.creation_hash IS DISTINCT FROM p_creation_hash OR s.creation_snapshot IS DISTINCT FROM snap THEN RAISE SQLSTATE 'PT409' USING MESSAGE = 'IDEMPOTENCY_KEY_REUSED'; END IF;
  RETURN jsonb_build_object('persisted',true,'session',to_jsonb(s));
END $$;

CREATE FUNCTION public.update_research_session(
  p_actor uuid,p_session uuid,p_expected_version bigint,p_patch jsonb DEFAULT '{}',
  p_style text DEFAULT NULL,p_query text DEFAULT NULL,p_source_config jsonb DEFAULT NULL,p_archived boolean DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
DECLARE s public.research_sessions; c jsonb; q text; cfg jsonb; style text; changed boolean; same_basis boolean;
BEGIN
  s := public.research_lock_session(p_actor,p_session);
  IF p_expected_version IS DISTINCT FROM s.row_version THEN RAISE SQLSTATE 'PT409' USING MESSAGE = 'STALE_VERSION'; END IF;
  IF p_patch IS NULL OR jsonb_typeof(p_patch) <> 'object' THEN RAISE SQLSTATE 'PT400' USING MESSAGE = 'INVALID_PATCH'; END IF;
  c := public.research_context(public.research_session_context(s) || p_patch);
  q := btrim(coalesce(p_query,CASE WHEN p_patch ? 'topic' THEN c->>'topic' ELSE s.retrieval_query END));
  cfg := coalesce(p_source_config,s.source_config); style := btrim(coalesce(p_style,s.citation_style));
  IF length(q) NOT BETWEEN 1 AND 2000 OR length(style) NOT BETWEEN 1 AND 512 THEN RAISE SQLSTATE 'PT400' USING MESSAGE = 'INVALID_QUERY_OR_STYLE'; END IF;
  PERFORM public.research_check_sources(cfg);
  same_basis := q = s.retrieval_query AND c->'yearFrom' = coalesce(to_jsonb(s.year_from),'null'::jsonb)
    AND c->'yearTo' = coalesce(to_jsonb(s.year_to),'null'::jsonb) AND cfg = s.source_config;
  changed := c IS DISTINCT FROM public.research_session_context(s) OR NOT same_basis;
  UPDATE public.research_sessions SET current_topic=c->>'topic',year_from=public.research_year(c->'yearFrom'),year_to=public.research_year(c->'yearTo'),
    population=c->>'population',location=c->>'location',selected_angle=nullif(c->'selectedAngle','null'::jsonb),exclusions=c->'exclusions',extra_constraints=c->'extraConstraints',
    citation_style=style,retrieval_query=q,source_config=cfg,context_revision=context_revision+CASE WHEN changed THEN 1 ELSE 0 END,
    continuation=CASE WHEN same_basis THEN continuation ELSE NULL END,
    archived_at=CASE WHEN p_archived IS NULL THEN archived_at WHEN p_archived THEN coalesce(archived_at,clock_timestamp()) ELSE NULL END,
    row_version=row_version+1,updated_at=clock_timestamp() WHERE id=s.id RETURNING * INTO s;
  RETURN jsonb_build_object('persisted',true,'session',to_jsonb(s));
END $$;

CREATE FUNCTION public.research_expire_attempt(p_actor uuid,p_session uuid) RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
DECLARE r public.research_retrievals; progress jsonb; k text;
BEGIN
  PERFORM public.research_lock_session(p_actor,p_session);
  SELECT * INTO r FROM public.research_retrievals WHERE session_id=p_session AND execution_status='running' FOR UPDATE;
  IF FOUND AND r.lease_expires_at <= clock_timestamp() THEN
    progress := r.source_progress;
    FOR k IN SELECT jsonb_object_keys(r.attempt_sources) LOOP
      progress := jsonb_set(progress,ARRAY[k],jsonb_build_object('status','error','error','Source temporarily unavailable','returned',0,'total',NULL));
    END LOOP;
    UPDATE public.research_retrievals SET source_progress=progress,acquisition_status=public.research_acquisition_status(progress),execution_status='idle',
      lease_expires_at=NULL,attempt_finished_at=clock_timestamp(),receipt_version=receipt_version+1,updated_at=clock_timestamp(),
      response_snapshot=jsonb_build_object('persisted',true,'error','ATTEMPT_EXPIRED','retryable',true) WHERE id=r.id;
  END IF;
END $$;

CREATE FUNCTION public.begin_research_pull(
  p_actor uuid,p_session uuid,p_expected_version bigint,p_request_id uuid,p_request_hash text,
  p_pull_kind text,p_intent jsonb,p_pipeline_version text DEFAULT 'phase1-v1'
) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
DECLARE s public.research_sessions; r public.research_retrievals; cont jsonb; progress jsonb; todo jsonb;
BEGIN
  s := public.research_lock_session(p_actor,p_session); PERFORM public.research_check_hash(p_request_hash);
  IF p_request_id IS NULL OR p_pull_kind IS NULL OR p_pull_kind NOT IN ('initial','additional') OR p_intent IS NULL OR jsonb_typeof(p_intent)<>'object'
    OR p_pipeline_version IS NULL OR length(btrim(p_pipeline_version)) NOT BETWEEN 1 AND 128 THEN RAISE SQLSTATE 'PT400' USING MESSAGE = 'INVALID_PULL'; END IF;
  PERFORM public.research_expire_attempt(p_actor,p_session);
  SELECT * INTO r FROM public.research_retrievals WHERE session_id=p_session AND request_id=p_request_id FOR UPDATE;
  IF FOUND THEN
    IF r.request_hash IS DISTINCT FROM p_request_hash OR r.intent_snapshot IS DISTINCT FROM p_intent OR r.pull_kind IS DISTINCT FROM p_pull_kind
      OR r.pipeline_version IS DISTINCT FROM p_pipeline_version THEN RAISE SQLSTATE 'PT409' USING MESSAGE = 'IDEMPOTENCY_KEY_REUSED'; END IF;
    RETURN public.research_receipt_reply(r,CASE WHEN r.execution_status='running' THEN 'in_progress' ELSE 'replay' END);
  END IF;
  IF p_expected_version IS DISTINCT FROM s.row_version THEN RAISE SQLSTATE 'PT409' USING MESSAGE = 'STALE_VERSION'; END IF;
  IF s.archived_at IS NOT NULL THEN RAISE SQLSTATE 'PT409' USING MESSAGE = 'SESSION_ARCHIVED'; END IF;
  IF EXISTS(SELECT 1 FROM public.research_retrievals WHERE session_id=s.id AND execution_status='running') THEN RAISE SQLSTATE 'PT409' USING MESSAGE = 'PULL_IN_PROGRESS'; END IF;
  cont := coalesce(s.continuation,public.research_initial_continuation(s.retrieval_query,s.year_from,s.year_to,s.source_config));
  PERFORM public.research_check_continuation(cont,s.retrieval_query,s.year_from,s.year_to,s.source_config);
  SELECT coalesce(jsonb_object_agg(k,v),'{}'::jsonb) INTO todo FROM jsonb_each(cont->'sources') e(k,v) WHERE v<>'null'::jsonb;
  IF todo='{}'::jsonb THEN RAISE SQLSTATE 'PT409' USING MESSAGE = 'SOURCES_EXHAUSTED'; END IF;
  SELECT jsonb_object_agg(k,jsonb_build_object('status',CASE WHEN v='null'::jsonb THEN 'skipped' ELSE 'pending' END,'returned',0,'total',NULL))
    INTO progress FROM jsonb_each(cont->'sources') e(k,v);
  INSERT INTO public.research_retrievals(session_id,request_id,request_hash,intent_snapshot,pull_kind,context_revision,context_snapshot,
    retrieval_query,year_from,year_to,source_config,pipeline_version,input_continuation,output_continuation,source_progress,execution_status,
    attempt_token,attempt_request_id,attempt_request_hash,attempt_requests,attempt_sources,lease_expires_at)
  VALUES(s.id,p_request_id,p_request_hash,p_intent,p_pull_kind,s.context_revision,public.research_session_context(s),s.retrieval_query,s.year_from,s.year_to,s.source_config,
    p_pipeline_version,cont,cont,progress,'running',gen_random_uuid(),p_request_id,p_request_hash,jsonb_build_object(p_request_id::text,p_request_hash),todo,clock_timestamp()+interval '45 seconds') RETURNING * INTO r;
  UPDATE public.research_sessions SET row_version=row_version+1,updated_at=clock_timestamp() WHERE id=s.id RETURNING * INTO s;
  RETURN public.research_receipt_reply(r,'execute') || jsonb_build_object('sessionVersion',s.row_version);
END $$;

CREATE FUNCTION public.retry_failed_research_sources(
  p_actor uuid,p_session uuid,p_pull uuid,p_expected_receipt_version bigint,p_retry_request_id uuid,p_retry_hash text
) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
DECLARE s public.research_sessions; r public.research_retrievals; todo jsonb;
BEGIN
  s := public.research_lock_session(p_actor,p_session); PERFORM public.research_check_hash(p_retry_hash);
  IF p_retry_request_id IS NULL THEN RAISE SQLSTATE 'PT400' USING MESSAGE = 'INVALID_RETRY'; END IF;
  SELECT * INTO r FROM public.research_retrievals WHERE id=p_pull AND session_id=s.id FOR UPDATE;
  IF NOT FOUND THEN RAISE SQLSTATE 'PT404' USING MESSAGE = 'PULL_NOT_FOUND'; END IF;
  IF r.attempt_requests ? (p_retry_request_id::text) THEN
    IF r.attempt_requests->>(p_retry_request_id::text) IS DISTINCT FROM p_retry_hash THEN RAISE SQLSTATE 'PT409' USING MESSAGE = 'IDEMPOTENCY_KEY_REUSED'; END IF;
    RETURN public.research_receipt_reply(r,CASE WHEN r.execution_status='running' THEN 'in_progress' ELSE 'replay' END);
  END IF;
  IF p_expected_receipt_version IS DISTINCT FROM r.receipt_version THEN RAISE SQLSTATE 'PT409' USING MESSAGE = 'STALE_RECEIPT'; END IF;
  -- Compare before expiry changes the receipt version; otherwise an expired lease can livelock retries.
  PERFORM public.research_expire_attempt(p_actor,p_session);
  SELECT * INTO r FROM public.research_retrievals WHERE id=p_pull AND session_id=s.id FOR UPDATE;
  IF s.archived_at IS NOT NULL THEN RAISE SQLSTATE 'PT409' USING MESSAGE = 'SESSION_ARCHIVED'; END IF;
  IF EXISTS(SELECT 1 FROM public.research_retrievals WHERE session_id=s.id AND execution_status='running') THEN RAISE SQLSTATE 'PT409' USING MESSAGE = 'PULL_IN_PROGRESS'; END IF;
  SELECT coalesce(jsonb_object_agg(k,r.input_continuation->'sources'->k),'{}'::jsonb) INTO todo
    FROM jsonb_each(r.source_progress) e(k,v) WHERE v->>'status' NOT IN ('ok','skipped');
  IF todo='{}'::jsonb THEN RETURN public.research_receipt_reply(r,'replay'); END IF;
  UPDATE public.research_retrievals SET execution_status='running',attempt_no=attempt_no+1,attempt_token=gen_random_uuid(),attempt_request_id=p_retry_request_id,
    attempt_request_hash=p_retry_hash,attempt_requests=attempt_requests||jsonb_build_object(p_retry_request_id::text,p_retry_hash),attempt_sources=todo,attempt_result_hash=NULL,attempt_result_snapshot=NULL,lease_expires_at=clock_timestamp()+interval '45 seconds',attempt_finished_at=NULL,
    receipt_version=receipt_version+1,updated_at=clock_timestamp() WHERE id=r.id RETURNING * INTO r;
  RETURN public.research_receipt_reply(r,'execute') || jsonb_build_object('sessionVersion',s.row_version);
END $$;

CREATE FUNCTION public.research_bib_identity(p_paper jsonb) RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SECURITY INVOKER SET search_path = pg_catalog AS $$
DECLARE authors jsonb := '[]'; a jsonb; title text; y integer;
BEGIN
  IF jsonb_typeof(p_paper->'title') IS DISTINCT FROM 'string' OR jsonb_typeof(p_paper->'authors') IS DISTINCT FROM 'array' THEN RETURN NULL; END IF;
  title := btrim(regexp_replace(lower(normalize(p_paper->>'title',NFKC)),'[[:space:]]+',' ','g'));
  IF title='' OR jsonb_array_length(p_paper->'authors')=0 THEN RETURN NULL; END IF;
  y := public.research_year(p_paper->'year'); IF y IS NULL THEN RETURN NULL; END IF;
  FOR a IN SELECT value FROM jsonb_array_elements(p_paper->'authors') LOOP
    IF jsonb_typeof(a->'family') IS DISTINCT FROM 'string' OR jsonb_typeof(a->'given') IS DISTINCT FROM 'string'
      OR btrim(a->>'family')='' OR btrim(a->>'given')='' THEN RETURN NULL; END IF;
    authors := authors || jsonb_build_array(jsonb_build_array(
      btrim(regexp_replace(lower(normalize(a->>'family',NFKC)),'[^[:alnum:]]+',' ','g')),
      btrim(regexp_replace(lower(normalize(a->>'given',NFKC)),'[^[:alnum:]]+',' ','g'))));
  END LOOP;
  RETURN jsonb_build_array(title,y,authors);
END $$;

CREATE FUNCTION public.research_record_aliases(p_paper jsonb) RETURNS text[] LANGUAGE plpgsql IMMUTABLE SECURITY INVOKER SET search_path = pg_catalog AS $$
DECLARE aliases text[]; k text; v jsonb; bib jsonb; entry jsonb;
BEGIN
  IF p_paper IS NULL OR jsonb_typeof(p_paper)<>'object' OR jsonb_typeof(p_paper->'id') IS DISTINCT FROM 'string'
    OR length(btrim(p_paper->>'id')) NOT BETWEEN 1 AND 2048 OR jsonb_typeof(p_paper->'authors') IS DISTINCT FROM 'array'
    OR jsonb_typeof(p_paper->'provenance') IS DISTINCT FROM 'array'
    OR jsonb_typeof(p_paper->'identifiers') IS DISTINCT FROM 'object' OR jsonb_typeof(p_paper->'citationCounts') IS DISTINCT FROM 'object'
    OR jsonb_typeof(p_paper->'sourceRecords') IS DISTINCT FROM 'array' THEN RAISE SQLSTATE 'PT400' USING MESSAGE = 'INVALID_CANONICAL_PAPER'; END IF;
  aliases := ARRAY[p_paper->>'id'];
  IF nullif(p_paper->>'doi','') IS NOT NULL THEN
    IF p_paper->>'doi' !~ '^10\.[0-9]{4,9}/[^[:space:]]+$' OR p_paper->>'doi'<>lower(p_paper->>'doi') THEN RAISE SQLSTATE 'PT400' USING MESSAGE = 'INVALID_NORMALIZED_DOI'; END IF;
    aliases := array_append(aliases,'doi:'||(p_paper->>'doi'));
  END IF;
  IF jsonb_typeof(p_paper->'identifiers')='object' THEN
    FOR k,v IN SELECT * FROM jsonb_each(p_paper->'identifiers') LOOP
      IF k<>'doi' AND jsonb_typeof(v)='string' AND btrim(v #>> '{}')<>'' THEN aliases := array_append(aliases,k||':'||(v #>> '{}')); END IF;
    END LOOP;
  END IF;
  FOR entry IN SELECT value FROM jsonb_array_elements(p_paper->'provenance') LOOP
    IF jsonb_typeof(entry->'source') IS DISTINCT FROM 'string' OR btrim(entry->>'source')='' THEN RAISE SQLSTATE 'PT400' USING MESSAGE = 'INVALID_PROVENANCE'; END IF;
    IF jsonb_typeof(entry->'id')='string' AND btrim(entry->>'id')<>'' THEN aliases := array_append(aliases,(entry->>'source')||':'||(entry->>'id')); END IF;
  END LOOP;
  bib := public.research_bib_identity(p_paper);
  IF bib IS NOT NULL THEN aliases := array_append(aliases,'bibmeta:'||md5(bib::text)); END IF;
  -- MD5 only indexes the fallback; full bibliographic equality is ALWAYS checked before a fallback match.
  IF EXISTS(SELECT 1 FROM unnest(aliases) a WHERE length(btrim(a)) NOT BETWEEN 1 AND 2048) THEN RAISE SQLSTATE 'PT400' USING MESSAGE = 'INVALID_PAPER_ALIAS'; END IF;
  RETURN ARRAY(SELECT DISTINCT a FROM unnest(aliases) a ORDER BY a);
END $$;

CREATE FUNCTION public.research_merge_metadata(p_old jsonb,p_new jsonb) RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SECURITY INVOKER SET search_path = pg_catalog AS $$
DECLARE result jsonb := p_old; k text; v jsonb; old_crossref boolean; new_crossref boolean;
BEGIN
  SELECT EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(p_old->'provenance','[]')) e WHERE e->>'source'='crossref') INTO old_crossref;
  SELECT EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(p_new->'provenance','[]')) e WHERE e->>'source'='crossref') INTO new_crossref;
  FOR k,v IN SELECT * FROM jsonb_each(p_new) LOOP
    IF k IN ('provenance','sourceRecords','identifiers','citationCounts') THEN CONTINUE; END IF;
    IF old_crossref AND NOT new_crossref AND k IN ('authors','type','volume','issue','page','publisher') AND p_old->k IS NOT NULL AND p_old->k NOT IN ('null'::jsonb,'""'::jsonb,'[]'::jsonb) THEN CONTINUE; END IF;
    IF v NOT IN ('null'::jsonb,'""'::jsonb,'[]'::jsonb,'{}'::jsonb) OR NOT result ? k THEN result := jsonb_set(result,ARRAY[k],v); END IF;
  END LOOP;
  result := result || jsonb_build_object('identifiers',coalesce(p_old->'identifiers','{}') || coalesce((SELECT jsonb_object_agg(key,value) FROM jsonb_each(coalesce(p_new->'identifiers','{}')) WHERE value<>'null'::jsonb),'{}'::jsonb));
  FOR k IN SELECT unnest(ARRAY['provenance','sourceRecords']) LOOP
    SELECT coalesce(jsonb_agg(obj ORDER BY ord),'[]'::jsonb) INTO v FROM (
      SELECT DISTINCT ON (identity) obj,ord FROM (
        SELECT obj,ord,CASE WHEN k='provenance' THEN jsonb_build_array(obj->'source',obj->'id')::text
          ELSE CASE WHEN jsonb_typeof(obj->'provenance')='array' THEN jsonb_build_array(obj->'provenance'->0->'source',obj->'provenance'->0->'id')::text ELSE obj::text END END AS identity
        FROM jsonb_array_elements(coalesce(p_old->k,'[]') || coalesce(p_new->k,'[]')) WITH ORDINALITY e(obj,ord)
      ) entries ORDER BY identity,ord DESC
    ) latest;
    result := jsonb_set(result,ARRAY[k],v);
  END LOOP;
  SELECT coalesce(jsonb_object_agg(source,to_jsonb(n)),'{}'::jsonb) INTO v FROM (
    SELECT source,max((value #>> '{}')::numeric) n FROM (
      SELECT * FROM jsonb_each(coalesce(p_old->'citationCounts','{}'))
      UNION ALL SELECT * FROM jsonb_each(coalesce(p_new->'citationCounts','{}'))
    ) counts(source,value) WHERE jsonb_typeof(value)='number' GROUP BY source
  ) maxima;
  result := result || jsonb_build_object('citationCounts',v,'citedBy',coalesce((SELECT max((value #>> '{}')::numeric) FROM jsonb_each(v)),0));
  IF nullif(result->>'doi','') IS NOT NULL THEN result := jsonb_set(result,ARRAY['id'],to_jsonb('doi:'||(result->>'doi'))); END IF;
  RETURN result;
END $$;

CREATE FUNCTION public.research_resolve_paper(p_session uuid,p_paper uuid) RETURNS uuid LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = pg_catalog AS $$
DECLARE current_id uuid := p_paper; next_id uuid; visited uuid[] := '{}';
BEGIN
  LOOP
    IF current_id=ANY(visited) THEN RAISE SQLSTATE 'PT409' USING MESSAGE = 'IDENTITY_CYCLE'; END IF;
    visited := array_append(visited,current_id);
    SELECT merged_into_id INTO next_id FROM public.research_session_papers WHERE session_id=p_session AND id=current_id;
    IF NOT FOUND THEN RAISE SQLSTATE 'PT404' USING MESSAGE = 'PAPER_NOT_FOUND'; END IF;
    IF next_id IS NULL THEN RETURN current_id; END IF;
    current_id := next_id;
  END LOOP;
END $$;

CREATE FUNCTION public.research_upsert_paper(p_actor uuid,p_session uuid,p_pull uuid,p_paper jsonb) RETURNS uuid LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
DECLARE aliases text[]; alias_key text; a public.research_paper_aliases; old public.research_session_papers; winner public.research_session_papers;
  ids uuid[] := '{}'; candidate uuid; doi text := nullif(p_paper->>'doi',''); existing_dois text[]; merged jsonb; rejection public.research_session_papers;
BEGIN
  -- Internal helper. Caller holds the session lock; service-role-only, no frontend execution.
  PERFORM public.research_lock_session(p_actor,p_session);
  aliases := public.research_record_aliases(p_paper);
  FOREACH alias_key IN ARRAY aliases LOOP
    SELECT * INTO a FROM public.research_paper_aliases WHERE session_id=p_session AND alias=alias_key;
    IF NOT FOUND OR a.ambiguous THEN CONTINUE; END IF;
    candidate := public.research_resolve_paper(p_session,a.paper_id);
    SELECT * INTO old FROM public.research_session_papers WHERE id=candidate AND session_id=p_session FOR UPDATE;
    IF (alias_key LIKE 'bibmeta:%' OR alias_key LIKE 'bib:%') AND (
      public.research_bib_identity(old.metadata) IS NULL OR public.research_bib_identity(p_paper) IS NULL
      OR public.research_bib_identity(old.metadata) IS DISTINCT FROM public.research_bib_identity(p_paper)
      OR (doi IS NOT NULL AND nullif(old.metadata->>'doi','') IS NOT NULL AND old.metadata->>'doi'<>doi)
    ) THEN
      UPDATE public.research_paper_aliases SET paper_id=NULL,ambiguous=true WHERE session_id=p_session AND alias=alias_key;
      CONTINUE;
    END IF;
    IF NOT candidate=ANY(ids) THEN ids := array_append(ids,candidate); END IF;
  END LOOP;
  SELECT array_agg(DISTINCT d) INTO existing_dois FROM (
    SELECT nullif(metadata->>'doi','') d FROM public.research_session_papers WHERE session_id=p_session AND id=ANY(ids)
    UNION ALL SELECT doi
  ) x WHERE d IS NOT NULL;
  IF coalesce(cardinality(existing_dois),0)>1 THEN RAISE SQLSTATE 'PT409' USING MESSAGE = 'IDENTITY_CONFLICT'; END IF;
  IF cardinality(ids)=0 THEN
    INSERT INTO public.research_session_papers(session_id,canonical_key,metadata,first_retrieval_id,last_retrieval_id)
      VALUES(p_session,p_paper->>'id',p_paper,p_pull,p_pull) RETURNING * INTO winner;
  ELSE
    SELECT * INTO winner FROM public.research_session_papers WHERE session_id=p_session AND id=ANY(ids) ORDER BY first_discovered_at,id LIMIT 1 FOR UPDATE;
    merged := winner.metadata;
    FOR old IN SELECT * FROM public.research_session_papers WHERE session_id=p_session AND id=ANY(ids) ORDER BY first_discovered_at,id FOR UPDATE LOOP
      merged := public.research_merge_metadata(merged,old.metadata);
    END LOOP;
    merged := public.research_merge_metadata(merged,p_paper);
    SELECT * INTO rejection FROM public.research_session_papers WHERE session_id=p_session AND id=ANY(ids) AND rejected_at IS NOT NULL
      ORDER BY (rejection_scope='session') DESC,rejected_at DESC,id LIMIT 1;
    UPDATE public.research_session_papers w SET metadata=merged,canonical_key=merged->>'id',last_retrieval_id=p_pull,last_discovered_at=clock_timestamp(),
      first_viewed_at=(SELECT min(first_viewed_at) FROM public.research_session_papers WHERE session_id=p_session AND id=ANY(ids)),
      last_viewed_at=(SELECT max(last_viewed_at) FROM public.research_session_papers WHERE session_id=p_session AND id=ANY(ids)),
      saved_at=(SELECT min(saved_at) FROM public.research_session_papers WHERE session_id=p_session AND id=ANY(ids)),
      cited_at=(SELECT min(cited_at) FROM public.research_session_papers WHERE session_id=p_session AND id=ANY(ids)),
      rejected_at=rejection.rejected_at,rejection_scope=rejection.rejection_scope,rejected_revision=rejection.rejected_revision,rejection_reason=rejection.rejection_reason,
      row_version=w.row_version+1 WHERE w.id=winner.id RETURNING * INTO winner;
    -- Copy the most recent presentation across duplicates before marking redirects.
    SELECT * INTO old FROM public.research_session_papers WHERE session_id=p_session AND id=ANY(ids) AND last_presented_at IS NOT NULL ORDER BY last_presented_at DESC,id LIMIT 1;
    IF FOUND THEN UPDATE public.research_session_papers SET last_presented_at=old.last_presented_at,last_presented_revision=old.last_presented_revision,last_presented_query=old.last_presented_query WHERE id=winner.id RETURNING * INTO winner; END IF;
    UPDATE public.research_paper_aliases SET paper_id=winner.id WHERE session_id=p_session AND paper_id=ANY(ids);
    UPDATE public.research_session_papers SET merged_into_id=winner.id,row_version=row_version+1 WHERE session_id=p_session AND merged_into_id=ANY(ids) AND id<>winner.id;
    UPDATE public.research_session_papers SET merged_into_id=winner.id,row_version=row_version+1 WHERE session_id=p_session AND id=ANY(ids) AND id<>winner.id;
  END IF;
  FOREACH alias_key IN ARRAY aliases LOOP
    INSERT INTO public.research_paper_aliases(session_id,alias,paper_id) VALUES(p_session,alias_key,winner.id)
      ON CONFLICT(session_id,alias) DO UPDATE SET paper_id=EXCLUDED.paper_id WHERE NOT public.research_paper_aliases.ambiguous;
  END LOOP;
  RETURN winner.id;
END $$;

CREATE FUNCTION public.research_word_string(p_text text) RETURNS text LANGUAGE sql IMMUTABLE SECURITY INVOKER SET search_path = pg_catalog AS $$
  SELECT coalesce(string_agg(word,' ' ORDER BY ord),'') FROM regexp_split_to_table(
    btrim(regexp_replace(lower(normalize(coalesce(p_text,''),NFKC)),'[^[:alnum:]]+',' ','g')),' +') WITH ORDINALITY e(word,ord)
  WHERE word<>'' AND word<>ALL(ARRAY['a','an','the','and','or','of','for','to','in','on','at','by','with','from','as','is','are','was','were','be','been','being','how','what','which','that','this','these','those','does','do','can','could','would','should'])
$$;

CREATE FUNCTION public.research_new_relevance(p_old_query text,p_new_query text,p_metadata jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SECURITY INVOKER SET search_path = pg_catalog AS $$
DECLARE words text[]; previous text; title text; abstract text; phrase text; size integer; i integer;
BEGIN
  words := string_to_array(public.research_word_string(p_new_query),' ');
  previous := ' '||public.research_word_string(p_old_query)||' ';
  title := ' '||public.research_word_string(p_metadata->>'title')||' ';
  abstract := ' '||public.research_word_string(p_metadata->>'abstract')||' ';
  IF coalesce(cardinality(words),0)=0 THEN RETURN false; END IF;
  FOR size IN 1..3 LOOP
    IF cardinality(words)<size THEN CONTINUE; END IF;
    FOR i IN 1..(cardinality(words)-size+1) LOOP
      phrase := ' '||array_to_string(words[i:i+size-1],' ')||' ';
      IF strpos(previous,phrase)=0 AND (strpos(title,phrase)>0 OR strpos(abstract,phrase)>0) THEN RETURN true; END IF;
    END LOOP;
  END LOOP;
  RETURN false;
END $$;

CREATE FUNCTION public.present_research_papers(p_actor uuid,p_session uuid,p_expected_version bigint,p_context_revision integer,p_paper_ids uuid[]) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
DECLARE s public.research_sessions; p public.research_session_papers; candidate uuid; shown uuid[] := '{}';
BEGIN
  s := public.research_lock_session(p_actor,p_session);
  IF p_expected_version IS DISTINCT FROM s.row_version OR p_context_revision IS DISTINCT FROM s.context_revision THEN RAISE SQLSTATE 'PT409' USING MESSAGE = 'STALE_CONTEXT'; END IF;
  FOREACH candidate IN ARRAY coalesce(p_paper_ids,ARRAY[]::uuid[]) LOOP
    candidate := public.research_resolve_paper(s.id,candidate);
    IF candidate=ANY(shown) THEN CONTINUE; END IF;
    SELECT * INTO p FROM public.research_session_papers WHERE id=candidate AND session_id=s.id FOR UPDATE;
    IF p.saved_at IS NOT NULL OR p.cited_at IS NOT NULL OR p.rejected_at IS NOT NULL THEN CONTINUE; END IF;
    IF p.last_presented_revision=s.context_revision THEN CONTINUE; END IF;
    IF p.last_presented_at IS NOT NULL AND NOT public.research_new_relevance(p.last_presented_query,s.retrieval_query,p.metadata) THEN CONTINUE; END IF;
    UPDATE public.research_session_papers SET last_presented_at=clock_timestamp(),last_presented_revision=s.context_revision,
      last_presented_query=s.retrieval_query,row_version=row_version+1 WHERE id=p.id;
    shown := array_append(shown,p.id);
  END LOOP;
  RETURN jsonb_build_object('persisted',true,'sessionVersion',s.row_version,'contextRevision',s.context_revision,'presentedPaperIds',shown);
END $$;

CREATE FUNCTION public.complete_research_pull(
  p_actor uuid,p_session uuid,p_pull uuid,p_attempt_token uuid,p_expected_receipt_version bigint,
  p_result_hash text,p_source_results jsonb,p_papers jsonb,p_present_aliases text[] DEFAULT '{}'
) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
DECLARE s public.research_sessions; r public.research_retrievals; src text; outcome jsonb; state jsonb; progress jsonb; out_cont jsonb;
  active_cont jsonb; fresh jsonb; paper_id uuid; acquired uuid[]; selected uuid[] := '{}'; response jsonb; result_snapshot jsonb;
  applied text[] := '{}'; outcome_key text; source_returned numeric; old_offset numeric; new_offset numeric; same_basis boolean; same_context boolean; provenance jsonb;
BEGIN
  s := public.research_lock_session(p_actor,p_session); PERFORM public.research_check_hash(p_result_hash);
  SELECT * INTO r FROM public.research_retrievals WHERE id=p_pull AND session_id=s.id FOR UPDATE;
  IF NOT FOUND THEN RAISE SQLSTATE 'PT404' USING MESSAGE = 'PULL_NOT_FOUND'; END IF;
  IF p_source_results IS NULL OR jsonb_typeof(p_source_results)<>'object' OR p_papers IS NULL OR jsonb_typeof(p_papers)<>'array'
    THEN RAISE SQLSTATE 'PT400' USING MESSAGE = 'INVALID_COMPLETION'; END IF;
  -- Receipts are owner-readable. Reject arbitrary upstream error/debug payloads before storage.
  FOR src,outcome IN SELECT * FROM jsonb_each(p_source_results) LOOP
    IF jsonb_typeof(outcome)<>'object' THEN RAISE SQLSTATE 'PT400' USING MESSAGE = 'INVALID_SOURCE_RESULT'; END IF;
    FOR outcome_key IN SELECT jsonb_object_keys(outcome) LOOP
      IF outcome_key NOT IN ('status','returned','total','continuation') OR (outcome->>'status'='error' AND outcome_key<>'status')
        THEN RAISE SQLSTATE 'PT400' USING MESSAGE = 'UNSAFE_SOURCE_PAYLOAD'; END IF;
    END LOOP;
  END LOOP;
  result_snapshot := jsonb_build_object('sourceResults',p_source_results,'papers',p_papers,'presentAliases',coalesce(p_present_aliases,ARRAY[]::text[]));
  IF r.execution_status='idle' AND r.attempt_token=p_attempt_token AND r.attempt_result_hash IS NOT NULL THEN
    IF r.attempt_result_hash IS DISTINCT FROM p_result_hash OR r.attempt_result_snapshot IS DISTINCT FROM result_snapshot THEN RAISE SQLSTATE 'PT409' USING MESSAGE = 'RESULT_KEY_REUSED'; END IF;
    RETURN public.research_receipt_reply(r,'replay');
  END IF;
  IF r.execution_status<>'running' OR r.attempt_token IS DISTINCT FROM p_attempt_token OR r.receipt_version IS DISTINCT FROM p_expected_receipt_version
    OR r.lease_expires_at<=clock_timestamp() THEN RAISE SQLSTATE 'PT409' USING MESSAGE = 'STALE_ATTEMPT'; END IF;
  IF (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p_source_results) k) IS DISTINCT FROM
    (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(r.attempt_sources) k) THEN RAISE SQLSTATE 'PT400' USING MESSAGE = 'ATTEMPT_SOURCE_MISMATCH'; END IF;
  progress := r.source_progress; out_cont := r.output_continuation;
  same_basis := s.retrieval_query=r.retrieval_query AND s.year_from IS NOT DISTINCT FROM r.year_from
    AND s.year_to IS NOT DISTINCT FROM r.year_to AND s.source_config=r.source_config;
  same_context := s.context_revision=r.context_revision AND s.archived_at IS NULL;
  active_cont := coalesce(s.continuation,public.research_initial_continuation(s.retrieval_query,s.year_from,s.year_to,s.source_config));
  PERFORM public.research_check_continuation(active_cont,s.retrieval_query,s.year_from,s.year_to,s.source_config);
  FOR src,outcome IN SELECT * FROM jsonb_each(p_source_results) LOOP
    IF jsonb_typeof(outcome)<>'object' OR outcome->>'status' IS NULL OR outcome->>'status' NOT IN ('ok','error') THEN RAISE SQLSTATE 'PT400' USING MESSAGE = 'INVALID_SOURCE_RESULT'; END IF;
    IF outcome->>'status'='error' THEN
      progress := jsonb_set(progress,ARRAY[src],jsonb_build_object('status','error','error','Source temporarily unavailable','returned',0,'total',NULL));
      CONTINUE; -- Never copy thrown errors or advance an unsuccessful source.
    END IF;
    IF jsonb_typeof(outcome->'returned') IS DISTINCT FROM 'number' THEN RAISE SQLSTATE 'PT400' USING MESSAGE = 'INVALID_SOURCE_COUNT'; END IF;
    source_returned := (outcome->>'returned')::numeric;
    IF source_returned<0 OR trunc(source_returned)<>source_returned THEN RAISE SQLSTATE 'PT400' USING MESSAGE = 'INVALID_SOURCE_COUNT'; END IF;
    IF outcome ? 'total' AND jsonb_typeof(outcome->'total') NOT IN ('number','null') THEN RAISE SQLSTATE 'PT400' USING MESSAGE = 'INVALID_SOURCE_TOTAL'; END IF;
    IF jsonb_typeof(outcome->'total')='number' AND ((outcome->>'total')::numeric<0 OR trunc((outcome->>'total')::numeric)<>(outcome->>'total')::numeric) THEN RAISE SQLSTATE 'PT400' USING MESSAGE = 'INVALID_SOURCE_TOTAL'; END IF;
    state := outcome->'continuation'; PERFORM public.research_check_state(src,state);
    IF state='{}'::jsonb THEN RAISE SQLSTATE 'PT400' USING MESSAGE = 'NONADVANCING_SOURCE_STATE'; END IF;
    IF src='openalex' AND state<>'null'::jsonb AND state->>'cursor'=coalesce(r.attempt_sources->src->>'cursor','*') THEN RAISE SQLSTATE 'PT400' USING MESSAGE = 'NONADVANCING_SOURCE_STATE'; END IF;
    IF src='crossref' AND state<>'null'::jsonb THEN
      old_offset := coalesce((r.attempt_sources->src->>'offset')::numeric,0); new_offset := (state->>'offset')::numeric;
      IF new_offset<>old_offset+source_returned OR new_offset<=old_offset THEN RAISE SQLSTATE 'PT400' USING MESSAGE = 'INVALID_SOURCE_ADVANCE'; END IF;
    END IF;
    IF src IN ('openalex','crossref') AND source_returned=0 AND state<>'null'::jsonb THEN RAISE SQLSTATE 'PT400' USING MESSAGE = 'INVALID_EMPTY_PAGE'; END IF;
    progress := jsonb_set(progress,ARRAY[src],jsonb_build_object('status','ok','returned',source_returned,'total',coalesce(outcome->'total','null'::jsonb)));
    out_cont := jsonb_set(out_cont,ARRAY['sources',src],state);
    -- Per-source compare-and-swap: free late retries cannot rewind a newer pull.
    IF same_basis AND active_cont->'sources'->src IS NOT DISTINCT FROM r.attempt_sources->src THEN
      active_cont := jsonb_set(active_cont,ARRAY['sources',src],state); applied := array_append(applied,src);
    END IF;
  END LOOP;
  acquired := r.acquired_paper_ids;
  FOR fresh IN SELECT value FROM jsonb_array_elements(p_papers) LOOP
    IF jsonb_typeof(fresh->'provenance') IS DISTINCT FROM 'array' OR jsonb_array_length(fresh->'provenance')=0 THEN RAISE SQLSTATE 'PT400' USING MESSAGE = 'INVALID_PROVENANCE'; END IF;
    FOR provenance IN SELECT value FROM jsonb_array_elements(fresh->'provenance') LOOP
      src := provenance->>'source';
      IF src IS NULL OR NOT r.attempt_sources ? src OR p_source_results->src->>'status' IS DISTINCT FROM 'ok' OR (p_source_results->src->>'returned')::numeric<=0 THEN RAISE SQLSTATE 'PT400' USING MESSAGE = 'UNSUCCESSFUL_PAPER_SOURCE'; END IF;
    END LOOP;
    paper_id := public.research_upsert_paper(p_actor,s.id,r.id,fresh);
    IF NOT paper_id=ANY(acquired) THEN acquired := array_append(acquired,paper_id); END IF;
  END LOOP;
  -- All acquired rows are persisted, regardless of which will be displayed.
  SELECT coalesce(array_agg(DISTINCT public.research_resolve_paper(s.id,id)),ARRAY[]::uuid[]) INTO acquired FROM unnest(acquired) id;
  IF cardinality(applied)>0 THEN
    UPDATE public.research_sessions SET continuation=active_cont,row_version=row_version+1,updated_at=clock_timestamp() WHERE id=s.id RETURNING * INTO s;
  END IF;
  IF same_context THEN
    SELECT coalesce(array_agg(DISTINCT public.research_resolve_paper(s.id,a.paper_id)),ARRAY[]::uuid[]) INTO selected
      FROM unnest(coalesce(p_present_aliases,ARRAY[]::text[])) requested(alias)
      JOIN public.research_paper_aliases a ON a.session_id=s.id AND a.alias=requested.alias AND NOT a.ambiguous;
    IF EXISTS(SELECT 1 FROM unnest(selected) id WHERE NOT id=ANY(acquired)) THEN RAISE SQLSTATE 'PT400' USING MESSAGE = 'PAPER_NOT_ACQUIRED_BY_PULL'; END IF;
    response := public.present_research_papers(p_actor,s.id,s.row_version,s.context_revision,selected);
  ELSE
    response := jsonb_build_object('persisted',true,'presentedPaperIds',ARRAY[]::uuid[],'needsContextRefresh',true,'sessionVersion',s.row_version,'contextRevision',s.context_revision);
  END IF;
  response := response || jsonb_build_object('acquisitionSaved',true,'pullId',r.id,'continuationAppliedSources',applied);
  UPDATE public.research_retrievals SET source_progress=progress,output_continuation=out_cont,acquired_paper_ids=acquired,
    acquisition_status=public.research_acquisition_status(progress),execution_status='idle',lease_expires_at=NULL,attempt_finished_at=clock_timestamp(),
    attempt_result_hash=p_result_hash,attempt_result_snapshot=result_snapshot,receipt_version=receipt_version+1,response_snapshot=response,updated_at=clock_timestamp()
    WHERE id=r.id RETURNING * INTO r;
  RETURN public.research_receipt_reply(r,'committed');
END $$;

CREATE FUNCTION public.fail_research_pull(
  p_actor uuid,p_session uuid,p_pull uuid,p_attempt_token uuid,p_expected_receipt_version bigint,p_result_hash text,p_failure_code text
) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
DECLARE s public.research_sessions; r public.research_retrievals; progress jsonb; src text; snap jsonb;
BEGIN
  s := public.research_lock_session(p_actor,p_session); PERFORM public.research_check_hash(p_result_hash);
  IF p_failure_code IS NULL OR p_failure_code NOT IN ('UPSTREAM_FAILURE','TIMEOUT','PROCESSING_FAILURE','IDENTITY_CONFLICT') THEN RAISE SQLSTATE 'PT400' USING MESSAGE = 'INVALID_FAILURE_CODE'; END IF;
  SELECT * INTO r FROM public.research_retrievals WHERE id=p_pull AND session_id=s.id FOR UPDATE;
  IF NOT FOUND THEN RAISE SQLSTATE 'PT404' USING MESSAGE = 'PULL_NOT_FOUND'; END IF;
  snap := jsonb_build_object('failureCode',p_failure_code);
  IF r.execution_status='idle' AND r.attempt_token=p_attempt_token AND r.attempt_result_hash IS NOT NULL THEN
    IF r.attempt_result_hash IS DISTINCT FROM p_result_hash OR r.attempt_result_snapshot IS DISTINCT FROM snap THEN RAISE SQLSTATE 'PT409' USING MESSAGE = 'RESULT_KEY_REUSED'; END IF;
    RETURN public.research_receipt_reply(r,'replay');
  END IF;
  IF r.execution_status<>'running' OR r.attempt_token IS DISTINCT FROM p_attempt_token OR r.receipt_version IS DISTINCT FROM p_expected_receipt_version
    OR r.lease_expires_at<=clock_timestamp() THEN RAISE SQLSTATE 'PT409' USING MESSAGE = 'STALE_ATTEMPT'; END IF;
  progress := r.source_progress;
  FOR src IN SELECT jsonb_object_keys(r.attempt_sources) LOOP
    progress := jsonb_set(progress,ARRAY[src],jsonb_build_object('status','error','error','Source temporarily unavailable','returned',0,'total',NULL));
  END LOOP;
  UPDATE public.research_retrievals SET source_progress=progress,acquisition_status=public.research_acquisition_status(progress),execution_status='idle',lease_expires_at=NULL,
    attempt_finished_at=clock_timestamp(),attempt_result_hash=p_result_hash,attempt_result_snapshot=snap,receipt_version=receipt_version+1,updated_at=clock_timestamp(),
    response_snapshot=jsonb_build_object('persisted',true,'error',p_failure_code,'retryable',true,'acquisitionSaved',cardinality(acquired_paper_ids)>0)
    WHERE id=r.id RETURNING * INTO r;
  RETURN public.research_receipt_reply(r,'failed_attempt');
END $$;

CREATE FUNCTION public.update_research_paper(
  p_actor uuid,p_session uuid,p_paper uuid,p_expected_version bigint,p_action text,
  p_context_revision integer DEFAULT NULL,p_rejection_scope text DEFAULT 'context',p_reason text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
DECLARE s public.research_sessions; p public.research_session_papers; at_time timestamptz := clock_timestamp();
BEGIN
  s := public.research_lock_session(p_actor,p_session);
  SELECT * INTO p FROM public.research_session_papers WHERE id=p_paper AND session_id=s.id FOR UPDATE;
  IF NOT FOUND THEN RAISE SQLSTATE 'PT404' USING MESSAGE = 'PAPER_NOT_FOUND'; END IF;
  IF p.merged_into_id IS NOT NULL THEN RAISE SQLSTATE 'PT409' USING MESSAGE = 'PAPER_ID_MERGED'; END IF;
  IF p_expected_version IS DISTINCT FROM p.row_version THEN RAISE SQLSTATE 'PT409' USING MESSAGE = 'STALE_PAPER'; END IF;
  IF p_action IS NULL OR p_action NOT IN ('view','save','unsave','reject','undo_reject','cite','uncite') THEN RAISE SQLSTATE 'PT400' USING MESSAGE = 'INVALID_PAPER_ACTION'; END IF;
  IF p_action='reject' THEN
    IF p_rejection_scope IS NULL OR p_rejection_scope NOT IN ('context','session') THEN RAISE SQLSTATE 'PT400' USING MESSAGE = 'INVALID_REJECTION_SCOPE'; END IF;
    IF p_rejection_scope='context' AND p_context_revision IS DISTINCT FROM s.context_revision THEN RAISE SQLSTATE 'PT409' USING MESSAGE = 'STALE_CONTEXT'; END IF;
  END IF;
  UPDATE public.research_session_papers SET
    first_viewed_at=CASE WHEN p_action='view' THEN coalesce(first_viewed_at,at_time) ELSE first_viewed_at END,
    last_viewed_at=CASE WHEN p_action='view' THEN greatest(at_time,first_viewed_at) ELSE last_viewed_at END,
    saved_at=CASE WHEN p_action='save' THEN coalesce(saved_at,at_time) WHEN p_action='unsave' THEN NULL ELSE saved_at END,
    cited_at=CASE WHEN p_action='cite' THEN coalesce(cited_at,at_time) WHEN p_action='uncite' THEN NULL ELSE cited_at END,
    rejected_at=CASE WHEN p_action='reject' THEN at_time WHEN p_action='undo_reject' THEN NULL ELSE rejected_at END,
    rejection_scope=CASE WHEN p_action='reject' THEN p_rejection_scope WHEN p_action='undo_reject' THEN NULL ELSE rejection_scope END,
    rejected_revision=CASE WHEN p_action='reject' THEN CASE WHEN p_rejection_scope='context' THEN s.context_revision ELSE NULL END WHEN p_action='undo_reject' THEN NULL ELSE rejected_revision END,
    rejection_reason=CASE WHEN p_action='reject' THEN p_reason WHEN p_action='undo_reject' THEN NULL ELSE rejection_reason END,
    row_version=row_version+1 WHERE id=p.id RETURNING * INTO p;
  RETURN jsonb_build_object('persisted',true,'paper',to_jsonb(p));
END $$;

CREATE FUNCTION public.delete_research_session(p_actor uuid,p_session uuid,p_expected_version bigint) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
DECLARE s public.research_sessions;
BEGIN
  s := public.research_lock_session(p_actor,p_session);
  IF p_expected_version IS DISTINCT FROM s.row_version THEN RAISE SQLSTATE 'PT409' USING MESSAGE = 'STALE_VERSION'; END IF;
  -- Cascades only research data. Future financial evidence must NOT use this cascade.
  -- A late callback after deletion gets SESSION_NOT_FOUND and cannot recreate anything.
  DELETE FROM public.research_sessions WHERE id=s.id;
  RETURN jsonb_build_object('persisted',true,'deleted',true,'sessionId',s.id);
END $$;

-- Explicit privilege lockdown in the SAME transaction as function creation.
-- Exact names, not a wildcard: existing production functions are never altered.
DO $privileges$
DECLARE f regprocedure;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public.research_require_actor(uuid)'::regprocedure,
    'public.research_lock_session(uuid,uuid)'::regprocedure,
    'public.research_check_hash(text)'::regprocedure,
    'public.research_year(jsonb)'::regprocedure,
    'public.research_context(jsonb)'::regprocedure,
    'public.research_session_context(public.research_sessions)'::regprocedure,
    'public.research_check_sources(jsonb)'::regprocedure,
    'public.research_check_state(text,jsonb)'::regprocedure,
    'public.research_initial_continuation(text,integer,integer,jsonb)'::regprocedure,
    'public.research_check_continuation(jsonb,text,integer,integer,jsonb)'::regprocedure,
    'public.research_acquisition_status(jsonb)'::regprocedure,
    'public.research_receipt_reply(public.research_retrievals,text)'::regprocedure,
    'public.create_research_session(uuid,uuid,text,text,jsonb,text,text,jsonb)'::regprocedure,
    'public.update_research_session(uuid,uuid,bigint,jsonb,text,text,jsonb,boolean)'::regprocedure,
    'public.research_expire_attempt(uuid,uuid)'::regprocedure,
    'public.begin_research_pull(uuid,uuid,bigint,uuid,text,text,jsonb,text)'::regprocedure,
    'public.retry_failed_research_sources(uuid,uuid,uuid,bigint,uuid,text)'::regprocedure,
    'public.research_bib_identity(jsonb)'::regprocedure,
    'public.research_record_aliases(jsonb)'::regprocedure,
    'public.research_merge_metadata(jsonb,jsonb)'::regprocedure,
    'public.research_resolve_paper(uuid,uuid)'::regprocedure,
    'public.research_upsert_paper(uuid,uuid,uuid,jsonb)'::regprocedure,
    'public.research_word_string(text)'::regprocedure,
    'public.research_new_relevance(text,text,jsonb)'::regprocedure,
    'public.present_research_papers(uuid,uuid,bigint,integer,uuid[])'::regprocedure,
    'public.complete_research_pull(uuid,uuid,uuid,uuid,bigint,text,jsonb,jsonb,text[])'::regprocedure,
    'public.fail_research_pull(uuid,uuid,uuid,uuid,bigint,text,text)'::regprocedure,
    'public.update_research_paper(uuid,uuid,uuid,bigint,text,integer,text,text)'::regprocedure,
    'public.delete_research_session(uuid,uuid,bigint)'::regprocedure
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated',f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',f);
  END LOOP;
END $privileges$;
COMMIT;
