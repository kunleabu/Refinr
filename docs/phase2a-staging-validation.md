# Phase 2A isolated Supabase staging procedure and validation evidence

The original checklist remains authoritative. The final dated section records approved core database completion and local integration evidence; actual Auth/PostgREST/API/Vercel portions remain deferred. Do not interpret historical NOT RUN statements as overriding that dated evidence.

This document is a plan and manual checklist, not a request to run commands automatically. Architecture approval covers isolated validation only. STOP before creating/configuring any remote resource, applying SQL, making Auth users, modifying staging settings or deploying a preview until the human approves the specific staging target and action. No production credentials, users, data, Supabase project or Paystack behavior may be used. No new API function or billing model is authorized.

## 1. Safest practical isolation

Use a NEW, separate Supabase project dedicated to Refinr Phase 2A staging. Do not use production, a data clone, a preview pointed at production, or a production-linked Supabase CLI checkout. A separate project provides independent Auth users/JWT issuer, database, API keys and balances. Use a clear name such as `refinr-phase2a-staging`; record its non-secret project ref, region and dashboard URL in the run's evidence. Prefer the same PostgreSQL major version as the eventual target; do not assume the locally tested version matches.

For eventual API/Vercel tests, recommend a NEW dedicated staging Vercel project or a local staging-only server before a preview is approved. Do not inherit production environment variables. A preview in the existing production Vercel project is less safe because its shared/default variables can silently point at production. Preserve Node 24/maxDuration 30 and no more than the current 11 functions; do not change production configuration or add a function. No preview is deployed in this preparation step.

Exclude payments entirely. Do not supply PAYSTACK_SECRET_KEY, set up a webhook, trigger initialize/verify, use a production payment reference, or exercise the old page's pending-payment recovery. `api/paystack.js` hard-codes a production callback, so even Paystack test credentials are not sufficient isolation for that flow. Keep payment routes outside the staging test surface. No payment endpoint changes are required for research-only validation. Use direct API requests/new clean browser profile without production localStorage; never import `refinr-session`, `refinr-user` or `refinr-pending-ref` values from production.

## 2. Human setup and approval gates

Before remote action, the human must:

1. Approve creation/use of the separate project, who can access it, and deletion after testing. In Supabase Dashboard choose New project in the intended organization, enter a distinct staging name, select an isolated database password in the secure manager and an appropriate region, review plan/cost and wait for readiness. Do not select Restore/Clone or a production data branch. Create synthetic users only, e.g. accounts A and B owned by the testers. No real customer emails/research/papers are needed for deterministic fixtures.
2. Record the staging project ref/URL and an independently verified production project ref as a DO-NOT-USE identifier. No production secret is needed. Have two people, or one person with an independent dashboard check, verify the target differs from production and its URL ref matches the selected dashboard. If either identity is uncertain, STOP.
3. Configure staging credentials ONLY in its secure environment/secret manager, scoped to staging. Never paste values into chat, commit them, print JWT/key/connection values, put them in shell arguments/logs, or include them in evidence. Use secure temporary files/clients or a local harness whose process environment supplies values and masks diagnostics. Record names/presence and non-secret refs only.
4. Supply an approved SCHEMA-ONLY compatibility fixture for `profiles`, `credit_transactions`, `verification_history`, existing RLS/constraints and Auth profile trigger/`handle_new_user`/`handle_updated_at`. Use the already manually inspected schema, not a production connection or data export. No existing repository migration accurately captures these production-only functions; do not reconstruct unknown columns/policies by guesswork. Apply that fixture only to the new project, under its own explicit approval, before research migration tests. The research migration does not create or alter these baseline objects.
5. If the complete schema fixture is not available, the new project's built-in Auth is sufficient for a RESEARCH-ONLY subset. Mark signup/profile-trigger compatibility and credit-invariance tests BLOCKED, not passed because credit tables are absent. The whole checklist cannot be signed off until a synthetic baseline with the verified trigger behavior is available. This is a human setup prerequisite, not a reason to inspect/use production secrets.
6. Approve the exact candidate checksum and staging migration execution separately after the plan is reviewed. Later API integration/fixture instrumentation and staging preview creation each require their own approval. Stop at each gate.

### Environment variables eventually required

These are variable NAMES and uses, never requests for their values:

