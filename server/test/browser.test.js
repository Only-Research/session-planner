// Uses an existing Playwright installation and an existing browser only.
// PLANNER_PLAYWRIGHT_PATH may point to a local package; nothing is downloaded.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execute = promisify(execFile);
const { chromium } = require(process.env.PLANNER_PLAYWRIGHT_PATH || 'playwright');
const cli = path.resolve(__dirname, '../planner.js');

test('browser: one click, one append; draft preservation; status/proposal flow; offline assets', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'session-planner-browser-'));
  const runs = path.join(root, 'runs');
  const intake = path.join(root, 'intake.md');
  const body = path.join(root, 'body.md');
  fs.writeFileSync(intake, '# Campaign planning\nPlanning several pieces before Tuesday.');
  fs.writeFileSync(body, '## Context\nA campaign with several moving pieces.\n\n## Content\nKeep the launch team involved.\n\n| Day | Work |\n| --- | --- |\n| Tuesday | Launch |\n\n## Recommendation\nRefine the launch sequence.\n');
  const run = async (...args) => JSON.parse((await execute(process.execPath, [cli, ...args, '--runs', runs], { timeout: 20000 })).stdout);
  let browser;
  try {
    const created = await run('create', 'campaign', '--intake', intake);
    await run('add', 'campaign', '--title', 'Launch sequence', '--body', body);
    await run('add', 'campaign', '--title', 'Audience and message', '--body', body);
    const proposalBody = path.join(root, 'proposal.md');
    fs.writeFileSync(proposalBody, fs.readFileSync(body, 'utf8') + '\n' + Array.from({length:40}, (_,n) => `Paragraph ${n}: substantive rehearsal detail with [source](https://example.com/${n}).`).join('\n\n') + '\n\nPROPOSAL END');
    await run('propose', 'campaign', '--title', 'Add a rehearsal', '--body', proposalBody);
    browser = await chromium.launch({ headless: true, channel: 'chrome', chromiumSandbox: true });
    const context = await browser.newContext({ viewport: { width: 1360, height: 950 } });
    const page = await context.newPage();
    const external = [];
    const errors = [];
    const requests = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => requests.push(request.url()));
    const origin = new URL(created.url).origin;
    await page.route('**/*', route => {
      if (new URL(route.request().url()).origin !== origin) { external.push(route.request().url()); return route.abort(); }
      return route.continue();
    });
    await page.goto(created.url);
    await page.locator('.card[data-item-id="1"]').click();
    await page.locator('.feedback-input[data-item-id="1"]').fill('Keep Tuesday as the deadline.');
    // Real polling used to accumulate listeners on this preserved button.
    await page.waitForTimeout(8000);
    await page.locator('[data-action="feedback"][data-id="1"]').click();
    await page.waitForFunction(() => document.querySelector('.feedback-input[data-item-id="1"]')?.value === '');
    const saved = await run('read', 'campaign', '1');
    assert.equal(saved.data.feedback.match(/Keep Tuesday as the deadline\./g).length, 1);
    assert.equal(requests.filter(url => url.endsWith('/items/1/feedback')).length, 1);
    await page.locator('.expanded[data-item-id="1"] .saved-feedback summary').click();
    assert.match(await page.locator('.expanded[data-item-id="1"] .saved-feedback pre').innerText(), /Keep Tuesday/);
    await page.locator('.card[data-item-id="2"]').click();
    await page.locator('.feedback-input[data-item-id="2"]').fill('A draft on the other item.');
    await page.locator('.feedback-input[data-item-id="1"]').fill('Use this launch sequence only.');
    await page.locator('[data-action="approve"][data-id="1"]').click();
    await page.waitForTimeout(300);
    const qualified = await run('read', 'campaign', '1');
    assert.equal(qualified.data.status, 'green');
    assert.equal(qualified.data.approval.note, 'Use this launch sequence only.');
    assert.equal(qualified.content, saved.content);
    assert.equal(await page.locator('.feedback-input[data-item-id="2"]').inputValue(), 'A draft on the other item.');
    page.on('dialog', dialog => dialog.accept());
    await page.reload();
    await page.locator('.card[data-item-id="2"]').click();
    assert.equal(await page.locator('.feedback-input[data-item-id="2"]').inputValue(), 'A draft on the other item.');
    await page.locator('.sb-prop-row').click();
    await page.locator('.sb-prop-open-body').filter({hasText:'PROPOSAL END'}).waitFor();
    const reader = page.locator('.sb-prop-open-body');
    await reader.evaluate(el => { el.scrollTop = 240; el.focus(); el.dataset.testRetained = 'yes'; });
    await page.waitForTimeout(5500);
    assert.equal(await reader.evaluate(el => el.scrollTop), 240);
    assert.equal(await reader.getAttribute('data-test-retained'), null); // Attributes reconcile, element identity remains.
    assert.equal(await reader.evaluate(el => el === document.activeElement), true);
    assert.equal((await run('read', 'campaign', '16')).data.status, 'proposed');
    assert.equal(await reader.locator('a').first().evaluate(el => getComputedStyle(el).color), 'rgb(131, 189, 145)');
    const two = await run('read', 'campaign', '2');
    await run('update', 'campaign', '2', '--revision', two.revision, '--body', body);
    await page.waitForTimeout(3000);
    assert.equal(await reader.evaluate(el => el.scrollTop), 240);
    const source = await run('read', 'campaign', '16');
    fs.appendFileSync(proposalBody, '\nAdditional context.\n');
    await run('update', 'campaign', '16', '--revision', source.revision, '--body', proposalBody);
    await page.waitForTimeout(3000);
    assert.equal(await reader.evaluate(el => el.scrollTop), 240);
    assert.match(await reader.innerText(), /Additional context/);
    await page.screenshot({ path: path.join(root, 'proposal-reader.png'), fullPage: true });
    await page.locator('[data-action="to-field"][data-id="16"]').click();
    await page.waitForTimeout(300);
    assert.equal((await run('read', 'campaign', '16')).data.status, 'red');
    assert.equal((await run('read', 'campaign', '16')).data.type, 'item');
    await page.locator('.card[data-item-id="16"]').click();
    await page.locator('.expanded[data-item-id="16"] table').waitFor({ state: 'visible' });
    assert.equal(await page.locator('.expanded[data-item-id="16"] table').count(), 1);
    // Amend a staged decision, preserving body/history.
    await page.locator('.sb-row[data-item-id="1"]').click();
    await page.locator('.feedback-input[data-item-id="1"]').fill('Launch on Tuesday only.');
    await page.locator('[data-action="amend"][data-id="1"]').click();
    await page.waitForTimeout(250);
    const amendment = await run('read', 'campaign', '1');
    assert.equal(amendment.data.approval.note, 'Launch on Tuesday only.');
    assert.equal(amendment.data.approvalHistory.length, 1);
    await page.screenshot({ path: path.join(root, 'approval-note.png'), fullPage: true });
    // Old draft is preserved when source changes; no unnoticed approval.
    await page.locator('.feedback-input[data-item-id="16"]').fill('A qualification against the old version.');
    const original = await run('read', 'campaign', '16');
    fs.appendFileSync(proposalBody, '\nA newly changed decision.\n');
    await run('update', 'campaign', '16', '--revision', original.revision, '--body', proposalBody);
    await page.waitForTimeout(3000);
    await page.locator('[data-action="approve"][data-id="16"]').click();
    assert.equal((await run('read', 'campaign', '16')).data.status, 'red');
    assert.match(await page.locator('#planner-error').innerText(), /older version/);
    await page.locator('[data-action="review-latest"][data-id="16"]').click();
    await page.locator('.expanded[data-item-id="16"] .exp-body').filter({hasText:'A newly changed decision.'}).waitFor();
    // Drop a response AFTER committing a feedback append. The browser must retry
    // the original operation even after its own write changes the revision.
    let dropped = false;
    await page.route('**/items/16/feedback', async route => {
      if (!dropped) { dropped = true; await route.fetch(); await route.abort(); }
      else await route.continue();
    });
    await page.locator('[data-action="feedback"][data-id="16"]').click();
    await page.waitForTimeout(700);
    assert.equal(await page.locator('.feedback-input[data-item-id="16"]').inputValue(), 'A qualification against the old version.');
    await page.locator('[data-action="feedback"][data-id="16"]').click();
    await page.waitForFunction(() => document.querySelector('.feedback-input[data-item-id="16"]')?.value === '');
    const afterRetry = await run('read', 'campaign', '16');
    assert.equal(afterRetry.data.feedback.split('A qualification against the old version.').length - 1, 1);
    // Raw HTML and executable links in agent content must not execute.
    const item = await run('read', 'campaign', '16');
    fs.writeFileSync(body, ['## Content', '<svg onload="window.bad=true"></svg>', '<img src="https://example.invalid/x" onerror="window.bad=true">', '<script>window.bad=true</script>', '[bad](javascript:window.bad=true)', '[encoded](javascript&#58;alert(1))', '[data](data:text/html,boom)', '[quoted](https://example.invalid/" onclick="window.bad=true)', '[**ordinary**](https://example.invalid/ok)', '[email](mailto:someone@example.invalid)', '![image](https://example.invalid/pixel)'].join('\n\n'));
    await run('update', 'campaign', '16', '--revision', item.revision, '--body', body);
    await page.waitForTimeout(3000);
    assert.equal(await page.evaluate(() => window.bad), undefined);
    assert.equal(await page.locator('.exp-body a[href^="javascript:"]').count(), 0);
    assert.equal(await page.locator('.exp-body img, .exp-body svg, .exp-body script, .exp-body iframe, .exp-body object').count(), 0);
    assert.equal(await page.locator('.exp-body').evaluateAll(elements=>elements.flatMap(el=>[...el.querySelectorAll('*')]).flatMap(el=>[...el.attributes]).filter(a=>/^on/i.test(a.name)).length), 0);
    // Approval response loss also replays one decision even after the browser
    // discovers that the server has already staged the item.
    await page.locator('.feedback-input[data-item-id="16"]').fill('Keep this approved component only.');
    let approvalDropped = false;
    await page.route('**/items/16/status', async route => {
      if (!approvalDropped) { approvalDropped = true; await route.fetch(); await route.abort(); }
      else await route.continue();
    });
    await page.locator('[data-action="approve"][data-id="16"]').click();
    await page.locator('[data-action="amend"][data-id="16"]').waitFor();
    await page.locator('[data-action="amend"][data-id="16"]').click();
    await page.waitForFunction(() => document.querySelector('.feedback-input[data-item-id="16"]')?.value === '');
    const replayedApproval = await run('read', 'campaign', '16');
    assert.equal(replayedApproval.data.approval.note, 'Keep this approved component only.');
    assert.equal(replayedApproval.data.approvalHistory?.length || 0, 0);
    // A second browser reopens the same item; every visible copy reconciles.
    const otherPage = await context.newPage();
    await otherPage.goto(created.url);
    await otherPage.locator('.sb-row[data-item-id="16"]').click();
    await otherPage.locator('[data-action="bring-back"][data-id="16"]').click();
    await page.locator('[data-action="approve"][data-id="16"]').waitFor();
    assert.equal(await page.locator('[data-action="amend"][data-id="16"]').count(), 0);
    await otherPage.close();
    // While the next session is loading, old inputs cannot write into it.
    await run('create', 'other', '--intake', intake);
    await run('add', 'other', '--title', 'Other session item', '--body', body);
    let releaseNavigation;
    const navigationHold = new Promise(resolve => releaseNavigation = resolve);
    await page.route('**/sessions/other', async route => { await navigationHold; await route.continue(); });
    await page.evaluate(() => navigateTo('other'));
    assert.equal(await page.locator('.feedback-input').count(), 0);
    assert.equal(await page.locator('[data-action="approve"]').count(), 0);
    releaseNavigation();
    await page.locator('.card[data-item-id="1"]').waitFor();
    await page.locator('.card[data-item-id="1"]').click();
    assert.equal(await page.locator('.feedback-input[data-item-id="1"]').inputValue(), '');
    assert.deepEqual(external, []);
    assert.deepEqual(errors, []);
    const screenshot = path.join(root, 'desktop.png');
    await page.screenshot({ path: screenshot, fullPage: true });
    console.log(`Browser evidence: ${screenshot}`);
  } finally {
    if (browser) await browser.close();
    await run('stop', '--all');
  }
});

