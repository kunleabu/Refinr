# Phase 2A integration plan and implementation evidence

The original design sections below are retained for review history. The implemented contract and current validation status are recorded in the dated implementation section at the end; remote Auth/API validation remains deferred.

## Inspected current behavior

`api/searchbyidea.js` currently handles one POST shape: idea, format (Harvard default), yearFrom/yearTo and optional continuation. It has NO action dispatcher or bearer verification yet. It validates with `validateSearch`, calls deterministic `searchPapers`, returns 502 when both sources fail, and formats sequentially through `formatSingle(toCSL(...))`. It returns canonical Phase 1 IDs and safe source statuses. Keep this entire no-action response path compatible.

`lib/retrieval/search.js` concurrently settles adapters, preserves failed inputs, skips exhausted sources and normalizes/merges/ranks before presentation. It returns full query/year-bound continuation and per-source returned counts. Those counts are before local year filtering and deduplication. `sources.js` uses separate OpenAlex cursors/Crossref offsets and 10-second external-fetch timeouts. No Supabase or AI dependency belongs in these modules.

`api/auth.js` and `api/credits.js` verify bearer tokens with Supabase `/auth/v1/user`; environment names are SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SERVICE_KEY. Use the same verification protocol in a new isolated research auth helper, without changing either endpoint. Verify successful HTTP status and a valid user UUID; do not merely decode a JWT or accept browser user_id/actor/owner.

`index.html` holds `currentSession.access_token`, but its existing `searchByIdea` deducts TWO credits via `/api/credits` BEFORE a legacy search, then calls `/api/searchbyidea` without Authorization. Leave that legacy path and current credit model untouched. Persistent staging validation uses direct authenticated research API actions, not this legacy button. No future 3+1 pricing is implemented. Enabling new persistent acquisition in production and deciding how the existing charge attaches to it is a separate rollout decision; do not silently turn on a new free production acquisition path.

`vercel.json` includes `lib/**` and has maxDuration 30 seconds. There are 11 deployed functions including ratelimit; do not add a file under `api/` or change this configuration. `api/paystack.js` has a hard-coded production callback URL. Do not exercise payments in staging; changing that unrelated endpoint is not part of Phase 2A.

## Proposed modules and dispatch (future work only)

Extend the existing `api/searchbyidea.js` with an explicit allowlisted dispatcher before the legacy body destructuring. Missing `action` invokes the existing legacy code. Unknown action returns 400 without acquisition; a disabled session path returns 503 without falling back to legacy. A proposed server-only SEARCH_BY_IDEA_SESSIONS_ENABLED gate remains off in production; no such variable or gate is implemented in this change.

Place reusable code under `lib/research/`, for example:

- `auth.js`: bearer extraction, bounded `/auth/v1/user` verification, immutable actor derivation.
- `repository.js`: service-role RPC transport, owner-filtered read queries, payload projections, fixed safe error mapping. No arbitrary caller-provided table/filter/RPC name. Derive p_actor server-side for EVERY mutation. For reads, include owner_id in session SELECTs and verify/join owned session before selecting children; service role bypasses RLS and therefore cannot rely on RLS for ownership.
- `orchestration.js`: validate/normalize action inputs, SHA-256 canonical intent hashing, short RPC reservation -> external retrieval -> short completion transaction. Inject adapters/clock/fetch for deterministic tests; never accept a production client-controlled failure/adapter/timeout flag.
- `presentation.js`: corpus-only rank/filter/page selection, UUID redirect resolution and existing CSL formatter integration. Suppression/lifecycle/session concerns wrap Phase 1 core, not contaminate it.

| Proposed POST action | API work / database operation |
| --- | --- |
| session.create | Verify actor, normalize idea/context/style/source config, derive immutable creation snapshot/hash; create_research_session. No external acquisition merely to create a session. |
| session.list / session.get | Actor-scoped reads; keyset page lists; explicit safe projection. No new read RPC is needed, and no client table privilege is needed. |
| session.update | Expected session row_version; update_research_session. Original idea/owner immutable; style-only preserves context/continuation; query/year/source version change resets continuation; research changes increment revision. |
| session.delete | Owner and expected version; delete_research_session. No credit or payment call. |
| pull.acquire | Owned session/current basis plus explicit request UUID/intent/expected session version; begin_research_pull, retrieve ONLY on execute, then complete/fail. No request/page-based billing. |
| pull.retry | Existing owned pull and new retry UUID/hash/expected receipt version; retry_failed_research_sources. Same pull, only unfinished source inputs. |
| pull.get | Owner-checked receipt read/status projection; no execution token, lease secrets, internal result/debug snapshot or mutation. |
| papers.list | Owner-checked acquired corpus, saved/cited/rejected views, stable UUID/keyset pagination. Back/style/local filters do not create new pull rows or refetch sources. |
| papers.present | Expected session version/context revision plus server-selected acquired IDs; present_research_papers marks discovery presentation and enforces suppression/new-relevance guard. |
| paper.update | Expected paper version and explicit view/save/unsave/reject/undo_reject/cite/uncite; update_research_paper. Never infer View from discovery presentation. |