| Variable | Staging equivalent / rule |
| --- | --- |
| SUPABASE_URL | New project's URL; assert its ref equals approved staging ref and is not the production ref before any request. |
| SUPABASE_ANON_KEY | New project's anon JWT-compatible key for existing Auth request conventions; this is not a production key. |
| SUPABASE_SERVICE_KEY | New project's backend service_role JWT-compatible key for existing Authorization/apikey convention; server-only. Check its role works with SECURITY INVOKER/current_user guard via PostgREST. Do not assume a new-format key can be used as a bearer JWT without verifying compatibility. |
| SEARCH_BY_IDEA_SESSIONS_ENABLED | Proposed new server-only gate, staging-only true after integration approval; production remains disabled. Not implemented yet. |
| Approved staging ref / denied production ref | Non-secret validation inputs for a future staging harness/deployment check; choose explicit names there. No new app variable is currently required for these. |
| Staging Auth test credentials / bearer sessions | Synthetic A/B credentials managed outside repository and evidence. Expired/invalid tokens used only in tests. |
| Staging DB connection | Only if a separately approved migration/test tool needs it; secure connection belonging to the staging ref, never a production DATABASE_URL. Dashboard SQL Editor is the recommended initial migration path. |

Do not copy PAYSTACK_SECRET_KEY, GROQ_API_KEY, ANTHROPIC_API_KEY or JSONBIN_API_KEY into this isolated research environment. OpenAlex/Crossref retrieval needs no AI or Supabase credentials itself. Existing formatter style/locale fetches use public resources. No new secret is required for this layer.

## 3. Candidate, baseline and execution controls

Candidate: `supabase/migrations/20261007000100_research_sessions_phase2a.sql`.

It is byte-for-byte the final hardened review file. SHA-256:

`dcf0c4d3220e2f72da74d10728d9ae86eadb9764ad6a4d8e294894ffb245ac00`

Verify with `sha256sum supabase/migrations/20261007000100_research_sessions_phase2a.sql`. Do not edit it while applying. It creates exactly four public research tables, supporting indexes and 29 service-only functions; enables RLS without client policies; no authenticated SELECT/mutation/EXECUTE grant; fixed 45-second leases; logical pull and retry identity preserved. It does not create extensions, modify existing profile/credit/history objects/triggers, call scholarly APIs or debit credits. Plain CREATE deliberately conflicts if research objects already exist; do not rerun it blindly or replace existing objects to make it pass.

After approval, open SQL Editor in the VERIFIED NEW project's dashboard, reconfirm project ref/name and execute the FULL migration as one transaction. Do not use `supabase db push` from a production-linked checkout, automate project linking, or apply fragments from a copied chat response. Save success/failure and catalog evidence without secrets. If it fails, record the first error and verify rollback/no partial research objects, then STOP for diagnosis; do not remove BEGIN/COMMIT or add privileges casually.

Before application, save a stage-only baseline: table/constraint/index/RLS/policy definitions, function bodies/security/config/ACL for the named existing functions, their attached trigger definitions and balances/ledger rows after synthetic-user creation. Record existing research-object count (expected zero). After migration, compare this baseline: existing objects must be unchanged; only approved research objects may be new.

Read-only catalog checks in the APPROVED staging SQL Editor (never production):

```sql
SELECT tablename FROM pg_tables
WHERE schemaname='public' AND tablename LIKE 'research_%' ORDER BY tablename;

SELECT c.relname,c.relrowsecurity,c.relforcerowsecurity
FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE n.nspname='public' AND c.relname IN
 ('research_sessions','research_retrievals','research_session_papers','research_paper_aliases');

SELECT pol.polname,c.relname FROM pg_policy pol JOIN pg_class c ON c.oid=pol.polrelid
WHERE c.relname IN ('research_sessions','research_retrievals','research_session_papers','research_paper_aliases');

SELECT roles.role, tables.tbl,
 has_table_privilege(roles.role,'public.'||tables.tbl,'SELECT') AS can_select,
 has_table_privilege(roles.role,'public.'||tables.tbl,'INSERT') AS can_insert,
 has_table_privilege(roles.role,'public.'||tables.tbl,'UPDATE') AS can_update,
 has_table_privilege(roles.role,'public.'||tables.tbl,'DELETE') AS can_delete
FROM (VALUES ('anon'),('authenticated'),('service_role')) roles(role)
CROSS JOIN (VALUES ('research_sessions'),('research_retrievals'),('research_session_papers'),('research_paper_aliases')) tables(tbl);

SELECT p.oid::regprocedure AS signature,p.prosecdef,p.proconfig,
 has_function_privilege('authenticated',p.oid,'EXECUTE') AS authenticated_execute,
 has_function_privilege('anon',p.oid,'EXECUTE') AS anon_execute,
 has_function_privilege('service_role',p.oid,'EXECUTE') AS service_execute
FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
WHERE n.nspname='public' AND p.proname IN
 ('research_require_actor','research_lock_session','research_check_hash','research_year',
  'research_context','research_session_context','research_check_sources','research_check_state',
  'research_initial_continuation','research_check_continuation','research_acquisition_status',
  'research_receipt_reply','create_research_session','update_research_session','research_expire_attempt',
  'begin_research_pull','retry_failed_research_sources','research_bib_identity','research_record_aliases',
  'research_merge_metadata','research_resolve_paper','research_upsert_paper','research_word_string',
  'research_new_relevance','present_research_papers','complete_research_pull','fail_research_pull',
  'update_research_paper','delete_research_session') ORDER BY signature;
```

