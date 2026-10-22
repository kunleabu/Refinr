/* Offline browser acceptance checks. Requires Playwright and Chromium; no live APIs.
   Run: node tests/browser/iteration1.cjs
   Optional: CHROMIUM_PATH=/path/to/chromium UI_SCREENSHOT_DIR=/tmp/refinr-ui */
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const user = { id: 'fixture-user', email: 'reader@example.test', full_name: 'Reader', credits: 25 };
const session = { access_token: 'fixture-token', refresh_token: 'fixture-refresh' };
const paper = { id: 'doi:10.1234/fixture', title: 'A scholarly paper about small businesses in Nigeria', authors: ['A. Researcher'], year: 2024, journal: 'Fixture Journal', doi: '10.1234/fixture', doiUrl: 'https://doi.org/10.1234/fixture', abstract: 'An offline fixture, not research evidence.', formatted: 'Researcher, A. (2024) Fixture paper.' };
(async () => {
 const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
 let checks = 0;
 const check = (value, label) => { assert.ok(value, label); checks++; };
 async function setup({ loggedIn = false, width = 1280, report = false, profileState = 'actual' } = {}) {
  const context = await browser.newContext({ viewport: { width, height: width <= 390 ? 740 : 900 }, reducedMotion: 'reduce' });
  const page = await context.newPage(); page.setDefaultTimeout(8000); const requests = [], errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.addInitScript(({ loggedIn, user, session }) => {
   if (loggedIn) { localStorage.setItem('refinr-user', JSON.stringify(user)); localStorage.setItem('refinr-session', JSON.stringify(session)); }
   window.fixtureClipboard = ''; Object.defineProperty(navigator, 'clipboard', { value: { writeText: async text => { window.fixtureClipboard = text; } } });
  }, { loggedIn, user, session });
  await page.route('**/*', async route => {
   const req = route.request(), url = new URL(req.url());
   if (url.hostname === 'refinr.test' && url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: html });
   if (url.pathname === '/lib/csl-index.json') return route.fulfill({ contentType: 'application/json', body: fs.readFileSync(path.join(root, 'lib/csl-index.json'), 'utf8') });
   if (!url.pathname.startsWith('/api/')) return route.fulfill({ status: 200, body: '' });
   const body = req.postDataJSON(); requests.push({ endpoint: url.pathname, body, headers: req.headers() });
   let data;
   switch (url.pathname) {
    case '/api/auth': if(body.action==='profile'&&profileState!=='actual'){await new Promise(resolve=>setTimeout(resolve,250));return route.fulfill({status:profileState==='zero'?200:503,contentType:'application/json',body:JSON.stringify(profileState==='zero'?{user:{...user,credits:0}}:{error:'Unavailable'})});} data = body.password === 'wrong-password' ? { error: 'Invalid fixture credentials' } : { user, session }; break;
    case '/api/credits': data = { credits: 23 }; break;
    case '/api/searchbyidea': data = { papers: [paper], total: 1, formatted: paper.formatted }; break;
    case '/api/clean': data = { result: 'Cleaned fixture reference.' }; break;
    case '/api/intext': data = { result: '(Researcher, 2024)' }; break;
    case '/api/verify': data = { result: '⚠️ MISMATCH — Original reference\n✏️ Suggested correction: Corrected reference' }; break;
    case '/api/lookup': data = { results: ['✅ Lookup fixture reference.'] }; break;
    case '/api/analyze': data = body.action === 'deepdive' ? { result: 'Fixture deep dive report' } : { references: ['Original reference'], documentType: 'paper', title: 'Fixture PDF', summary: 'Offline fixture' }; break;
    case '/api/report': data = req.method() === 'GET' ? { reportData: { title: 'Shared fixture', date: '22 October 2026', content: 'Recipient-first shared result.' } } : { binId: 'fixture-report' }; break;
    default: throw new Error('Unexpected API: ' + url.pathname);
   }
   await route.fulfill({ contentType: 'application/json', body: JSON.stringify(data) });
  });
  await page.goto('http://refinr.test/' + (report ? '?report=fixture' : ''));
  return { page, context, requests, errors };
 }
 async function visible(page, selector) { await page.locator(selector).waitFor({ state: 'visible' }); check(true, selector + ' visible'); }
 async function signIn(page, signup = false) {
  if (signup) await page.locator('#signupTab').click();
  await page.locator(signup ? '#signupEmail' : '#signinEmail').fill(user.email);
  await page.locator(signup ? '#signupPassword' : '#signinPassword').fill('fixture-password');
  await page.locator(signup ? '#signupForm .btn-confirm' : '#signinForm .btn-confirm').click();
 }
 try {
  // Focused regressions: authoritative balance states, keyboard choices and mobile styles.
  for(const profileState of ['unavailable','zero']){
   const {page,context}=await setup({loggedIn:true,profileState});
   check(await page.locator('#creditsCount').textContent()==='Loading…','Restored balance loads instead of trusting cached credits');
   await page.waitForFunction(()=>document.getElementById('creditsCount').textContent!=='Loading…');
   for(const id of ['creditsCount','dropdownCredits','creditsInModal'])check(await page.locator('#'+id).textContent()===(profileState==='zero'?'0':'Unavailable'),'Balance state '+id+' '+profileState);
   await context.close();
  }
  for(const width of [360,390,430]){
   const {page,context,requests,errors}=await setup({width,loggedIn:true});
   await page.getByRole('button',{name:'Account menu'}).click();await page.getByRole('button',{name:'Copy referral code',exact:false}).focus();await page.keyboard.press('Escape');
   check(await page.locator('#accountTrigger').evaluate(el=>el===document.activeElement&&el.getAttribute('aria-expanded')==='false'),'Escape restores account trigger');
   await page.getByRole('button',{name:'Get more credits'}).click();
   for(const [pack,key] of [['pack_20','Enter'],['pack_100','Space']]){await page.locator('[data-package="'+pack+'"]').focus();await page.keyboard.press(key);check(await page.locator('[data-package="'+pack+'"]').getAttribute('aria-pressed')==='true','Keyboard package '+key);}
   check(!requests.some(r=>r.endpoint==='/api/paystack'),'Package selection does not initiate payment');await page.keyboard.press('Escape');
   for(const pk of ['clean','lookup','url','title','idea','upload']){
    await page.evaluate(pk=>{document.querySelectorAll('.modal-overlay').forEach(el=>el.classList.remove('visible'));var cfg=PICKERS[pk],input=document.getElementById(cfg.s);input.closest('.modal-overlay').classList.add('visible');for(var el=input.parentElement;el&&!el.classList.contains('modal-overlay');el=el.parentElement)el.style.display='block';},pk);
    const input=page.locator('#'+({clean:'cleanStyleSearch',lookup:'lookupStyleSearch',url:'urlStyleSearch',title:'titleStyleSearch',idea:'ideaStyleSearch',upload:'uploadStyleSearch'}[pk]));
    await input.fill('');await page.keyboard.press('ArrowDown');
    const options=page.locator('#'+pk+'StyleDropdown button');
    check(await options.first().evaluate(el=>el===document.activeElement),'ArrowDown focuses style '+pk);
    await page.keyboard.press('ArrowDown');await page.keyboard.press('Space');
    check(await input.inputValue()!=='','Space selects style');
    await input.fill('');await page.keyboard.press('ArrowDown');await page.keyboard.press('Enter');check(await input.evaluate(el=>el===document.activeElement),'Enter restores style input');
    await input.fill('');await page.keyboard.press('ArrowDown');await options.last().focus();
    check(await options.last().evaluate(el=>{el.scrollIntoView({block:'nearest'});var r=el.getBoundingClientRect(),m=el.closest('.modal');return r.left>=0&&r.right<=innerWidth&&r.bottom<=innerHeight&&m.scrollWidth<=m.clientWidth;}),width+' '+pk+' last style reachable without overflow');
    await page.keyboard.press('Escape');check(await input.evaluate(el=>el===document.activeElement),'Style Escape returns input');
   }
   check(errors.length===0,'Focused regressions no JS errors '+errors.join());await context.close();
  }
  // A: anonymous intent, failure/cancellation, sign in and signup, no premature charge.
  for (const signup of [false, true]) {
   const { page, context, requests, errors } = await setup();
   check(!await page.locator('#creditsBar').isVisible(), 'Anonymous credits hidden');
   const question = 'Why do small businesses in Nigeria struggle to survive?';
   await page.locator('#researchQuestion').fill(question);
   await page.getByRole('button', { name: 'Explore research' }).click();
   await visible(page, '#authModal');
   check(!requests.some(r => ['/api/credits','/api/searchbyidea'].includes(r.endpoint)), 'No charge/search before auth');
   await page.locator('#signinForm .btn-cancel').click();
   await page.getByRole('button', { name: 'Sign in', exact: true }).first().click();
   check(!await page.locator('#authContext').isVisible(), 'Cancel clears stale intent');
   await page.locator('#signinForm .btn-cancel').click();
   await page.getByRole('button', { name: 'Explore research' }).click();
   if(!signup){await page.locator('#signinEmail').fill(user.email);await page.locator('#signinPassword').fill('wrong-password');await page.locator('#signinForm .btn-confirm').click();await visible(page,'#authError');check(await page.locator('#researchQuestion').inputValue()===question,'Question survives failed authentication');}
   await signIn(page, signup); await visible(page, '#ideaModal');
   check(await page.locator('#ideaInput').inputValue() === question, 'Question survives authentication');
   check(!requests.some(r => r.endpoint === '/api/credits'), 'Auth does not charge');
   await page.locator('#yearFrom').fill('2019'); await page.locator('#yearTo').fill('2025');
   await page.locator('#ideaSearchBtn').click(); await visible(page, '#ideaResultsList .idea-result-card');
   const retrieval = requests.find(r => r.endpoint === '/api/searchbyidea');
   check(retrieval.body.idea === question && retrieval.body.yearFrom === '2019' && retrieval.body.yearTo === '2025' && !retrieval.body.action, 'Legacy endpoint and filters');
   check(requests.find(r => r.endpoint === '/api/credits').body.amount === 2, 'Existing 2-credit debit');
   const checkbox = page.locator('#paper-choice-0'); await checkbox.focus(); await page.keyboard.press('Space');
   check(!await checkbox.isChecked(), 'Keyboard deselect'); await page.keyboard.press('Space');
   const popupPromise = page.waitForEvent('popup'); await page.getByRole('link', { name: 'View paper' }).click(); const popup = await popupPromise; await popup.close();
   check(await checkbox.isChecked(), 'Source link does not toggle selection');
   await page.getByRole('button', { name: 'Load selected into references' }).click();
   check((await page.locator('#referencesInput').inputValue()).includes(paper.formatted), 'Papers bridge to references');
   check(errors.length === 0, 'No JS errors: ' + errors.join()); await context.close();
  }
  console.log('A passed');
  // B, H: restored session, balance, account, payment access, theme, insufficient credit.
  {
   const { page, context, requests, errors } = await setup({ loggedIn: true });
   await visible(page, '#creditsBar'); await visible(page, '#userAvatar');
   await page.locator('#researchQuestion').fill('Returning researcher question'); await page.getByRole('button', { name: 'Explore research' }).click();
   await visible(page, '#ideaModal'); check(await page.locator('#ideaInput').inputValue() === 'Returning researcher question', 'Logged-in handoff');
   await page.keyboard.press('Escape'); await page.locator('#themeBtn').click(); check(await page.locator('html').getAttribute('data-theme') === 'dark', 'Dark theme');
   await page.getByRole('button', { name: 'Get more credits' }).click(); await visible(page, '#creditsModal');
   check(!requests.some(r => r.endpoint === '/api/paystack'), 'Opening payments does not initiate payment');
   await page.keyboard.press('Escape'); await page.evaluate(() => updateCreditsDisplay(1));
   await page.getByRole('button', { name: 'Explore research' }).click(); await visible(page, '#creditsModal');
   check(await page.locator('#researchQuestion').inputValue() === 'Returning researcher question', 'Question retained with insufficient balance');
   await page.keyboard.press('Escape'); await page.getByRole('button',{name:'Account menu'}).click();check(await page.getByRole('button',{name:'Account menu'}).getAttribute('aria-expanded')==='true','Account menu keyboard control');await page.getByRole('button',{name:'Sign out',exact:false}).click();
   check(!await page.locator('#creditsBar').isVisible(), 'Signout hides balance');
   check(errors.length === 0, 'Returning user JS errors'); await context.close();
  }
  console.log('B/H passed');
  // C, D, E: working reference tools, all lookup modes, PDF auth and extraction/analysis.
  {
   const { page, context, requests, errors } = await setup();
   await page.getByRole('button', { name: 'References', exact: true }).click();
   check(await page.locator('#referencesInput').evaluate(el => el === document.activeElement), 'References receives focus');
   await page.locator('#referencesInput').fill('Original reference');
   await page.getByRole('button', { name: 'Clean references', exact: false }).click(); await page.getByRole('button', { name: 'Clean my references' }).click();
   await page.waitForFunction(() => document.getElementById('outputContent').textContent.includes('Cleaned fixture'));
   await page.getByRole('button', { name: 'Copy', exact: true }).click(); check(await page.evaluate(() => fixtureClipboard) === 'Cleaned fixture reference.', 'Copy output');
   await page.getByRole('button', { name: 'In-text citations', exact: false }).click(); await page.locator('#intextModal [onclick="generateIntext()"]').click();
   await page.waitForFunction(() => document.getElementById('outputContent').textContent.includes('(Researcher'));
   await page.getByRole('button', { name: 'DOI / Title', exact: true }).click(); await visible(page, '#lookupModal');
   check(await page.locator('.lookup-tab').count() === 3, 'DOI/ISBN, URL, title retained');
   await page.locator('#doiInput').fill('10.1234/fixture'); await page.locator('#tab-doi .btn-confirm-orange').click();
   await page.waitForFunction(() => document.getElementById('referencesInput').value.includes('Lookup fixture'));
   for(const mode of ['url','title']){await page.getByRole('button',{name:'DOI / Title',exact:true}).click();await page.locator('#tab-btn-'+mode).click();await page.locator(mode==='url'?'#urlInput':'#titleInput').fill(mode==='url'?'https://example.test/paper':'Fixture paper');await page.locator('#tab-'+mode+' .btn-confirm-orange').click();await page.waitForFunction(()=>!document.getElementById('lookupModal').classList.contains('visible'));}
   await page.getByRole('button', { name: 'PDF', exact: true }).click(); await visible(page, '#authModal'); await signIn(page); await visible(page, '#uploadModal');
   check((await page.locator('#uploadModal').innerText()).includes('PDF document — max 10MB') && ! (await page.locator('#uploadModal').innerText()).includes('Word'), 'Truthful PDF copy');
   await page.locator('#pdfFileInput').setInputFiles({ name: 'fixture.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 offline fixture') });
   await visible(page, '#uploadOptionsPanel');
   check(await page.locator('#uploadOptions .pdf-option').count() >= 3, 'PDF options preserved');
   await page.locator('#uploadOptions .pdf-option').first().focus();await page.keyboard.press('Enter');
   await page.waitForFunction(() => document.getElementById('outputContent').textContent.includes('Fixture deep dive report'));
   check(requests.some(r=>r.endpoint==='/api/credits'&&r.body.amount===10),'Deep Dive keeps 10-credit debit');
   await page.getByRole('button',{name:'PDF',exact:true}).click();
   await page.locator('#pdfFileInput').setInputFiles({ name: 'fixture.PDF', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 offline fixture') });await visible(page,'#uploadOptionsPanel');
   await page.evaluate(() => runExtractAndFormat()); check(await page.locator('#referencesInput').inputValue() === 'Original reference', 'PDF references bridge');
   await page.getByRole('button', { name: 'Verify', exact: false }).first().click(); await page.locator('#verifyModal .btn-confirm-green').click();
   await visible(page, '#acceptSuggestionsBtn'); await page.locator('#acceptSuggestionsBtn').click();
   check(await page.locator('#referencesInput').inputValue() === 'Corrected reference', 'Accept Suggestions retained');
   await page.getByRole('button', { name: 'Share', exact: true }).click(); await visible(page, '#shareModal');
   await page.waitForFunction(() => document.getElementById('shareUrlBox').textContent.includes('?report=fixture-report'));
   check((await page.locator('#shareModal').innerText()).includes('no expiry or revocation'), 'Share privacy truthful');
   check(errors.length === 0, 'Reference/PDF JS errors: ' + errors.join()); await context.close();
  }
  console.log('C/D/E passed');
  // F: shared output is first and has no authentication wall.
  {
   const { page, context, errors } = await setup({ report: true }); await visible(page, '#outputCard');
   check((await page.locator('main > :first-child').getAttribute('id')) === 'outputCard', 'Shared result first');
   check(!await page.locator('#authModal').isVisible() && !await page.locator('#frontDoor').isVisible(), 'Recipient no auth wall/hero');
   check(errors.length === 0, 'Shared JS errors'); await context.close();
  }
  // G: narrow viewports, both themes, dialog keyboard loop and reduced motion.
  for (const width of [320, 360, 390, 768, 1280]) {
   const { page, context, errors } = await setup({ width, loggedIn: true });
   for (const theme of ['light','dark']) {
    await page.evaluate(theme => document.documentElement.setAttribute('data-theme', theme), theme);
    check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${width} ${theme}: no page overflow`);
    const question = page.locator('#researchQuestion'); await question.fill('Research at narrow widths');
    await page.getByRole('button', { name: 'Explore research' }).click(); await visible(page, '#ideaModal');
    check(await page.locator('#ideaModal .modal').evaluate(el => el.scrollWidth <= el.clientWidth), `${width}: dialog no overflow`);
    const last = page.locator('#ideaSearchPanel .btn-cancel'); await last.focus(); await page.keyboard.press('Tab');
    check(await page.locator('#ideaInput').evaluate(el => el === document.activeElement), 'Modal focus loops');
    await page.locator('#ideaSearchBtn').click(); await visible(page, '#ideaResultsList .idea-result-card');
    check(await page.locator('#ideaModal .modal').evaluate(el => el.scrollWidth <= el.clientWidth), 'Result cards no overflow');
    await page.keyboard.press('Escape');
   }
   check(await page.evaluate(()=>preferredScrollBehavior())==='instant','Reduced motion disables scripted smooth scrolling');
   check(await page.locator('.demo-content span').first().evaluate(el=>getComputedStyle(el).animationDelay)==='0s','Reduced-motion demo has no delayed content');
   if (process.env.UI_SCREENSHOT_DIR) { fs.mkdirSync(process.env.UI_SCREENSHOT_DIR, { recursive: true }); await page.screenshot({ path: path.join(process.env.UI_SCREENSHOT_DIR, `front-door-${width}.png`), fullPage: true }); }
   check(errors.length === 0, `${width}: no JS errors`); await context.close();
  }
  {const {page,context,errors}=await setup({width:360});await page.locator('#researchQuestion').fill('Mobile authentication question');await page.getByRole('button',{name:'Explore research'}).click();await visible(page,'#authModal');check(await page.locator('#authModal .modal').evaluate(el=>el.scrollWidth<=el.clientWidth&&el.getBoundingClientRect().bottom<=innerHeight),'Mobile auth fits viewport');await signIn(page);await visible(page,'#ideaModal');check(await page.locator('#ideaInput').inputValue()==='Mobile authentication question','Mobile auth retains question');check(errors.length===0,'Mobile auth no JS errors');await context.close();}
  console.log(`PASS: ${checks} offline browser assertions covering journeys A–H.`);
 } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
