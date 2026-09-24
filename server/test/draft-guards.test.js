// Requires an already-installed Playwright package and Google Chrome; see the README's testing section.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const execute=require('node:util').promisify(require('node:child_process').execFile);
const {chromium}=require(process.env.PLANNER_PLAYWRIGHT_PATH||'playwright');
const cli=path.resolve(__dirname,'../planner.js');
async function fixture(work) {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'planner-draft-guards-')),runs=path.join(root,'runs'),intake=path.join(root,'intake.md'),body=path.join(root,'body.md');
 fs.writeFileSync(intake,'# Synthetic draft checks');fs.writeFileSync(body,'## Recommendation\nOriginal choice.');
 const run=async(...args)=>JSON.parse((await execute(process.execPath,[cli,...args.map(String),'--runs',runs],{timeout:20000})).stdout);
 let browser;
 try {
  const created=await run('create','guards','--intake',intake);
  await run('add','guards','--title','First','--body',body);
  browser=await chromium.launch({headless:true,channel:'chrome',chromiumSandbox:true});
  const context=await browser.newContext();const origin=new URL(created.url).origin;
  await context.route('**/*',r=>new URL(r.request().url()).origin===origin?r.continue():r.abort());
  const page=async()=>{const p=await context.newPage();p.setDefaultTimeout(10000);p.on('dialog',d=>d.accept());await p.goto(created.url);return p;};
  await work({root,run,body,page,context,url:created.url});
 } finally {if(browser)await browser.close();await run('stop','--all');assert.equal((await run('status')).running,false);}
}
async function open(p,id=1) {await p.locator(`.card[data-item-id="${id}"]`).click();await p.locator(`.feedback-input[data-item-id="${id}"]`).waitFor();}
const input=(p,id=1)=>p.locator(`.feedback-input[data-item-id="${id}"]`);
const action=(p,name,id=1)=>p.locator(`[data-action="${name}"][data-id="${id}"]`);

test('restored drafts retain old or unknown review basis until explicit review',()=>fixture(async f=>{
 const p=await f.page();await open(p);await input(p).fill('Draft for original choice');
 const original=await f.run('read','guards',1);
 fs.writeFileSync(f.body,'## Recommendation\nChanged choice.');await f.run('update','guards',1,'--revision',original.revision,'--body',f.body);
 await p.reload();
 await p.route('**/sessions/guards/items/1',r=>r.abort());
 await p.locator('.card[data-item-id="1"]').click();await p.locator('#planner-error').waitFor();
 await p.unroute('**/sessions/guards/items/1');await action(p,'retry-load').click();await input(p).waitFor();
 assert.equal(await p.evaluate(()=>draftRevision(state.currentSession,1)),original.revision);
 await action(p,'review-latest').waitFor();
 await input(p).fill('Draft for original choice, edited');
 assert.equal(await p.evaluate(()=>draftRevision(state.currentSession,1)),original.revision);
 assert.equal(await p.evaluate(()=>sessionStorage.getItem(draftKey(state.currentSession,1)+':revision')),original.revision);
 await action(p,'feedback').click();await p.locator('#planner-error').waitFor();
 assert.equal((await f.run('read','guards',1)).data.feedback,'');
 await action(p,'review-latest').click();await p.waitForFunction(()=>!document.querySelector('[data-action="review-latest"]'));
 await action(p,'feedback').click();await p.waitForFunction(()=>document.querySelector('.feedback-input')?.value==='');
 assert.match((await f.run('read','guards',1)).data.feedback,/edited/);
 // Missing persisted provenance must not be invented on the next keystroke.
 await input(p).fill('Unknown source draft');
 await p.evaluate(()=>sessionStorage.removeItem(draftKey(state.currentSession,1)+':revision'));
 await p.reload();
 await p.route('**/sessions/guards/items/1',r=>r.abort());
 await p.locator('.card[data-item-id="1"]').click();await p.locator('#planner-error').waitFor();
 await p.unroute('**/sessions/guards/items/1');await action(p,'retry-load').click();await input(p).waitFor();
 assert.equal(await p.evaluate(()=>draftRevision(state.currentSession,1)),null);
 await input(p).fill('Unknown source draft, edited');
 assert.equal(await p.evaluate(()=>draftRevision(state.currentSession,1)),null);
 await action(p,'feedback').click();await p.locator('#planner-error').waitFor();
 assert.doesNotMatch((await f.run('read','guards',1)).data.feedback,/Unknown source/);
 await action(p,'review-latest').click();await p.waitForFunction(()=>!document.querySelector('[data-action="review-latest"]'));
 await action(p,'feedback').click();await p.waitForFunction(()=>document.querySelector('.feedback-input')?.value==='');
 assert.match((await f.run('read','guards',1)).data.feedback,/Unknown source/);
}));