Pass: exactly the four named tables; RLS true; zero research client policies; all authenticated/anon table booleans false, all service booleans true; exactly 29 expected signatures, invoker (prosecdef=false), search_path=pg_catalog, authenticated/anon EXECUTE false, service true. Audit PUBLIC ACL too (no EXECUTE/table grant). Composite FKs reference UNIQUE(session_id,id); receipt partial unique running-pull index exists. Existing objects/trigger bodies/ACLs unchanged. FORCE RLS is not required: trusted service bypass is intentional; server ownership guards are mandatory.

## 4. Test transport and deterministic fixtures

Run DB/Auth/PostgREST checks BEFORE app-preview checks. Use a server-side/local trusted staging harness that validates the approved project ref before every request. NEVER reuse the LOCAL PostgreSQL bootstrap/test script against Supabase: its Auth table inserts/deletes and test-only deadline manipulation are local fixtures, not remote migrations. No live Supabase automation is implemented in this change.

For Auth: create two synthetic users A/B through the new project's Auth admin/dashboard (or approved staging signup); obtain sessions through its password login, verify each token with GET `/auth/v1/user` (staging anon apikey + bearer), and keep tokens private. Record only derived A/B UUIDs and outcomes. Email confirmation choices are confined to staging; if signup verification is enabled, complete it using tester-controlled addresses. Do not change production Auth settings. Profile credits of 5 are an expected baseline SIGNUP effect only if the approved schema fixture reproduces the verified trigger; take research credit snapshots AFTER signup.

For direct client denial, use PostgREST on the new project with anon apikey and A's bearer, then with anon only. For research mutations, invoke POST `/rest/v1/rpc/<approved_function>` using the stage-only service role from the trusted harness. Include actor derived from its verified user token, not arbitrary browser JSON. Service role intentionally CAN impersonate actors; API ownership safety is tested separately, not proved merely by granting a service key. SQL Editor runs as an admin, so it cannot substitute for PostgREST role tests.

All request UUIDs must be fresh except deliberate replay; hashes are SHA-256 of canonical semantic payloads, lowercase 64 hex, computed by the harness. Do not substitute one constant hash for different payloads. Track expected session row_version, context_revision, receipt_version and paper row_version from durable replies/reads. Keep immutable original callbacks for replay/stale tests.

Use separate sessions for synthetic fixture continuations and live source calls. Fixture basis: original idea/topic/query `learning in schools`, yearFrom 2019, yearTo 2021, Harvard style, source_config `{openalex:1,crossref:1}`. Initial continuation sources are `{}`; JSON null is exhausted. Example canonical paper for RPC completion:

```json
{
  "id":"doi:10.1234/stage-a", "doi":"10.1234/stage-a",
  "title":"Learning in schools", "year":2020,
  "authors":[{"given":"Jane","family":"Smith"}],
  "abstract":"School learning outcomes", "type":"article-journal",
  "identifiers":{"doi":"10.1234/stage-a","openalex":"https://openalex.org/W-STAGE-A"},
  "provenance":[{"source":"openalex","id":"https://openalex.org/W-STAGE-A","rank":1}],
  "citationCounts":{"openalex":10}, "sourceRecords":[]
}
```

These are synthetic identifiers, NEVER sent as a DOI lookup or cursor to real sources. Change IDs/metadata as specified for identity tests; Crossref records use its provenance/source IDs. Example success outcomes: OpenAlex `{"status":"ok","returned":1,"total":100,"continuation":{"cursor":"stage-cursor-1"}}`; Crossref `{"status":"ok","returned":1,"total":100,"continuation":{"offset":1}}`. A failed source is `{"status":"error"}` ONLY. Fixture cursors are confined to fixture adapter tests. Pass p_present_aliases for one acquired paper, but supply multiple canonical papers to prove undisplayed acquisition persistence.

Live source tests later use real query/year input through the future dispatcher with normal adapters. Failure injection requires approved server-only adapter/fetch fixtures in the future harness; never expose browser parameters that select faults, SQL targets or actor identity. Until integration exists, mark API/browser/Vercel stages NOT RUN, not passed from direct RPC evidence.

### Exact RPC request recipes (for the future approved staging harness)