test('browser recovery: isolated drafts, unavailable speech, uncertain approvals and creation, restart authentication', async () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'session-planner-recovery-browser-'));
  const runs=path.join(root,'runs'), otherRuns=path.join(root,'other-runs'), intake=path.join(root,'intake.md'), body=path.join(root,'body.md');
  fs.writeFileSync(intake,'# Recovery trial');
  fs.writeFileSync(body,'## Details\n[Fragment](#details) and [Website](https://example.com).\n\n## Recommendation\nChoose this.');
  const command=async(store,...args)=>JSON.parse((await execute(process.execPath,[cli,...args,'--runs',store],{timeout:20000})).stdout);
  const run=(...args)=>command(runs,...args);
  let browser;
  try {
    const created=await run('create','example','--intake',intake), origin=new URL(created.url).origin;
    await run('add','example','--title','First','--body',body);
    await run('add','example','--title','Second','--body',body);
    browser=await chromium.launch({headless:true,channel:'chrome',chromiumSandbox:true});
    const context=await browser.newContext();
    await context.addInitScript(()=>Object.defineProperty(window,'speechSynthesis',{value:undefined,configurable:true}));
    await context.route('**/*',r=>new URL(r.request().url()).origin===origin?r.continue():r.abort());
    const page=await context.newPage(), tab=await context.newPage(), errors=[];
    page.on('pageerror',e=>errors.push(e.message));
    for (const p of [page,tab]) { p.on('dialog',d=>d.accept()); await p.goto(created.url); await p.locator('.card[data-item-id="1"]').click(); }
    const draft=p=>p.locator('.feedback-input[data-item-id="1"]');
    await draft(page).fill('Tab A'); await draft(tab).fill('Tab B');
    await page.locator('[data-action="feedback"][data-id="1"]').click();
    await page.waitForFunction(()=>document.querySelector('.feedback-input[data-item-id="1"]')?.value==='');
    await tab.reload(); await tab.locator('.card[data-item-id="1"]').click();
    assert.equal(await draft(tab).inputValue(),'Tab B');
    assert.equal(await page.locator('.exp-body a').count(),1);
    assert.equal(await page.locator('[data-action="speak"][data-id="1"]').isDisabled(),true);
    // Empty approval commits, but the response is lost. Recovery must work even after staging.
    const statusPattern='**/sessions/example/items/1/status';
    await page.route(statusPattern,async route=>{await route.fetch();await route.abort();},{times:1});
    await page.locator('[data-action="approve"][data-id="1"]').click();
    await page.locator('[data-retry-id="1"]').waitFor();
    await page.locator('[data-retry-id="1"]').click();
    await page.waitForFunction(()=>!document.querySelector('[data-retry-id="1"]'));
    let item=await run('read','example','1');
    assert.equal(item.data.status,'green'); assert.equal(item.data.interactions.filter(r=>r.event==='approved with decision record').length,1);
    // Amendment and explicit removal preserve another unsaved draft.
    if(!(await draft(page).count())) await page.locator('#sb-staged [data-item-id="1"]').click();
    await draft(page).fill('Only the recommended option');
    await page.locator('[data-action="amend"][data-id="1"]').click();
    await page.waitForFunction(()=>!!document.querySelector('[data-action="remove-note"][data-id="1"]'));
    await draft(page).fill('Unsubmitted amendment');
    await page.locator('[data-action="remove-note"][data-id="1"]').click();
    await page.waitForFunction(()=>!document.querySelector('[data-action="remove-note"][data-id="1"]'));
    assert.equal(await draft(page).inputValue(),'Unsubmitted amendment');
    assert.equal((await run('read','example','1')).data.approval.note,'');
    // A new item with a lost response has a visible replay; it clears the unchanged form.
    await page.locator('#nav-new-item').click();
    await page.locator('#new-item-title').fill('Created once'); await page.locator('#new-item-notes').fill('Original note');
    await page.route('**/sessions/example/items/new',async route=>{await route.fetch();await route.abort();},{times:1});
    await page.locator('#new-item-create').click();
    await page.locator('[data-retry-id="new-item"]').click();
    await page.waitForFunction(()=>!document.querySelector('[data-retry-id="new-item"]'));
    assert.equal(await page.locator('#new-item-title').inputValue(),'');
    assert.equal((await run('resume','example')).items.filter(i=>i.data.title==='Created once').length,1);
    // Viewing another card during creation must not leave a resubmittable form.
    await page.locator('#nav-new-item').click();
    await page.locator('#new-item-title').fill('Keep navigating');
    let release, arrived;
    const held = new Promise(resolve=>release=resolve), seen = new Promise(resolve=>arrived=resolve);
    await page.route('**/sessions/example/items/new',async route=>{arrived();await held;await route.continue();},{times:1});
    await page.locator('#new-item-create').click(); await seen;
    await page.locator('.card[data-item-id="2"]').click(); release();
    await page.waitForFunction(()=>document.querySelector('#new-item-title').value==='');
    assert.equal((await run('resume','example')).items.filter(i=>i.data.title==='Keep navigating').length,1);
    // Auth rejection after restart must not erase the ID of already committed feedback.
    if (!(await page.locator('.feedback-input[data-item-id="2"]').count())) await page.locator('.card[data-item-id="2"]').click();
    await page.locator('.feedback-input[data-item-id="2"]').fill('Only append me once');
    await page.route('**/sessions/example/items/2/feedback',async route=>{await route.fetch();await route.abort();},{times:1});
    await page.locator('[data-action="feedback"][data-id="2"]').click();
    await page.locator('[data-retry-id="2"]').waitFor();
    await page.waitForFunction(()=>!pendingActions.has('example/2'));
    const oldRuntime = JSON.parse(fs.readFileSync(path.join(runs,'.runtime.json'),'utf8'));
    await run('stop','--all');
    await run('start','--port',new URL(created.url).port);
    const newRuntime = JSON.parse(fs.readFileSync(path.join(runs,'.runtime.json'),'utf8'));
    assert.notEqual(oldRuntime.instance,newRuntime.instance);
    assert.equal(await page.evaluate(token=>AUTH_TOKEN===token,oldRuntime.token),true);
    assert.equal(await page.evaluate(token=>AUTH_TOKEN===token,newRuntime.token),false);
    await page.locator('[data-retry-id="2"]').click();
    await page.waitForFunction(()=>document.querySelector('#planner-error')?.textContent.includes('reconnect'), null, {timeout: 5000}).catch(async error => { console.log('Reconnect diagnostic', await page.evaluate(()=>({error:document.querySelector('#planner-error')?.textContent, pending:[...pendingActions], recovery:document.querySelector('#pending-recovery')?.textContent, generation:state.generation}))); throw error; });
    assert.equal(await page.locator('[data-retry-id="2"]').count(),1);
    await page.reload(); await page.locator('[data-retry-id="2"]').click();
    await page.waitForFunction(()=>!document.querySelector('[data-retry-id="2"]'));
    assert.equal((await run('read','example','2')).data.feedback.split('Only append me once').length-1,1);
    // Same name and port, different store: old tab drafts never appear there.
    await run('stop','--all'); await command(otherRuns,'start','--port',new URL(created.url).port);
    const other=await command(otherRuns,'create','example','--intake',intake);
    await command(otherRuns,'add','example','--title','First','--body',body);
    await page.goto(other.url); await page.reload(); await page.locator('.card[data-item-id="1"]').click();
    assert.equal(await draft(page).inputValue(),'');
    await page.route('**/sessions/example', route=>route.abort());
    await page.evaluate(()=>pollSession());
    assert.equal(await page.locator('#connection-status').count(),1);
    await page.unroute('**/sessions/example');
    await page.evaluate(()=>pollSession());
    assert.equal(await page.locator('#connection-status').count(),0);
    assert.deepEqual(errors,[]);
    await page.screenshot({path:path.join(root,'recovery.png'),fullPage:true});
    console.log(`Recovery browser evidence: ${root}`);
  } finally { if(browser) await browser.close(); await run('stop','--all'); await command(otherRuns,'stop','--all'); }
});