test('a shelved card can return to the field with its draft preserved and reviewed',()=>fixture(async f=>{
 const p=await f.page(),other=await f.page();await open(p);await input(p).fill('Retain my unsaved thought');
 await open(other);await action(other,'shelve').click();await other.waitForFunction(()=>!pendingActions.has('guards/1'));
 await p.evaluate(()=>pollSession());await action(p,'bring-back').waitFor();
 // A retained older displayed card must first be reviewed, without losing text.
 await action(p,'review-latest').click();await p.waitForFunction(()=>!document.querySelector('[data-action="review-latest"]'));
 const base=await p.evaluate(()=>draftRevision(state.currentSession,1));
 await action(p,'bring-back').click();await input(p).waitFor();
 assert.equal((await f.run('read','guards',1)).data.status,'red');assert.equal(await input(p).inputValue(),'Retain my unsaved thought');
 assert.equal(await p.evaluate(()=>draftRevision(state.currentSession,1)),base);
 await action(p,'feedback').click();await p.locator('#planner-error').waitFor();
 assert.equal((await f.run('read','guards',1)).data.feedback,'');
 await action(p,'review-latest').click();await p.waitForFunction(()=>!document.querySelector('[data-action="review-latest"]'));
 await action(p,'feedback').click();await p.waitForFunction(()=>document.querySelector('.feedback-input')?.value==='');
 assert.equal((await f.run('read','guards',1)).data.feedback.split('Retain my unsaved thought').length-1,1);
}));

test('ordinary cards and proposals expose no mutation before first detail load',()=>fixture(async f=>{
 await f.run('add','guards','--title','Second','--body',f.body);
 const proposal=await f.run('propose','guards','--title','Proposal','--body',f.body);
 const p=await f.page();const mutations=[];p.on('request',r=>{if(r.method()==='POST')mutations.push(r.url());});
 let release,arrived;const held=new Promise(r=>release=r),seen=new Promise(r=>arrived=r);
 const heldRoutes=[];
 await p.route('**/sessions/guards/items/1',r=>{const pending=(async()=>{arrived();await held;await r.continue();})();heldRoutes.push(pending);return pending;});
 try {
  await p.locator('.card[data-item-id="1"]').click();await seen;await open(p,2);
  assert.equal(await action(p,'approve').count(),0);
  await p.evaluate(()=>{ void performAction('approve',1,document.createElement('button')); });
  assert.equal((await f.run('read','guards',1)).data.status,'red');assert.equal(mutations.length,0);
 } finally {release();await Promise.all(heldRoutes);await p.unroute('**/sessions/guards/items/1');}
 await p.evaluate(()=>pollSession());await action(p,'approve').waitFor();
 await action(p,'approve').click();await p.waitForFunction(()=>!pendingActions.has('guards/1'));
 assert.equal((await f.run('read','guards',1)).data.status,'green');
 let releaseProp,arrivedProp;const heldProp=new Promise(r=>releaseProp=r),seenProp=new Promise(r=>arrivedProp=r);
 const heldPropRoutes=[];
 await p.route(`**/sessions/guards/items/${proposal.id}`,r=>{const pending=(async()=>{arrivedProp();await heldProp;await r.continue();})();heldPropRoutes.push(pending);return pending;});
 try {
  await p.locator(`[data-prop-id="${proposal.id}"]`).click();await seenProp;
  await p.locator('[data-section="staged"]').click();
  assert.equal(await action(p,'stage',proposal.id).count(),0);
  assert.equal(await action(p,'to-field',proposal.id).count(),0);
  await p.evaluate(id=>{ void performAction('stage',id,document.createElement('button')); },proposal.id);
  assert.equal((await f.run('read','guards',proposal.id)).data.status,'proposed');
 } finally {releaseProp();await Promise.all(heldPropRoutes);await p.unroute(`**/sessions/guards/items/${proposal.id}`);}
 await p.evaluate(()=>pollSession());await action(p,'stage',proposal.id).waitFor();
 assert.deepEqual(await p.evaluate(()=>ttsChunk('Context. Final recommendation')),['Context. Final recommendation']);
}));