This is documentation, NOT executed or a new API implementation. Only use after approval with the verified separate target. The harness must refuse any Supabase URL whose hostname is not exactly `<approved-staging-ref>.supabase.co`, and independently refuse the non-secret production ref. Do not follow redirects to another host. Supply secrets through its private environment, never command arguments. Use HTTP timeout/error handling and safe projections; a lost response requires a read/replay, not automatic new intent.

Transport: POST to the approved staging URL + `/rest/v1/rpc/` + the fixed RPC name, Content-Type application/json, apikey=staging service key and Authorization=Bearer staging service key. GET `/auth/v1/user` using staging anon apikey + synthetic user's bearer FIRST; successful response `id` is the only source of actor. For client-denial checks use that user's bearer/anon key instead, never service headers. Under direct PostgREST, PT409 maps to HTTP 409; table permission errors normally map to 401/403. The future API normalizes safe messages.

Use a canonical JSON SHA-256 helper (sorted object keys, fixed compact separators, UTF-8); normalize semantic fields before hashing. Hashes below mean a computed value, not a literal placeholder string. Use the same immutable body/hash on replay. Example sequence, with actor/session/pull UUID variables tracked from replies:

| RPC | Exact argument names/body recipe |
| --- | --- |
| create_research_session | p_actor=verified A UUID; p_creation_request_id=fresh UUID; p_creation_hash=hash(normalized creation intent); p_original_idea="learning in schools"; p_context={"topic":"learning in schools","yearFrom":2019,"yearTo":2021}; p_style="Harvard"; p_query="learning in schools"; p_source_config={"openalex":1,"crossref":1}. Store reply.session.id,row_version,context_revision. |
| update_research_session | p_actor; p_session; p_expected_version=current session row_version; p_patch={"population":"adults"} for a context-only change, or {"topic":"school learning outcomes","yearFrom":2020} for basis change; p_style="apa" only for style test; p_query optional compiled query; p_source_config optional. Omit fields not being changed. Read resulting session before next mutation. |
| begin_research_pull | p_actor; p_session; p_expected_version=current session version; p_request_id=fresh logical UUID; p_request_hash=hash(immutable acquisition intent); p_pull_kind="initial" (later "additional"); p_intent={"contextRevision":current revision,"purpose":"explicit acquisition"}; p_pipeline_version="phase1-v1". Store pullId,attemptToken,receiptVersion,sessionVersion,attemptSources privately. |
| complete_research_pull | p_actor; p_session; p_pull; p_attempt_token=stored private token; p_expected_receipt_version=attempt receipt version; p_result_hash=hash({sourceResults,papers,presentAliases}); p_source_results=outcomes for EXACTLY attempted sources; p_papers=ALL canonical records; p_present_aliases=[one acquired canonical id]. Keep the immutable result body for replay. Do not include a paper from a failed/not-attempted source. |
| retry_failed_research_sources | p_actor; p_session; p_pull=SAME logical UUID; p_expected_receipt_version=current persisted version; p_retry_request_id=fresh UUID; p_retry_hash=hash({pullId,operation:"retry"}). For changed-payload conflict test, change semantic retry intent/hash but reuse UUID. Receipt version remains a guard, not a new entitlement. |
| fail_research_pull | p_actor; p_session; p_pull; p_attempt_token; p_expected_receipt_version; p_result_hash=hash({failureCode:"TIMEOUT"}); p_failure_code="TIMEOUT" (or safe UPSTREAM_FAILURE/PROCESSING_FAILURE/IDENTITY_CONFLICT). Must target running unexpired current attempt; old token fails. |
| present_research_papers | p_actor; p_session; p_expected_version=current session version; p_context_revision=current revision; p_paper_ids=[existing owned immutable paper UUIDs]. This marks presentation, not view or acquisition. |
| update_research_paper | p_actor; p_session; p_paper=resolved UUID; p_expected_version=current paper version; p_action="view"/"save"/"reject"/"cite" etc.; p_context_revision=current revision; p_rejection_scope="context" or "session"; p_reason="synthetic explicit rejection". Omit optional rejection fields for other actions. |
| delete_research_session | p_actor; p_session; p_expected_version=current session version. Confirm cascades by service-owned read/catalog checks; do not delete a user/profile to simulate session deletion. |

Read recipes for the trusted harness/API: session reads filter `owner_id=verified_actor` AND `id=session_uuid`; child reads first establish that same ownership or use an equivalent owned-session join. Use explicit projections and finite limits/keyset paging. For evidence, owner-checked receipt reads include acquisition/execution status, receipt version, source_progress, input/output_continuation and acquired_paper_ids; internal token remains private. Read paper UUID,row_version,metadata,lifecycle fields and merged_into_id; resolve redirects before mutations. Do not permit the browser to specify PostgREST filters/RPC names/headers. After each intentional failure compare ALL pertinent before/after fields, not only HTTP status.

