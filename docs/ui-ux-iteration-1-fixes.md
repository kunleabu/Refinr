# Iteration 1 live-validation corrections

2026-10-22. Branch `feature/search-by-idea-v2-phase1`.
Fetched the current remote branch and checked it out before inspection/edits.
Starting HEAD: `37afb170f60349ea6403b1ea99b620d55cb36fd0`; working tree clean.

## Corrections

- Clean metadata: removed the 200-character author-section cutoff and initials-length cutoff; parse mixed full names/initials and Unicode surnames; normalize citation quotation marks and nonbreaking spaces; retain spaced page ranges and separated volume/issue punctuation. Before/after reproduction on a supplied 24-author citation retained 17 versus 24 authors, with the spaced page range absent before and present afterward. The regression invokes real Lookup → formatter → Clean using deterministic metadata/CSL fallback fixtures and asserts every author and page range survives. Clean does not perform reference verification; its existing standalone-identifier resolution contract remains intact.
- Credit authority: profile lookup errors/missing rows return null rather than a fabricated 5. Google profile creation uses the persisted response and does not create a profile when retrieval failed. Existing signup entitlement is unchanged. Restored sessions retrieve the authoritative profile; cached balances are replaced with Loading… during retrieval and Unavailable on failure. Actual zero displays 0. Signout clears the balance. Tests cover email/profile/Google errors, missing rows and zero.
- Citation styles: native buttons support Tab, Enter and Space, with ArrowDown from the search field, arrow navigation between results, Escape back to the field, focus retention during selection and focus-out dismissal. Existing selection values and mouse/touch activation remain.
- Mobile styles: consolidate the dropdown into the dialog's scrollable flow, bounded to its container, with wrapping names and touch-size options. Browser checks reach the final option in all six pickers at 360/390/430px and assert viewport/dialog bounds.
- Credit packages: native buttons expose the selected state through aria-pressed and support Enter/Space. Selection still only updates selectedPackage; payment initialization is unchanged and explicitly asserted absent during selection.
- Account menu: Escape from its controls closes the menu, updates aria-expanded and restores the account trigger.

## Validation

- `node --test tests/*.test.mjs`: 120 passed, 0 failed/skipped (108 existing plus 12 focused regressions).
- `NODE_PATH=/tmp/refinr-browser-tools/node_modules node tests/browser/iteration1.cjs`: 256 offline Chromium assertions passed, including original journeys A–H and focused corrections. Playwright installed outside the app manifest; system Chromium used.
- Changed API/library/browser scripts and extracted inline JavaScript pass syntax checks; static HTML IDs unique; `git diff --check` passes.
- PostgreSQL behavioral suite is outside the affected code paths: no schema, migration, repository or Phase 2A changes. An attempted standalone migration static check could not run because pglast is absent. No remote database operation was performed.
- Fixtures validate wiring and metadata preservation; no real payment, live authentication mutation, verification or Supabase write was executed. Native iOS/Android and non-Chromium browsers were not exercised.

## Preview

Existing Vercel CLI 62.4.0 reports Logged out using the environment's existing CLI data/cache paths. No deployment credential is available to update the protected preview; no temporary/unprotected deployment was created. Existing protection and Production were left untouched.
