import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const html = await readFile(new URL('../research.html', import.meta.url), 'utf8');

test('anonymous research remains value-first', () => {
  assert.match(html, /preview:true/);
  assert.match(html, /Anonymous preview: first 5 real papers, no credits required\./);
  assert.match(html, /Save my research — free/);
});

test('signed-in workspace prefers persisted research sessions', () => {
  assert.match(html, /action:'session\.create'/);
  assert.match(html, /action:'pull\.acquire'/);
  assert.match(html, /refinr-active-research-session/);
  assert.match(html, /Authorization':'Bearer '/);
});

test('disabled session gate preserves authenticated credit-based search', () => {
  assert.match(html, /e\.code!==\'RESEARCH_SESSIONS_DISABLED\'/);
  assert.match(html, /return legacySearch\(\)/);
  assert.doesNotMatch(html, /await deductSearchCredits\(\);var data=await researchAction/);
});

test('research handoff to references remains stable-id based', () => {
  assert.match(html, /card\.dataset\.paperId=p\.id/);
  assert.match(html, /p\.id===card\.dataset\.paperId/);
  assert.match(html, /refinr-selected-research-references/);
});

test('source provenance and incomplete-source messaging remain visible', () => {
  assert.match(html, /OpenAlex/);
  assert.match(html, /Crossref/);
  assert.match(html, /Results may be incomplete\./);
});


test('signup requiring email confirmation is explained without automatic password retry', async () => {
  const auth = await readFile(new URL('../api/auth.js', import.meta.url), 'utf8');
  const home = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(auth, /requiresEmailConfirmation: !data\.access_token/);
  assert.match(home, /if\(d\.requiresEmailConfirmation\)/);
  assert.match(home, /Check your email and confirm your address/);
});

test('cached user without token sees anonymous papers instead of a login error', () => {
  assert.match(html, /currentUser&&currentSession&&currentSession\.access_token\)\?await signedInSearch\(\):await anonymousSearch\(\)/);
});

test('signup return restores previous anonymous search instead of discarding evidence', () => {
  assert.match(html, /refinr-pending-research/);
  assert.match(html, /pending\.question===question/);
  assert.match(html, /pending\.papers/);
  assert.match(html, /Your earlier research/);
  assert.match(html, /pending\.yearFrom/);
  assert.match(html, /pending\.format/);
});

test('auth cancellation preserves research and correct tab and password visibility', async () => {
  const home=await readFile(new URL('../index.html',import.meta.url),'utf8');
  assert.match(home,/function cancelAuthModal\(/);
  assert.match(home,/location\.href=target/);
  assert.match(home,/openAuthModal\(auth==='signin'\?'signin':'signup'\)/);
  assert.match(home,/function toggleAuthPassword\(/);
  assert.match(html,/You can keep refining your search or sign in to continue/);
});