The initial create reply version is normally 0, revision 1; reservation increases the session version. Successful completion may increase it again when active continuation advances. Read returned values rather than hard-coding later expected versions. Partial completion normally turns receipt version 1 into 2; retry turns it into 3. Expiring a running receipt then reserving in the same retry call increments twice (1 -> 3) without requiring an extra client round trip. Database time/locks determine this, not browser clocks.

## 5. Checklist with pass criteria and retained failure state

For every row record PASS/FAIL/BLOCKED/NOT RUN, test IDs/request IDs, status/error code, before/after versions/source state and credit snapshot comparison. Do not log JWTs, service keys, internal execution tokens or full network error details. Internal tokens stay only in the private harness.

| ID / test | Exact operation / trigger | Pass criteria | State afterward, especially on intentional failure |
| --- | --- | --- | --- |
| S01 migration | Apply full candidate once in verified new project; run catalog/baseline checks above. | Four tables/29 functions, RLS and exact grants/indexes/FKs; no pre-existing object or credit changes. | Successful schema durable; any error rolls back transaction. Do not continue after unexplained failure. |
| S02 Auth/signup | Create A and B in staging; login and verify bearer via Auth user endpoint. | Different staging UUIDs; tokens accepted only by staging. Verified baseline trigger creates profile with 5 credits if fixture present. | Signup changes are setup effects; snapshot credits afterward. Missing baseline blocks credit/trigger compatibility, not silently passes it. |
| S03 service-role RPC | POST create_research_session using staging service role and verified A actor. | Success; current_user service_role guard works via actual PostgREST. No SECURITY DEFINER fallback needed. | Exactly one owned session; no credits/ledger mutation. Unexpected role/key incompatibility is a STOP condition. |
| S04 direct read denial | Authenticated A and anon GET each of four research tables; repeat even for A-owned rows. | No rows/data exposed; permission denied (HTTP 401/403 with 42501 where surfaced), all catalog privileges false. | No state change; owner status does not permit direct table reads. |
| S05 mutation/RPC denial | A/anon direct table POST/PATCH/DELETE and execute a research RPC; use disposable targets. | Every attempt denied; no client mutation/EXECUTE grant. | Sessions/receipts/papers/versions/credits unchanged. |
| S06 session ownership | Trusted service harness calls lock/update/delete with verified B actor targeting A session; later API B get/list/paper/pull operations on A IDs. | Mutations return SESSION_NOT_FOUND/404; API reads return 404 or omit A rows; no A data. | A session and every version/lifecycle/continuation unchanged. Direct service SELECT alone is NOT an ownership test. API subtest waits for integration. |
| S07 session creation/idempotency | Same creation_request_id + normalized body/hash twice, then different topic/body/hash with same key. | Same UUID on exact replay; changed payload PT409 IDEMPOTENCY_KEY_REUSED; UNIQUE(owner,request) enforced. | One session only; original idea/snapshot unchanged; no acquisition or credit action. |
| S08 context revision | Patch population/location, then query/topic/year/source basis; separately style-only update with expected current version. | Research patch increments context_revision; query/year/source changes reset continuation; style-only leaves revision/continuation intact and row_version advances. Population/location remain unverified context. | Existing acquired papers/lifecycle retained; no silent source acquisition or debit. |
| S09 optimistic concurrency | Reuse old session row_version for update/delete; old paper version for lifecycle mutation. | PT409 STALE_VERSION/STALE_PAPER; refetch required. | No field/version/lifecycle changes from rejected mutation. |
| S10 initial reservation | begin_research_pull once with initial kind, explicit UUID/hash/intent/expected version; immediately replay same request. | One pull UUID; first execute with private token, second in_progress without execution token; session version increments only for reservation. Lease approx 45s from DB reservation. | Durable running/pending receipt, no source HTTP yet, corpus/continuation unchanged; no billing. |
| S11 initial acquisition | Future API calls both sources concurrently; complete fixture outcome/papers via RPC first, live retrieval later. Persist two papers but select one for presentation. | One complete idle receipt; ALL acquired papers durable; only selected ID presented; stable UUIDs and provenance; legacy CSL formatter/year/style preserved. | Acquired corpus survives response/formatting failure; no per-display pull or charge. Live API part waits for implementation. |
| S12 partial failure both directions | Complete OpenAlex ok/Crossref error; separate session Crossref ok/OpenAlex error. | Valid successful-source papers durable, status partial/idle with safe source error; successful source advances/exhausts; failed source retains exact input. | Recoverable same logical pull; no whole-search data loss, no failed-source advance, no credit mutation. |
| S13 both sources unavailable | Complete with both statuses error or mark running attempt failed with safe TIMEOUT/UPSTREAM_FAILURE. | failed/idle receipt, no acquired papers, original source states intact; user sees source failure, not invented saved papers. | Retryable receipt is legitimately persisted; no corpus/presentation or credit change. If failure RPC itself fails, running receipt waits for expiry. |
| S14 continuation | New explicit additional pull from current active query/year/state; malformed/mismatched continuation rejected by server validators. Fixture adapter observes OA cursor and CR offset separately. | Advanced positions reused; exhausted null omitted; Crossref count uses raw adapter returned rows; query/year/source versions bound. | Invalid request produces no reservation/state advance. Additional pull only on explicit request; fixture tokens never hit real APIs. |
| S15 partial retry | retry_failed_research_sources on S12 pull with new retry UUID/hash/current receipt version; complete only failed source. | Same pull UUID, new attempt token/no, only failed native input fetched; previous successful/exhausted source not refetched. | Original acquired IDs/success/source state survive; one logical entitlement, credits unchanged. |
| S16 duplicate request/callback replay | Repeat original begin key/body and immutable completed callback/hash/token; repeat retry key before/after completion. Then change payload/hash under same key. | Exact replay creates no new pull/attempt/acquisition/presentation/HTTP; changed body returns 409. Older retry key returns current durable receipt without token. | Durable receipt/corpus/continuation unchanged on replay/conflict. Reusing an expired retry key does not renew execution; fresh key needed. |
| S17 two concurrent requests | Send two independent service/API requests at barrier for same initial UUID, then different UUIDs at same session version; separately two fresh retry UUIDs on an expired receipt. | Exactly one execute. Same UUID competitor replays; different initial UUID loses with conflict (stale/in-progress); different retry UUID loses with 409. One running row and no duplicate pull for original intent. | Winning state durable; loser cannot overwrite/advance/debit. Never accept two execute results. |
| S18 expired attempt | Leave reservation uncompleted; wait until DB lease_expires_at, then fresh retry key/current receipt version. Do NOT patch production/staging lease for this test. | Successful retry in one call; no expiry-version livelock; attempt_no+1, same pull. Incorrect expected version returns 409 without persisted expiry. | Prior progress/corpus/input retained; newly running receipt recoverable. SQL rollback also rolls back incidental expiry on rejected transaction. |
| S19 stale callbacks | After S18 allocate newer attempt; send old token/version to complete and fail. | STALE_ATTEMPT/409; newer token/status/version untouched. | No old-paper insert, state rewind, presentation or debit. |
| S20 context change mid-acquisition | Reserve, change topic/year (and separate population-only case), then complete old successful result. | Old acquisition SAVED to receipt/corpus; needsContextRefresh=true, API 409 acquisitionSaved=true, no stale-context discovery. Old query/year cannot advance active continuation. Population-only basis may preserve advancement but not presentation. | Both old receipt and new context remain valid; no automatic extra acquisition/charge. |
| S21 late retry vs newer pagination | Preserve failed receipt, advance same source through another explicit pull, then finish old retry from earlier input. | Historical receipt updates but per-source CAS does not rewind active session continuation; no incorrect first-page restart. | Corpus reconciles; active newer source position preserved; same original logical pull for retry. |
| S22 identity reconciliation | Identical DOI across providers; then same source native ID with metadata update; then exact normalized title/year/ordered FULL authors with different source IDs and no DOI. | One root UUID per true work; aliases/provenance/complementary metadata retained. Bibliographic normalization permits case/space equality only under full identity rules. | Existing lifecycle preserved; no array-position identity or fuzzy merging. |
| S23 identity conflict/ambiguity | Same title/authors/year but DIFFERENT non-null DOIs -> separate roots; strong source alias with conflicting DOI -> 409. No-DOI follow-up after ambiguous fallback; title/punctuation/year/author/order/incomplete-name variants. | Conflicting DOI roots never merge; ambiguity persists; fallback never merges incomplete/different full identities. Strong conflict rolls back entire completion/upsert. | Pre-existing roots/lifecycle unchanged on rollback; if completion conflict, mark attempt failed separately with IDENTITY_CONFLICT or recover after expiry; never advance its continuation without committed papers. |
| S24 identity upgrade/lifecycle | Acquire DOI-less source root; acquire distinct DOI root lacking full fallback data; set saved/viewed/rejected on one and cited on the other; bridge them with trusted source+DOI record. | Oldest UUID wins, losing UUID redirects, aliases move; saved/cited/rejected/view timestamps and explicit reason all survive. | No automatic unreject/unsave/uncite; older receipt IDs resolve to winner. Redirect mutation returns 409 PAPER_ID_MERGED, refetch before edit. |
| S25 Save/View/Reject/Cite | Explicit view/save/cite/reject (context and session scope), unsave/uncite/undo_reject with current versions; try NULL scope and stale context rejection. | Independent flags, paired view timestamps, explicit scope/revision; NULL rejected scope refused; stale context 409. Discovery presentation is not View. | Invalid action leaves all flags unchanged. Saved/cited/rejected excluded as new discoveries; still accessible in owned lists. No credit change. |
| S26 resurfacing | Present unsaved/unrejected work; meaningful context change with new title/abstract phrase, then unrelated/context-only change. Try rejected and saved/cited works too. | Previously seen work resurfaced only under new revision WITH deterministic new-query evidence; rejected never auto-resurfaces; saved/cited not new discoveries. | No duplicate presentation in same revision, no new source call/pull/debit for reranking; explicit undo required for rejection. |
| S27 deletion/cascades | Delete A session with current version including receipts, aliases and merged redirects; attempt late callback/retry/child read. | All session-specific research rows gone; late mutations 404, cannot resurrect; owner/profile/balance/ledger/history baseline unchanged. | No research leftovers or financial cascade. Account-deletion test, if run, uses only synthetic staging user; research cascades from auth.users. |
| S28 persistence outage/invalid completion | Block stage-only persistence transport AFTER reservation; separately send malformed callback/nonadvancing cursor/wrong offset/unsafe source debug field, then restore transport. | Visible persistence failure; no false persisted=true; invalid completion transaction rolls back all inserts/state changes. Read receipt to resolve uncertain transport outcome BEFORE refetching. | Reservation remains recoverable unless completion really committed. Inputs unchanged on rollback; no second logical entitlement, no credit effect. Fail separately if safe; otherwise expiry. |
| S29 Vercel timeout/cancellation | AFTER app preview approval: controlled server-only fault after reservation, force legitimate invocation to reach unchanged <=30s limit; also browser disconnect and transport loss around commit. Read receipt, wait actual 45s lease if still running, fresh retry same pull; send late old callback. | Invocation limit not extended; running/idle state resolved by owner read; no takeover while legitimate request/live SQL lock holds; recovered same pull, stale callback fenced. Actual SQL cancellation/lock release observed and bounded, not assumed from browser abort. | May retain running/pending or committed partial/full acquisition. Never claim a timed-out transport proves rollback. If SQL locks persist unbounded, FAIL/STOP and diagnose before production; no silent duplicated acquisition or debit. |
| S30 credits/integration compatibility | After A/B setup, snapshot profile credits, exact credit_transactions/verification_history rows and baseline function/trigger definitions; compare after EVERY research test including failures/delete. | Byte-equivalent relevant baseline rows/balances and definitions; zero `/api/credits`/Paystack requests from new research actions; no production resources contacted. | No research mutation/debit/credit/history entry. The old UI deducts two credits by design and is NOT a zero-credit research validation path; test legacy separately only on synthetic balances. |
| S31 legacy endpoint/formatter | After integration, call POST with NO action; run existing 31 Phase 1 tests unchanged, inspect normal year/style/IDs/partial status response. | Legacy response/status/formatter behavior preserved; new bearer requirement applies only to explicit actions. Unknown action 400 without fallthrough. | No unintended changes to payments/auth/Deep Dive/verification/lookup; legacy existing credit behavior retained. |

