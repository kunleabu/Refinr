# Search by Idea retrieval (Phase 1)

Run deterministic tests with Node 24 and installed repository dependencies:

```sh
node --test tests/*.test.mjs
```

No test framework, AI API, account service, or network credentials are required. The existing package does not declare an ES module type; Node 24 detects the repository's existing ES modules and may emit a warning. Dependencies and unrelated package configuration are unchanged.

## Boundaries and extension contract

`lib/retrieval/sources.js` implements OpenAlex and Crossref adapters. Each accepts query, inclusive year bounds, page size, source-specific state, and an injected fetch implementation, then returns normalized papers, its own reported total, and continuation state (or null for exhaustion). `searchPapers` accepts an adapter map so institutional repositories can implement the same interface. Retrieval has no formatter or AI dependency.

`papers.js` contains normalization, reconciliation, identity, deterministic ranking and the CSL projection. `search.js` concurrently settles all adapters, preserves individual source failures, enforces years locally, merges and ranks. Each source request has a ten-second timeout. Both sources failing returns an explicit API 502; a successful empty source is distinguished from failure. Failed sources retain retryable state. The API handler formats canonical papers through the existing `formatSingle` pipeline and projects the existing frontend fields. Formatting is sequential to reuse the existing CSL cache. The formatter's existing fallback behavior is unchanged.

Only Search by Idea's frontend selection uses the new stable IDs. Its layout, authentication gate, two-credit charge and existing interactions are preserved.

## Canonical records and deduplication

Canonical papers retain structured authors, title, year, type, journal, DOI, URL, abstract, volume, issue, page, publisher, citation counts per source, source identifiers, provenance, and contributing normalized `sourceRecords`. Conflicting values remain inspectable in those source records. OpenAlex abstracts are reconstructed from `abstract_inverted_index`; Crossref JATS abstracts are reduced to plain text.

DOIs are trimmed, decoded, stripped of the DOI URL or `doi:` prefix, validated and lowercased. Valid suffix punctuation is preserved. Exact normalized DOI is the strongest identifier, regardless of metadata disagreements.

Without a shared DOI, merging requires an exact normalized title (Unicode normalization, case and whitespace only), year and the same ordered full author names. Missing year or incomplete names prevent fallback matching. No fuzzy title or author matching is performed. Conflicting nonempty DOIs are never merged. A DOI-less record matching multiple DOI records stays separate rather than bridging them.

Reconciliation is deterministic: DOI-bearing records are processed first; identity and source name break ties. Crossref is preferred for structured authors, work type, volume, issue, pages and publisher; empty bibliographic fields are filled from the other record. Existing nonempty fields are retained in this deterministic order, with every alternative preserved in `sourceRecords`. Citation counts are retained by source and use the maximum, never the sum, as supporting evidence.

IDs use `doi:<normalized DOI>` when available, otherwise a SHA-256-derived exact bibliographic key, otherwise a source-native ID (or deterministic metadata hash when a source has no ID). They do not depend on array position or randomness. Discovering a previously absent DOI can upgrade a bibliographic ID; Phase 2 should retain aliases using source identifiers/provenance when persisting session state.

## Ranking and totals

Ranking tokenization uses Unicode normalization, lowercasing and punctuation/hyphen separators, independently of conservative deduplication keys. A small grammatical stop-word list is removed from query/title/abstract; negations such as `not` and `no` remain. All-stop-word text falls back to its original tokens.

Unique query-token coverage contributes 1 for a title match, or 0.35 for an abstract-only match, averaged over query tokens. Contiguous informative bigram/trigram matches add phrase evidence: bigrams have weight 1 and trigrams weight 2; matched weight divided by possible weight gives phrase coverage separately for title and abstract. Primary relevance is `token coverage + 0.5 * title phrase coverage + 0.15 * abstract phrase coverage`. Repeated occurrences do not multiply evidence. This is a deterministic lexical signal, not a percentage or semantic confidence estimate.

Equal primary relevance is ordered by reciprocal native relevance ranks (`1 / (60 + rank)`, summed over distinct contributing sources using their best rank), then logarithmic citation support, then stable ID. Raw provider scores remain in provenance but are not compared across APIs. Native source results use relevance ordering, not citation sorting. No stemming, embeddings, AI, or NLP dependencies are used.