test('browser Back and Forward retain an unsent new-item form',()=>fixture(async f=>{
 const p=await f.page();await p.goto(f.url.split('#')[0]);
 await p.locator('.session-list-item[data-session="guards"]').click();await p.locator('.card[data-item-id="1"]').waitFor();
 await p.locator('#nav-new-item').click();await p.locator('#new-item-title').fill('Unsent new card');await p.locator('#new-item-notes').fill('Detailed unsent context');
 await p.goBack();await p.locator('.session-list-item[data-session="guards"]').waitFor();
 await p.goForward();await p.locator('.card[data-item-id="1"]').waitFor();await p.locator('#nav-new-item').click();
 assert.equal(await p.locator('#new-item-title').inputValue(),'Unsent new card');
 assert.equal(await p.locator('#new-item-notes').inputValue(),'Detailed unsent context');
 await p.reload();await p.locator('.card[data-item-id="1"]').waitFor();await p.locator('#nav-new-item').click();
 assert.equal(await p.locator('#new-item-title').inputValue(),'Unsent new card');
 await p.locator('#new-item-cancel').click();await p.locator('#nav-new-item').click();
 assert.equal(await p.locator('#new-item-title').inputValue(),'');
}));


test('creation and receipt replay preserve later form edits but clear submitted drafts',()=>fixture(async f=>{
 const p=await f.page();await p.locator('.card[data-item-id="1"]').waitFor();
 const title=p.locator('#new-item-title'),notes=p.locator('#new-item-notes');
 for(const retry of [false,true]) {
  await p.locator('#nav-new-item').click();await title.fill('Submitted '+retry);await notes.fill('Original');
  let release,arrived;const held=new Promise(r=>release=r),seen=new Promise(r=>arrived=r);const routes=[];
  await p.route('**/sessions/guards/items/new',r=>{const pending=(async()=>{arrived();await held;if(retry){await r.fetch();await r.abort();}else await r.continue();})();routes.push(pending);return pending;},{times:1});
  try {
   await p.locator('#new-item-create').click();await seen;
   await title.fill('Later '+retry);await notes.fill('Keep this newer text');
  } finally {release();await Promise.all(routes);}
  if(retry){await p.locator('[data-retry-id="new-item"]').click();await p.waitForFunction(()=>!document.querySelector('[data-retry-id="new-item"]'));}
  await p.waitForFunction(()=>!document.getElementById('new-item-create').disabled);
  await p.reload();await p.locator('.card[data-item-id="1"]').waitFor();await p.locator('#nav-new-item').click();
  assert.equal(await title.inputValue(),'Later '+retry);assert.equal(await notes.inputValue(),'Keep this newer text');
  // Complete the newer form with no additional edits; persistent state must clear too.
  if(retry)await p.route('**/sessions/guards/items/new',async r=>{await r.fetch();await r.abort();},{times:1});
  await p.locator('#new-item-create').click();
  if(retry){await p.locator('[data-retry-id="new-item"]').click();await p.waitForFunction(()=>!document.querySelector('[data-retry-id="new-item"]'));}
  await p.waitForFunction(()=>document.getElementById('new-item-title').value==='');
  await p.reload();await p.locator('.card[data-item-id="1"]').waitFor();await p.locator('#nav-new-item').click();
  assert.equal(await title.inputValue(),'');assert.equal(await notes.inputValue(),'');
  await p.locator('#new-item-cancel').click();
 }
 const saved=(await f.run('resume','guards')).items;
 for(const title of ['Submitted false','Submitted true','Later false','Later true']) assert.equal(saved.filter(i=>i.data.title===title).length,1);
}));