## 6. Failure-safety invariant and evidence

A failed external operation may leave a recoverable receipt/state, but must never falsely report persistence, advance continuation incorrectly, corrupt a session, duplicate acquisition entitlement, or affect credits.

Distinguish three outcomes: (a) DB rejection/confirmed rollback: do not claim that mutation persisted; (b) transport timeout after possible commit: report outcome unknown, read/replay by immutable identity before retrying; (c) committed acquisition plus stale context/formatting failure: say acquisitionSaved=true only when verified, keep corpus, avoid stale discovery. A receipt being saved does not mean nonexistent acquired papers were saved. Same-source retries are technical attempts on the SAME pull, not new financial entitlements. No actual charge/ledger idempotency is introduced by this phase.

Use a private evidence sheet for S01–S31 with non-secret staging target, migration hash, versions/UUIDs, expected vs actual durable state and failure condition. Include before/after logical pull counts, attempted-source inputs/outputs, root/redirect counts and synthetic credit hashes. Keep secret/internal-token material out of reports. Do not describe blocked or unrun API/Vercel checks as passed from PostgreSQL tests.

## 7. Exit/stop rules

The preserved LOCAL suite proves 25 PostgreSQL behaviors; 31 Phase 1 tests and 16 static checks are separate. Supabase staging results are currently NOT RUN. Stop on unexpected privilege, owner leak, multiple execution leases, credit mutation, production URL/contact, migration drift or unbounded lock recovery. Do not fix staging by broadening authenticated grants or altering production objects.