Each source retrieves up to 20 candidates per request. All merged candidates are returned, avoiding an unreturned tail when advancing source state. `total` is the number of unique papers in this returned batch; `totalIsExact: false` says it is not a global scholarly result count. Source-reported totals are separately available in `sourceStatus`. The frontend's existing count text now accurately describes retrieved unique papers.

## Continuation and Phase 2

The response contains a versioned `continuation` bound to the exact trimmed query and normalized year constraints. Send it unchanged with the same search to continue. The source map must include every active adapter, with no missing or extra entries; malformed cursor/offset states are rejected before any retrieval. OpenAlex uses a nonempty opaque cursor (bounded to 8192 characters); Crossref uses an integer relevance-search offset in the range 0–10,000. These models remain separate.

Automatic retry is the intended policy for temporary source failure. A failed source's requested state is preserved unchanged: `{}` means its initial request never succeeded; an existing cursor/offset means retry precisely that advanced page. Each adapter receives a copy so accidental mutation cannot corrupt the retained retry state. Only successful requests advance their source state. `null` means exhausted and remains exhausted across later requests; it is never interpreted as an initial request. OpenAlex returning the same next cursor is treated as a failed request rather than returning a replayed page. Crossref advances its offset by the number of rows actually returned, avoiding skipped records when a page is shorter than requested.

Public source failures always expose only `{status: "error", error: "Source temporarily unavailable"}`. Thrown messages, stack traces, credential-bearing URLs and internal network details are never serialized into source status, for either partial or total failures.

This remains stateless continuation, not a signed session token: callers must use the latest returned state unchanged. Replaying an older valid continuation can replay that page, and changing a structurally valid token cannot be detected without persistent/signed session state. Cross-page deduplication, seen/rejected/saved state and conversational controls remain Phase 2; within-page deduplication is implemented now.

## Known limitations

Exact fallback matching deliberately misses some duplicates with abbreviated authors or punctuation differences. OpenAlex display names are split deterministically into given/family names; culturally complex names can be imperfect, with Crossref's structured names preferred when available. Ranking is lexical and source-relevance based, not semantic interpretation. A year-constrained search excludes records with unknown year rather than inventing a date. The two upstream indexes differ in coverage and publication dates. Anonymous access works in the validated cloud instance, but upstream policies/rate limits may change. No automatic in-request retries or persistent response cache are included; retries occur only on a later continuation request. Live APA output exposed an inherited `&#38;` entity in an author separator from the shared formatter; that formatter is deliberately unchanged in this scoped work.

Core live smoke validation uses `NODE_USE_ENV_PROXY=1` in the Codex cloud environment, so Node fetch uses the supplied HTTPS proxy. This runtime setting is not an application secret.

## Validation in this cloud instance

- `node --test tests/*.test.mjs`: 21 passed, zero failed or skipped. Covers the requested deterministic cases, API contracts, concurrent adapters, continuation state, failure isolation, and frontend selection by identity.
- Live `machine learning education` search (2020–2024): both sources returned 20 records; the API returned 40 unique papers with nonempty APA references through the unchanged formatter and valid year bounds.
- A broader `Deep learning` (2015) probe successfully retrieved both sources but its extra overlap assertion failed because the two top candidate batches shared no works. This was an unsupported test assumption, not a retrieval or deduplication failure.
- A known-title query for `Games for Artificial Intelligence and Machine Learning Education: Review and Perspectives` (2020) returned 20 records per source and 39 canonical papers. The common DOI `10.1007/978-981-15-6747-6_7` merged with OpenAlex ID `https://openalex.org/W3086049162`, validating live cross-source reconciliation.
- Syntax checks and `git diff --check` passed. Excluded feature files, shared formatter, package manifest and deployment configuration have no changes. Pre-existing untracked `node_modules/` is installation output, not a new source change.


## Focused hardening validation

The focused Phase 1 hardening suite contains 31 passing tests (zero failed/skipped), including 10 added tests for phrase ranking, punctuation/hyphenation, title-vs-abstract weights, negation, repeated exhaustion, advanced-page retry with mutation isolation, malformed/query/year-bound continuation, native pagination advancement, repeated upstream cursors, and public API error sanitization. The prior concurrent-source test now expects Crossref to advance by the single mocked row actually returned rather than the requested page size.