Browser requests may supply operation IDs, session/paper UUIDs, expected versions and user-editable constraints. They must NOT supply trusted actor, owner, lease/attempt token, source progress or authoritative continuation. Reject actor/owner fields rather than accidentally passing them through. Fetch authoritative basis/continuation in server reads/RPC receipts. Source configuration and pipeline version come from the server adapter registry.

Hash canonical semantic operation payloads on the server with SHA-256 (lowercase 64-character hex). Include target session/pull and submitted immutable intent/context target in that payload; volatile attempt tokens or returned source errors are not intent. Use deterministic sorted-key encoding. The same key/body must replay across technical HTTP retries, rather than hashing new mutable server timestamps. Changed payload under the same key must conflict. A receipt version is a concurrency guard, not an entitlement identity; retry hashes bind the existing pull and retry operation, not a new acquisition. Tests must cover changed expected context/intent reusing the original key.

## Acquisition/persistence order

1. Require enabled session path, validate an allowlisted action/body and bearer, call staging/production-configured Supabase Auth to get the actor. All abort/deadline handling begins at request entry.
2. Read the owned session and validate client expected context/version. Reserve the logical pull through its RPC. Close the transaction before any OpenAlex/Crossref HTTP request. Keep attempt token internal.
3. For execute, project the authoritative full continuation to exactly `attemptSources` and construct the same subset of the adapter registry. Call existing `searchPapers` with the immutable receipt query/year bounds. Failed sources preserve original state; exhausted/successful sources must not be reset or falsely relabeled to bypass validation.
4. Translate Phase 1 output into RPC source outcomes. Error outcomes are ONLY `{status:'error'}`; successful outcomes have status, returned, total and native continuation. Strip thrown errors. Pass canonical papers before the current handler's authors-to-display-strings conversion, retaining identifiers, provenance, structured authors and sourceRecords. Persist EVERY acquired canonical paper, not only the displayed page. Initial attempt <=40 source records (20 per source) is a useful bounded batch; validate metadata/body size too.
5. Complete atomically using pull/token/expected receipt version and immutable result hash/snapshot. Completion resolves aliases, persists all acquisition, reconciles source state and then guards presentation. The database owns source compare-and-swap; never overwrite its returned continuation with client/local state. On transactional failure, all changes from that completion roll back. If still within the lease, call fail_research_pull separately with a safe code; if failure marking cannot persist, report the persistence error and leave recovery to expiry. Never invent persisted=true.
6. Build responses from committed UUID rows/receipt and safe projections. Format through the existing `formatSingle(toCSL(...), style)` using session style, never a second citation formatter. Formatting occurs after acquisition persistence, outside SQL; formatting failure is explicitly marked, and the already acquired corpus stays saved. Discovery-presented papers are distinct from viewed papers. Replaying a receipt must not call present again and fabricate new discoveries; read already acquired rows for an explicit replay/back request.
7. On complete with needsContextRefresh=true, return HTTP 409 with acquisitionSaved=true and no stale-context discovery presentation. That is successful acquisition persistence plus a context conflict, NOT an unsaved-state claim. Refetch current session and locally rerank existing corpus; only explicit acquire may make a new pull. If continuation cannot apply to the current basis, historical receipt output stays historical. If the completion response is lost, retry the same immutable completion internally or read its receipt before deciding whether failure marking is appropriate; do not mark a committed acquisition failed or reacquire it.

Response policy: newly persisted mutations return persisted=true only after an acknowledged successful transaction. Reads may report actual durable state but must not imply an unconfirmed mutation succeeded. Unknown 5xx database/network details map to a generic visible persistence error; allowlist PT400/PT401/PT404/PT409 codes/messages. Conflict refresh must be explicit. Do not expose execution tokens/attempt inputs as instructions to the browser. Internal execute/in_progress/replay disposition determines whether external HTTP is allowed, not a frontend guess.

## Runtime/recovery