Before implementation, review this plan and preserved files. Before remote modification, explicitly approve the named separate staging target, schema-only compatibility baseline and exact candidate. Before API preview tests, approve the dispatcher implementation/test-only fixture mechanism and isolated preview. Before production, require all evidence reviewed and separate deployment/migration/billing-compatibility decisions. Nothing in this document authorizes a remote action now.

## Preparation verification (local only)

On 2026-10-07, the permanent `./tests/postgres/run-local.sh` was exercised end to end: pinned PostgreSQL 16.15 image, clean local bootstrap, full candidate migration, 16 passing static checks and 25 passing database tests. Its container/database/temporary virtualenv were removed by its exit trap. Existing `node --test tests/*.test.mjs` passed all 31 tests (zero failed/skipped). Test-method AST comparison confirms all 25 review test bodies are preserved exactly. Migration byte comparison and SHA-256 confirm no reviewed SQL change. Shell syntax/Python compilation and whitespace checks passed.

No Supabase/Auth/PostgREST/Vercel checklist action was executed. Only local test tooling/packages/image were used. Application code, existing tests, package manifests, production objects and runtime/payment configuration were not changed. Files remain uncommitted for review; no remote push/merge/deployment was made.

## Integration implementation evidence — 2026-10-09

The approved core database staging run on `rqwtphusjztwtlbmkmgf` passed the applicable S02–S28 database behaviors, including actual 45-second expiry and independent concurrency. All test-created research fixtures were deleted; managed Auth users A (`<STAGING_USER_A_UUID>`) and B (`<STAGING_USER_B_UUID>`) were retained for human-managed removal/next validation. S02 only proved supplied identity existence; S03–S05 used transaction-local database roles, not real HTTP Auth/PostgREST. API/live retrieval/transport failure/Vercel/legacy-credit portions were not passed by that run. The final migration checksum remains the approved value above.