// Exercises the small desktop panel and real saved updates, not particular CSS declarations.
test('narrow panel: readable rejection, safe automatic updates, and retained rejected sources', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'session-planner-browser-'));
  const runs = path.join(root, 'runs');
  const intake = path.join(root, 'intake.md'), body = path.join(root, 'body.md');
  fs.writeFileSync(intake, '# A launch with several independently refinable decisions');
  fs.writeFileSync(body, '## Recommendation\nOriginal launch sequence.');
  const run = async (...args) => JSON.parse((await execute(process.execPath, [cli, ...args.map(String), '--runs', runs], { timeout: 20000 })).stdout);
  let browser;
  try {
    const created = await run('create', 'panel', '--intake', intake);
    await run('add', 'panel', '--title', 'Launch sequence', '--body', body);
    await run('add', 'panel', '--title', 'Review responsibilities', '--body', body);
    const proposal = await run('propose', 'panel', '--title', 'Rehearse the handoff', '--body', body);
    browser = await chromium.launch({ headless: true, channel: 'chrome', chromiumSandbox: true });
    const context = await browser.newContext({ viewport: { width: 680, height: 900 } });
    const origin = new URL(created.url).origin;
    await context.route('**/*', r => new URL(r.request().url()).origin === origin ? r.continue() : r.abort());
    const page = await context.newPage(); page.setDefaultTimeout(10000);
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.goto(created.url);
    await page.locator('.card[data-item-id="1"]').click();
    await page.locator('.expanded[data-item-id="1"] .exp-body').filter({ hasText: 'Original launch sequence.' }).waitFor();
    assert.equal(await page.locator('#workflow-guidance').isVisible(), true);
    const input = page.locator('.feedback-input[data-item-id="1"]');
    const displayed = page.locator('.expanded[data-item-id="1"] .exp-body');
    const reject = page.locator('[data-action="reject"][data-id="1"]');
    async function inspectControls(container, label) {
      const evidence = await container.evaluate(el => {
        const bounds = el.getBoundingClientRect();
        const buttons = [...el.querySelectorAll('button')].map(b => {
          const r = b.getBoundingClientRect();
          return { name: b.textContent.trim(), left: r.left, right: r.right, top: r.top, bottom: r.bottom };
        });
        const b = el.querySelector('[data-action="reject"]'), style = getComputedStyle(b), rect = b.getBoundingClientRect();
        let ancestor = b, background;
        while (ancestor) {
          background = getComputedStyle(ancestor).backgroundColor;
          if (background.startsWith('rgb(')) break;
          ancestor = ancestor.parentElement;
        }
        return { bounds: {left: bounds.left, right: bounds.right}, buttons, color: style.color, background, opacity: style.opacity, rejectSize: {width: rect.width, height: rect.height} };
      });
      assert.ok(evidence.buttons.every(b => b.left >= evidence.bounds.left && b.right <= evidence.bounds.right), label + ' controls stay inside their container');
      assert.ok(evidence.rejectSize.width >= 28 && evidence.rejectSize.height >= 28, label + ' has a usable reject target');
      const luminance = color => {
        const v = color.match(/[\d.]+/g).slice(0,3).map(n => { const x=Number(n)/255; return x <= .04045 ? x/12.92 : ((x+.055)/1.055)**2.4; });
        return .2126*v[0]+.7152*v[1]+.0722*v[2];
      };
      const a=luminance(evidence.color), b=luminance(evidence.background);
      assert.equal(Number(evidence.opacity), 1);
      assert.ok((Math.max(a,b)+.05)/(Math.min(a,b)+.05) >= 4.5, label + ' reject text is legible at rest');
      console.log(label + ': ' + JSON.stringify(evidence));
    }
    await inspectControls(page.locator('.expanded[data-item-id="1"]'), 'active');
    await reject.focus(); await page.keyboard.press('Tab'); await page.keyboard.press('Shift+Tab');
    assert.equal(await reject.evaluate(el => el === document.activeElement), true);
    assert.notEqual(await reject.evaluate(el => getComputedStyle(el).outlineStyle), 'none');
    await reject.scrollIntoViewIfNeeded();
    await page.screenshot({path:path.join(root,'narrow-active.png'),fullPage:true});

    // Small viewports start with the sidebar closed. Open it as a user would
    // before accessing staged/shelved work, and check the reduced card width.
    assert.equal(await page.locator('#sidebar').evaluate(el => el.classList.contains('collapsed')), true);
    await page.locator('#sidebar-toggle').click();
    await page.waitForFunction(() => {
      const sidebar = document.getElementById('sidebar');
      return !sidebar.classList.contains('collapsed') && sidebar.getBoundingClientRect().width >= 224;
    });
    await inspectControls(page.locator('.expanded[data-item-id="1"]'), 'active-sidebar-open');
    await reject.scrollIntoViewIfNeeded();
    await page.screenshot({path:path.join(root,'narrow-active-sidebar-open.png'),fullPage:true});

    // No draft: an expanded card changes without a browser reload or user action.
    let current = await run('read', 'panel', 1);
    fs.writeFileSync(body, '## Recommendation\nUpdated launch sequence.');
    await run('update', 'panel', 1, '--revision', current.revision, '--body', body);
    await displayed.filter({hasText:'Updated launch sequence.'}).waitFor();
    // With a draft: retain what was reviewed until the user explicitly reviews the change.
    await input.fill('Keep my unfinished decision.');
    current = await run('read', 'panel', 1);
    fs.writeFileSync(body, '## Recommendation\nLatest launch sequence.');
    await run('update', 'panel', 1, '--revision', current.revision, '--body', body);
    await page.locator('[data-action="review-latest"][data-id="1"]').waitFor();
    assert.match(await displayed.innerText(), /Updated launch sequence/);
    assert.equal(await input.inputValue(), 'Keep my unfinished decision.');
    await reject.click();
    await page.locator('#planner-error').waitFor();
    assert.equal((await run('read','panel',1)).data.status, 'red');
    assert.equal(await input.inputValue(), 'Keep my unfinished decision.');
    await page.locator('[data-action="review-latest"][data-id="1"]').click();
    await displayed.filter({hasText:'Latest launch sequence.'}).waitFor();
    await page.locator('[data-action="approve"][data-id="1"]').click();
    await page.locator('#sb-staged .sb-row[data-item-id="1"]').click();
    await page.locator('[data-action="amend"][data-id="1"]').waitFor();
    await inspectControls(page.locator('.expanded[data-item-id="1"]'), 'staged');
    const staged = await run('read','panel',1);
    assert.equal(staged.data.approval.note,'Keep my unfinished decision.');
    await reject.scrollIntoViewIfNeeded();
    await page.screenshot({path:path.join(root,'narrow-staged.png'),fullPage:true});
    await page.locator('.card[data-item-id="2"]').click();
    await page.locator('[data-action="shelve"][data-id="2"]').click();
    await page.locator('#sb-shelved .sb-row[data-item-id="2"]').click();
    await page.locator('[data-action="bring-back"][data-id="2"]').waitFor();
    await inspectControls(page.locator('.expanded[data-item-id="2"]'), 'shelved');
    await page.locator(`.sb-prop-row[data-prop-id="${proposal.id}"]`).click();
    await page.locator(`.sb-prop-open [data-action="reject"][data-id="${proposal.id}"]`).waitFor();
    await inspectControls(page.locator('.sb-prop-open'), 'proposal');
    await page.locator('[data-action="reject"][data-id="2"]').scrollIntoViewIfNeeded();
    await page.locator(`.sb-prop-open [data-action="reject"][data-id="${proposal.id}"]`).scrollIntoViewIfNeeded();
    await page.screenshot({path:path.join(root,'narrow-shelved-proposal.png'),fullPage:true});
    await page.setViewportSize({width:1360,height:950});
    await inspectControls(page.locator('.expanded[data-item-id="1"]'), 'wide-staged');
    await reject.scrollIntoViewIfNeeded();
    await page.screenshot({path:path.join(root,'wide-staged.png'),fullPage:true});
    await reject.click(); await page.waitForFunction(()=>!pendingActions.has('panel/1'));
    const rejected = await run('read','panel',1);
    assert.equal(rejected.data.status,'rejected'); assert.equal(rejected.content,staged.content);
    assert.equal(fs.existsSync(path.join(runs,'panel','items','item-001.md')),true);
    assert.deepEqual(errors,[]);
    console.log(`Panel/update evidence: ${root}`);
  } finally { if (browser) await browser.close(); await run('stop','--all'); }
});