Keep maxDuration 30. Keep the reviewed fixed 45-second database lease; no heartbeat/renewal/background worker. At request entry allocate bounded Auth/reservation/retrieval/commit/presentation work within a <=25-second application deadline, leaving >=5 seconds for failure handling/response. This is a proposed budget to verify in staging, not a runtime configuration change. Compose the existing 10-second source timeouts with the remaining request deadline through injected fetch; do not increase source/runtime duration. Bound database statement execution and batch size so a killed invocation cannot indefinitely retain its session lock. Browser disconnect does not prove Vercel cancellation or SQL rollback; verify it.

A killed invocation can leave running/pending or partially acquired durable state, recoverable after expiry with a FRESH retry UUID on the same pull. Replaying an old used retry key never reacquires execution; it returns the current durable receipt. A newer attempt fences late old callbacks by token/version. No held SQL transaction spans scholarly HTTP. Client-visible transport timeout must say outcome unknown until an owner-scoped read resolves it; it is not proof of failure.

## Implementation gates after staging-plan approval

1. Human provisions separately isolated Supabase and schema-only compatibility fixture; approve its non-secret project identity before remote mutation.
2. Explicitly approve staging migration execution and run database/Auth/PostgREST checklist stages only.
3. Implement/test dispatcher/modules on a review branch without another API function, preserving all 31 Phase 1 tests and local database tests. Add mocked bearer/owner/read/concurrency/error/credit-invariance orchestration tests.
4. Obtain separate approval for a dedicated staging-only app preview and test-only server fixture injection, then execute integrated API/timeout checklist stages. No test-only switches accepted in browser payloads and none enabled in production.
5. Review evidence and unresolved staging failures. Production migration/enablement, legacy credit integration and any deployment/merge require separate authorization. New 3+1 billing, AI/session conversation/angles, homepage changes and aesthetic redesign remain excluded.

## Implemented integration — 2026-10-09, local verification only

The four-table migration/RPC contracts remain frozen. Core isolated staging database S02–S28 behavior was approved before this implementation; database-role simulation does not prove Auth/PostgREST or application ownership. No remote HTTP-boundary/API test has been performed during implementation.

`api/searchbyidea.js` now dispatches explicit actions to `lib/research/orchestration.js`. Its missing-action legacy body is unchanged, including the existing CSL formatter and response shape. `index.html` and its two-credit deduction are unchanged. `SEARCH_BY_IDEA_SESSIONS_ENABLED` must be exactly `true`; production Vercel deployments always refuse session actions, even if that flag is set. A production Node environment without a Vercel environment marker is also refused. Disabled actions return 503, unknown/explicit-null actions return 400, and neither falls through to legacy search. This is staging/review integration, not production enablement or a new charging path.

### Implemented request contract

All bodies contain `action`. Session actions require a bearer token verified by `/auth/v1/user`; UUID actor comes exclusively from that response. Server configuration uses the existing Supabase URL/anon/service variable names. If `SUPABASE_PROJECT_ID` is present it must agree with the configured URL. No client actor/owner/user identity, execution token, source config or continuation is accepted.

| Action | Body fields besides action | Persistence |
| --- | --- | --- |
| session.create | requestId, idea; optional context, format | create_research_session; no retrieval |
| session.list | optional after, limit | owner-filtered ID-keyset list |
| session.get | sessionId | owner-filtered session read |
| session.update | sessionId, expectedVersion; optional patch, format, query, archived | update_research_session |
| session.delete | sessionId, expectedVersion | delete_research_session |
| pull.get | sessionId, pullId | owned-session receipt read; safe projection |
| pull.acquire | sessionId, requestId, expectedVersion, contextRevision; optional pullKind (initial/additional), limit | begin_research_pull → Phase 1 → complete/fail |
| pull.retry | sessionId, pullId, requestId, expectedReceiptVersion; optional limit | retry_failed_research_sources → exactly authorized sources → complete/fail |
| papers.list | sessionId; optional after, limit, state (all/saved/cited/rejected/viewed) | owned corpus read; no presentation/view mutation |
| papers.present | sessionId, expectedVersion, contextRevision; optional paperIds, limit | server eligibility/ranking then present_research_papers |
| paper.update | sessionId, paperId, expectedVersion, operation; optional contextRevision, rejectionScope, reason | update_research_paper; operations view/save/unsave/reject/undo_reject/cite/uncite |

Context/patch fields are topic, yearFrom/yearTo, population, location, selectedAngle, exclusions and extraConstraints. They are stored context, not AI interpretations or guarantees that source metadata satisfies population/location. Context-scoped rejection requires the current contextRevision. Source config `{openalex:1,crossref:1}` and pipeline `phase1-v1` are server-owned. Expected versions are nonnegative safe integers; context/receipt revisions are positive. Read lists default to 20, maximum 40. Presentation/acquisition display limit defaults to 10, maximum 10. Lists return `next` UUID; explicit paper IDs allow presenting later corpus pages without retrieval. Default presentation considers a bounded first corpus page, not the entire growing session corpus. No frontend is connected yet.

