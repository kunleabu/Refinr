# UI/UX Iteration 1 implementation and local validation

Date: 2026-10-22. Branch: `feature/search-by-idea-v2-phase1`.
Starting HEAD: `58f4ae2d005e8a08f5ad3936dcbc17fb0270793d`; working tree was clean before implementation. Both `phase2a-staging-validation.md` and `ui-ux-iteration-1-spec.md` were read before editing `index.html`. The latter specification and existing application code governed implementation.

## Intentional experience changes

- Research-question front door, with References, DOI / Title and PDF routes into existing tools. References focuses the existing workspace, which remains available below the front door.
- Explore preserves the question in page memory through sign-in, signup and failed-auth retries, then populates the existing Search by Idea form. The user still chooses Search explicitly; Explore and authentication do not initiate retrieval or deduct credits. Cancelling auth clears the pending action while leaving the question in the front-door field.
- Search by Idea is no longer an equally weighted reference-workspace button. Its year/style controls, legacy request contract, 2-credit debit, original-source links and selected-papers-to-references bridge remain.
- Compact Refinr R/REFINR lockup, restrained night-sky front door, shared surface/color tokens, calmer research surfaces and responsive controls. No prototype override stack was imported.
- Anonymous credit bar is hidden. Authenticated balances, account controls and purchasing entry remain available.
- PDF-only public upload copy and picker; unsupported Word files remain rejected. PDF extraction, style detection, verification and Deep Dive machinery remain.
- Visible Copy/Share labels, native paper-selection checkboxes, keyboard-accessible account/PDF controls, dialog naming/focus loop/Escape/restoration, and reduced-motion handling for effects, demo delays and scripted scrolling.
- Shared reports move to the first content position without an auth wall. Share copy explicitly explains public accessibility and lack of expiry/revocation.

## Automated results

| Check | Result |
| --- | --- |
| `node --test tests/*.test.mjs` | 108 passed, zero failures/skips |
| `./tests/postgres/run-local.sh` | 16 migration static checks and all 25 PostgreSQL behavioral tests passed; disposable local database/container cleaned up |
| `node tests/browser/iteration1.cjs` | 143 offline Chromium assertions passed across journeys A–H |
| JavaScript syntax | All API/library/test files and inline page scripts parsed successfully |
| Static HTML IDs | No duplicate static element IDs |
| Shell/Python syntax | Local runner shell syntax and PostgreSQL test/check Python AST parsing passed |
| `git diff --check` | Passed |

The frozen migration remains unchanged. No API, database schema, dependency manifest, production configuration, infrastructure, deployment protection or credit/payment implementation was changed. No Phase 2A session actions were exposed.

## Acceptance journeys and regression evidence

| Journey | Local browser evidence |
| --- | --- |
| A — logged out | No premature search/debit; cancellation removes stale intent; failed signin retains question; both signin and signup resume with exact question; explicit Search sends legacy body and 2-credit debit. |
| B — logged in | Restored user routes directly to populated Search by Idea; year filters preserved; insufficient balance opens existing credits UI while front-door question remains. |
| C — references | Route focuses textarea; Clean and In-text produce copyable fixture output; Verify uses existing credit path; mismatch report and Accept Suggestions update references; authenticated Share creates fixture URL. |
| D — DOI/title | Existing DOI/ISBN, URL and title tabs submit their existing lookup actions; DOI results populate references. |
| E — PDF | Anonymous route resumes upload after signin; picker/copy say PDF; extraction presents existing options; extraction loads references; keyboard Deep Dive invokes existing 10-credit path. |
| F — shared report | Report is first in main content, visible without auth; front door is hidden on successful shared-report load; public-sharing warning retained. |
| G — mobile | 320, 360, 390, 768 and 1280px viewports, both themes, no page/dialog/result overflow; dialog keyboard loop; reduced-motion demo and scripted scrolling; separate 360px authentication/handoff check. Narrow-screen height is 740px. |
| H — returning user | Stored session/user display, balance, keyboard account menu, theme switch, credits modal and signout. Opening payment UI does not initialize a transaction. |

Browser screenshots at these widths were inspected during development; artifacts are optional local outputs, not committed assets. The browser harness blocks/fulfills all requests with local fixtures, including fonts, telemetry and source-link navigation. No service credentials are needed or read.

## Running the browser checks

The existing Node suite has no new dependencies. The separate browser harness requires Playwright and Chromium. In an environment without them, install test tooling outside the application manifest, for example:

```sh
npm install --prefix /tmp/refinr-browser-tools playwright@1.62.1
NODE_PATH=/tmp/refinr-browser-tools/node_modules CHROMIUM_PATH=/usr/bin/chromium node tests/browser/iteration1.cjs
```

Use an available Chromium executable via `CHROMIUM_PATH` (default `/usr/bin/chromium`). `UI_SCREENSHOT_DIR=/tmp/refinr-ui` optionally writes full-page screenshots. The validated environment already provided Playwright and Chromium.

## Limits and retained findings

- Browser checks validate frontend wiring with synthetic Auth, credits, papers, lookup, report, PDF and Deep Dive responses. They do not establish live service availability, actual scholarly results, real PDF extraction quality, payment settlement or live signup/session-refresh behavior. No staging/production API or Paystack transaction was exercised.
- Question retention is intentionally in page memory, through the existing in-page authentication forms. It does not persist research questions across reloads, closed tabs or external redirects.
- Insufficient-credit handling is the existing purchase route; after acquiring credits the user selects Explore again with the question still present. No auto-search or payment-triggered acquisition was introduced.
- Share storage remains publicly accessible without expiry/revocation. This iteration clarifies that boundary; it does not harden the report backend.
- Tested browser: Chromium. Native Android/iOS devices and other browser engines were not exercised. External web-font/feedback service availability was not tested.
- No preview or production deployment, merge, remote configuration change or Phase 2A staging mutation was performed. Work stops at the validated local feature-branch commit.
