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

test('disabled session gate falls back to free anonymous preview', () => {
  assert.match(html, /e\.code!==\'RESEARCH_SESSIONS_DISABLED\'/);
  assert.match(html, /return anonymousSearch\(\)/);
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
  assert.match(auth, /requiresEmailConfirmation: !data\.session/);
  assert.match(home, /if\(d\.requiresEmailConfirmation\)/);
  assert.match(home, /Check your email and confirm your address/);
});