Creation hashes normalize intent and defaults. Pull/retry hashes bind target, immutable submitted context/kind and display limit, excluding the expected row/receipt version used as a transport concurrency guard. Replays with old expected versions are resolved by the RPC rather than pre-rejected. A new acquisition's context revision is checked before reservation; the RPC's expected session version closes the read/reservation race. Changing semantic intent under a used key conflicts. Original keys are reused for technical HTTP replay; a fresh retry requestId is required to acquire a recovery attempt after expiry.

The repository has an exact RPC allowlist and unconditionally supplies verified p_actor. All child reads establish session ownership before querying with session_id. Owner, creation snapshots/hashes, attempt tokens, retry registries and internal callback snapshots are omitted from public responses. UUID redirects resolve only within the owned session; mutating an obsolete redirect keeps the frozen RPC's PAPER_ID_MERGED behavior.

### Acquisition, failure and runtime behavior

Reservation acknowledgement is required before scholarly HTTP. An execute receipt projects its native attemptSources to the matching Phase 1 adapters; successful/exhausted sources cannot be reset on retry. Source outcome counts remain pre-deduplication/filter counts, error outcomes contain only status. The entire canonical batch (maximum 40 papers / 2 MB) is persisted before display formatting; only requested presentation aliases are marked. Stable API paper IDs are session-paper UUIDs, with canonicalKey retained. Existing formatSingle/toCSL handle citations after persistence; bounded formatting failure yields formattingError and keeps the corpus intact.

Mutation success reports persisted only after acknowledgement or verified durable receipt reconciliation. Lost reservation acknowledgement never starts retrieval; read/replay resolves its receipt without handing an execution token to the browser. Lost completion acknowledgement checks the stored result hash before claiming success, and never blindly reacquires or marks an uncertain completion failed. A confirmed completion rejection may separately fail the current token/version; failure-marking outage leaves lease recovery intact. Post-commit read failure reports outcomeUnknown with pullId, never invokes failure marking. Acknowledged presentation followed by read failure reports presentationSaved/persisted, without fabricating displayed papers.

Validation/auth/not-found/conflicts map to 400/401/404/409; authentication transport outage is 503, not a false invalid-token verdict. In-progress replay is 202. Partial acquisition is usable 200. A durably acknowledged both-source failure is 502 with an empty paper list; processing/expired-attempt receipts retain their distinct safe 503 retryable errors. Stale-context acquisition returns 409 with acquisitionSaved:true and no stale discovery. All unknown persistence/internal details use safe generic errors; raw PostgreSQL messages/hints and network credentials are never returned.

The implementation uses a 23-second work deadline, a separate 28-second persistence/recovery deadline, bounded four-second Auth/PostgREST requests, unchanged native source ten-second timeouts composed with the work deadline, and bounded citation formatting. Vercel remains maxDuration 30, the DB lease remains 45 seconds, and no heartbeat/background work was introduced. HTTP abort does not establish server-side SQL cancellation: real lock/cancellation behavior still needs the separately approved staging API/Vercel test. The client cannot impose a new DB statement timeout by changing the frozen schema; existing PostgREST/server statement limits must be verified during that stage.

No DB objects, production configuration, credit/payment code, frontend or Phase 1 retrieval module changed. Local mocked tests include full Auth → repository → real Phase 1 adapters → completion → formatter wiring, plus A/B isolation, replays, concurrency dispositions, source failures, persistence uncertainty, safe errors and lifecycle presentation. Real A/B Auth/PostgREST and staging API validation remain separate approval gates. Future 3+1 billing, conversational refinement, angle generation, AI, UI work and production rollout remain deferred.

Local verification result: `node --test tests/*.test.mjs` passed **82/82** (31 unchanged Phase 1 tests plus 51 new Phase 2A tests: 50 research-module tests and one added endpoint-dispatch test). Zero failures/skips. The 16 database-free migration checks and SQL/PLpgSQL parsing also passed. The migration SHA-256 is unchanged; an exact prefix comparison preserves all five original endpoint test bodies, and removing only the added action dispatch/import recovers the original handler byte-for-byte. Whitespace/diff checks passed. The unchanged local 25-test PostgreSQL runner was not rerun for this application-only change; no database schema/RPC was changed. Work remains uncommitted on `feature/search-by-idea-v2-phase1` for review; no push, merge or deployment occurred.