The previously missing action dispatcher is now implemented locally behind the production-off gate, using only the existing API file and approved RPCs. See `phase2a-integration-plan.md` for concrete request fields/response policy and runtime bounds. No remote tests or credential/key retrieval were performed during implementation. The existing local-only PostgreSQL runner remains local-only and unchanged.

Before the next remote stage, approve an isolated local/staging API environment and securely configure its staging-only SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SERVICE_KEY. Independently verify its hostname/project ref, set SUPABASE_PROJECT_ID to the approved staging ref, and enable the session gate there only. Do not use production Vercel or inherit production variables. Never print the values. Obtain A/B test sessions through managed staging Auth, verify both through /auth/v1/user, then execute the actual S03–S05 PostgREST boundary checks before authenticated route isolation.

For real route isolation, A creates sessions and papers through approved actions; B attempts session.get/update/delete, pull.get/acquire/retry, papers.list/present and paper.update on A IDs. B session.list must omit A sessions. Expect 404 and unchanged A state. Verify missing/invalid/expired bearers, forged identity fields, cross-session paper/pull IDs and stale versions. Use same request IDs on replay and fresh retry IDs only for genuine technical retries. Acquisition inputs/fault fixtures must remain server-controlled; real source/preview/fault-injection execution requires its separate approval. No fault switch is accepted in browser payloads.

Re-run S10–S28 application portions for actual RPC transport, replay after uncertain responses, full canonical persistence before formatting, partial source status, stale-context acquisitionSaved responses and corpus-only presentation. S29 requires an approved isolated Vercel environment and remains deferred. S30 remains blocked by intentionally absent verified legacy profile/credit fixtures; do not create guessed fixtures or claim credit invariance from their absence. S31's existing local regressions are preserved; actual integrated legacy charging/endpoint validation remains a separate stage.

Implementation tests use only mocked network responses, no Auth credentials or managed-user mutation. Database behavioral evidence and these mocked tests do not replace the real Auth/API boundary tests.

Local integration verification: **82/82 Node tests passed**, comprising the unchanged 31 Phase 1 regressions and 51 new Phase 2A checks (50 research tests plus one route-dispatch test), with zero skipped/failed. The 16 static migration checks and SQL/PLpgSQL parsing passed. Frozen migration fingerprint, original legacy handler and original endpoint-test bodies were verified unchanged. These are local mocked outcomes only, not new remote staging Auth/API passes. The existing local PostgreSQL suite was preserved and not pointed at staging.
