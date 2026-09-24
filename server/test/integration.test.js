const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execute = promisify(execFile);
const cli = path.resolve(__dirname, '../planner.js');
function fixture(env = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'session-planner-test-'));
  const runs = path.join(root, 'runs');
  const intake = path.join(root, 'intake.md');
  const body = path.join(root, 'body.md');
  fs.writeFileSync(intake, '# Campaign\nKeep separate pieces and the Tuesday deadline.\n');
  fs.writeFileSync(body, '## Context\nThe campaign.\n\n## Content\nA substantive component.\n\n## Recommendation\nWork through it together.\n');
  return { root, runs, intake, body,
    async run(...args) {
      const result = await execute(process.execPath, [cli, ...args.map(String), '--runs', runs], { cwd: os.tmpdir(), timeout: 20000, env: { ...process.env, ...env } });
      return JSON.parse(result.stdout);
    },
    async api(route, data, overrides = {}) {
      const runtime = JSON.parse(fs.readFileSync(path.join(runs, '.runtime.json'), 'utf8'));
      if (data && /\/items\/\d+\/(status|feedback)$/.test(route)) {
        if (!data.revision) {
          const current = await fetch(`http://127.0.0.1:${runtime.port}${route.replace(/\/(status|feedback)$/, '')}`, { headers: { 'X-Session-Planner-Token': runtime.token } });
          data = { ...data, revision: (await current.json()).revision };
        }
        data = { operationId: require('node:crypto').randomUUID(), ...data };
      }
      const response = await fetch(`http://127.0.0.1:${runtime.port}${route}`, {
        method: data === undefined ? 'GET' : 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Session-Planner-Token': runtime.token, ...overrides },
        body: data === undefined ? undefined : JSON.stringify(data)
      });
      return { status: response.status, data: await response.json() };
    }
  };
}

test('complete isolated local loop: creation, refresh, protection, compile, restart and portability', async () => {
  const f = fixture();
  const second = fixture();
  try {
    const created = await f.run('create', 'campaign', '--intake', f.intake);
    assert.match(created.url, /^http:\/\/127\.0\.0\.1:\d+\/viewer\/index.html#campaign$/);
    const initial = await f.run('resume', 'campaign');
    assert.equal(initial.items.length, 15);
    assert.match(initial.reference[0].content, /Tuesday/);
    const added = await f.run('add', 'campaign', '--title', 'Launch', '--body', f.body);
    assert.equal(added.id, 1);
    const proposal = await f.run('propose', 'campaign', '--title', 'Rehearsal', '--body', f.body);
    assert.equal(proposal.id, 16);
    assert.equal((await f.run('read', 'campaign', 16)).data.type, 'proposed');
    const before = await f.run('read', 'campaign', 1);
    assert.equal((await f.api('/sessions/campaign/items/1/feedback', { text: 'Include the launch team.' })).status, 200);
    await assert.rejects(f.run('update', 'campaign', 1, '--revision', before.revision, '--body', f.body), /Item changed/);
    const batch = await f.run('begin-refresh', 'campaign');
    await assert.rejects(f.run('finish-refresh', 'campaign', '--batch', batch.batch), /still needs processing/);
    const current = await f.run('read', 'campaign', 1);
    fs.writeFileSync(f.body, current.content + '\nThe launch team is included.\n');
    await f.run('update', 'campaign', 1, '--revision', current.revision, '--body', f.body, '--batch', batch.batch);
    assert.match((await f.run('read', 'campaign', 1)).data.feedback, /launch team/);
    await f.api('/sessions/campaign/items/1/feedback', { text: 'Also cover Tuesday.' });
    await assert.rejects(f.run('finish-refresh', 'campaign', '--batch', batch.batch), /New interactions arrived/);
    const retry = await f.run('begin-refresh', 'campaign');
    const newItem = retry.items.find(item => item.data.id === 1);
    assert.ok(newItem);
    fs.appendFileSync(f.body, '\nThe Tuesday deadline is included.\n');
    await f.run('update', 'campaign', 1, '--revision', newItem.revision, '--body', f.body, '--batch', retry.batch);
    await f.run('finish-refresh', 'campaign', '--batch', retry.batch);
    const empty = await f.run('begin-refresh', 'campaign');
    assert.equal(empty.items.length, 0);
    await f.run('finish-refresh', 'campaign', '--batch', empty.batch);
    await f.api('/sessions/campaign/items/1/status', { status: 'green' });
    const approved = await f.run('read', 'campaign', 1);
    await assert.rejects(f.run('update', 'campaign', 1, '--revision', approved.revision, '--body', f.body), /approved, shelved/);
    const snapshot = await f.run('resume', 'campaign');
    const plan = await f.run('export-sources', 'campaign', '--revision', snapshot.revision, '--framing', f.intake);
    assert.ok(fs.readFileSync(plan.path, 'utf8').includes(approved.content));
    for (let n = 2; n <= 16; n++) await f.run('add', 'campaign', '--title', `Component ${n}`, '--body', f.body);
    assert.equal((await f.run('resume', 'campaign')).items.length, 17);
    const preserved = await f.run('read', 'campaign', 1);
    await f.run('stop');
    assert.equal((await f.run('status')).running, false);
    const resumed = await f.run('resume', 'campaign');
    assert.equal(resumed.items.find(item => item.data.id === 1).content, preserved.content);
    // Copy only the durable unit; no runtime token, parent repo, or old port.
    fs.mkdirSync(second.runs, { recursive: true });
    fs.cpSync(path.join(f.runs, 'campaign'), path.join(second.runs, 'campaign'), { recursive: true });
    const portable = await second.run('resume', 'campaign');
    assert.deepEqual(portable.items, resumed.items);
    await f.run('create', 'other', '--intake', f.intake);
    await assert.rejects(f.run('stop'), /Several sessions/);
    assert.equal((await f.run('resume', 'other')).items.filter(item => item.data.status !== 'blank').length, 0);
  } finally {
    await f.run('stop', '--all');
    await second.run('stop', '--all');
  }
});

test('localhost boundaries reject foreign origins, tokens, invalid paths and linked data', async () => {
  const f = fixture();
  try {
    await f.run('create', 'safe', '--intake', f.intake);
    assert.equal((await f.api('/sessions', undefined, { 'X-Session-Planner-Token': 'wrong' })).status, 401);
    assert.equal((await f.api('/sessions', undefined, { Origin: 'https://untrusted.example' })).status, 403);
    assert.equal((await f.api('/sessions/new', { name: '../escape' })).status, 400);
    assert.equal(fs.existsSync(path.join(f.root, 'escape')), false);
    assert.equal((await f.api('/sessions/new', { name: 'bad/name' })).status, 400);
    assert.equal((await f.api('/sessions/safe/items/1/status', { status: 'invented' })).status, 400);
    const runtime = JSON.parse(fs.readFileSync(path.join(f.runs, '.runtime.json'), 'utf8'));
    const badHost = await new Promise((resolve, reject) => {
      const request = http.get(`http://127.0.0.1:${runtime.port}/sessions`, { headers: { Host: 'untrusted.invalid' } }, response => { response.resume(); resolve(response.statusCode); });
      request.on('error', reject);
    });
    assert.equal(badHost, 403);
    const linked = path.join(f.runs, 'linked');
    fs.symlinkSync(f.root, linked);
    assert.notEqual((await f.api('/agent/sessions/linked')).status, 200);
    await f.run('add', 'safe', '--title', 'Feedback', '--body', f.body);
    const raw = await f.api('/sessions/safe/items/1/feedback', { text: 'quote: "\nline two' });
    assert.equal(raw.status, 200);
    assert.match((await f.run('read', 'safe', 1)).data.feedback, /line two/);
  } finally { await f.run('stop', '--all'); }
});

test('busy ports and repeated start leave other services alone', async () => {
  const f = fixture();
  const other = http.createServer((req, res) => res.end('unrelated'));
  await new Promise(resolve => other.listen(0, '127.0.0.1', resolve));
  const port = other.address().port;
  try {
    await assert.rejects(f.run('start', '--port', port), /failed to start/);
    assert.equal(await (await fetch(`http://127.0.0.1:${port}`)).text(), 'unrelated');
    const [one, two] = await Promise.all([f.run('start'), f.run('start')]);
    assert.equal(one.url, two.url);
    assert.notEqual(new URL(one.url).port, String(port));
  } finally {
    await f.run('stop', '--all');
    await new Promise(resolve => other.close(resolve));
  }
});

test('qualified approvals: stale decisions, retries, amendments, recovery, preserved source and composed exit', async () => {
  const f = fixture();
  try {
    await f.run('create', 'decisions', '--intake', f.intake, '--parent', f.root);
    fs.writeFileSync(f.body, '## Choices\n[Game A](https://example.com/a) or [Game B](https://example.com/b).\n');
    await f.run('add', 'decisions', '--title', 'Gift', '--body', f.body);
    const first = await f.run('read', 'decisions', 1);
    await f.api('/sessions/decisions/items/1/feedback', { text: 'Include the product link.' });
    assert.equal((await f.api('/sessions/decisions/items/1/status', { status: 'green', revision: first.revision })).status, 409);
    const current = await f.run('read', 'decisions', 1);
    const command = { status: 'green', note: 'Game A only.', revision: current.revision, operationId: 'approval-operation-1' };
    assert.equal((await f.api('/sessions/decisions/items/1/status', command)).status, 200);
    const staged = await f.run('read', 'decisions', 1);
    assert.equal(staged.content, first.content);
    assert.equal(staged.data.approval.note, 'Game A only.');
    assert.equal(staged.data.approval.source.feedback, current.data.feedback);
    assert.equal((await f.api('/sessions/decisions/items/1/status', command)).data.replayed, true);
    assert.equal((await f.api('/sessions/decisions/items/1/status', { ...command, note: 'B instead.' })).status, 409);
    assert.equal((await f.run('read', 'decisions', 1)).data.interactions.length, 2);
    assert.equal((await f.api('/sessions/decisions/items/1/feedback', { text: 'A revision request' })).status, 409);
    await f.api('/sessions/decisions/items/1/status', { status: 'green', note: 'Game A only, physical edition.' });
    const amended = await f.run('read', 'decisions', 1);
    assert.equal(amended.data.approvalHistory[0].id, staged.data.approval.id);
    assert.equal(amended.content, first.content);
    const snapshot = await f.run('resume', 'decisions');
    const document = path.join(f.root, 'plan.md');
    const coverage = path.join(f.root, 'coverage.json');
    fs.writeFileSync(document, '# Campaign\n\n## Gift\nBuy [Game A](https://example.com/a), physical edition.\n');
    fs.writeFileSync(coverage, JSON.stringify([{ id: 1, approvalId: amended.approvalBasis, sections: ['Gift'] }]));
    const plan = await f.run('compile', 'decisions', '--revision', snapshot.revision, '--document', document, '--coverage', coverage);
    assert.equal(plan.parentWorkspace, f.root);
    // The plan is named after its session so it identifies itself wherever it is copied.
    const bundle = path.basename(path.dirname(plan.path));
    assert.match(bundle, /^decisions-session-plan-\d{4}-\d{2}-\d{2}-\d{4}(-\d+)?$/);
    assert.equal(path.basename(plan.path), `${bundle}.md`);
    assert.doesNotMatch(fs.readFileSync(plan.path, 'utf8'), /Game B/);
    const evidence = JSON.parse(fs.readFileSync(plan.sources, 'utf8'));
    assert.equal(evidence.approved[0].content, first.content);
    assert.equal(evidence.approved[0].approval.note, amended.data.approval.note);
    await assert.rejects(f.run('compile', 'decisions', '--revision', snapshot.revision, '--document', document, '--coverage', coverage), /Session changed/);
    assert.ok((await f.run('resume', 'decisions')).output.some(o => o.sources?.approved.length === 1));
    // Reopen and revise: old source and qualifications remain recoverable.
    await f.api('/sessions/decisions/items/1/status', { status: 'red' });
    const reopened = await f.run('read', 'decisions', 1);
    assert.equal(reopened.data.approval, undefined);
    assert.equal(reopened.data.approvalHistory.length, 2);
    fs.writeFileSync(f.body, '## Content\nRevised component.\n');
    await f.run('update', 'decisions', 1, '--revision', reopened.revision, '--body', f.body);
    await f.api('/sessions/decisions/items/1/status', { status: 'green' });
    const reapproved = await f.run('read', 'decisions', 1);
    assert.equal(reapproved.data.approval.note, '');
    assert.equal(reapproved.data.approvalHistory[0].source.content, first.content);
    assert.equal(fs.readFileSync(plan.path, 'utf8').includes('Game A'), true);
    let latest = await f.run('resume', 'decisions');
    await assert.rejects(f.run('compile', 'decisions', '--revision', latest.revision, '--document', document, '--coverage', coverage), /Approval for item/);
    fs.writeFileSync(coverage, '[]');
    await assert.rejects(f.run('compile', 'decisions', '--revision', latest.revision, '--document', document, '--coverage', coverage), /every approved item/);
    // Item commit succeeds but checksum update fails; same receipt repairs it.
    const dir = path.join(f.runs, 'decisions');
    const checksum = path.join(dir, '.checksums.json');
    fs.renameSync(checksum, `${checksum}.saved`);
    fs.mkdirSync(checksum);
    const repair = { status: 'red', revision: reapproved.revision, operationId: 'repair-operation-1' };
    assert.equal((await f.api('/sessions/decisions/items/1/status', repair)).status, 500);
    fs.renameSync(checksum, `${checksum}.failed-directory`);
    fs.renameSync(`${checksum}.saved`, checksum);
    assert.equal((await f.api('/sessions/decisions/items/1/status', repair)).data.replayed, true);
    const log = fs.readFileSync(path.join(dir, 'changelog.md'), 'utf8');
    assert.equal(log.split('[operation:item-001:interaction:repair-operation-1]').length - 1, 1);
    await f.run('stop');
    assert.equal((await f.run('resume', 'decisions')).output.length, 1);
  } finally { await f.run('stop', '--all'); }
});

test('processing evidence survives partial and successive refreshes; legacy approval is explicit', async () => {
  const f = fixture();
  try {
    await f.run('create', 'review', '--intake', f.intake);
    for (const title of ['One', 'Two']) await f.run('add', 'review', '--title', title, '--body', f.body);
    for (const id of [1, 2]) await f.api(`/sessions/review/items/${id}/feedback`, { text: `Feedback ${id}` });
    const batch = await f.run('begin-refresh', 'review');
    const item = batch.items.find(i => i.data.id === 1);
    await f.run('ack', 'review', 1, '--batch', batch.batch, '--revision', item.revision, '--reason', 'Already covered.');
    assert.equal((await f.run('read', 'review', 1)).processingState, 'reviewed');
    assert.equal((await f.run('read', 'review', 2)).processingState, 'pending');
    await f.run('stop');
    const next = await f.run('begin-refresh', 'review');
    assert.deepEqual(next.items.map(i => i.data.id), [2]);
    await f.run('update', 'review', 2, '--revision', next.items[0].revision, '--batch', next.batch, '--body', f.body);
    await f.run('finish-refresh', 'review', '--batch', next.batch);
    const empty = await f.run('begin-refresh', 'review');
    await f.run('finish-refresh', 'review', '--batch', empty.batch);
    assert.equal((await f.run('read', 'review', 1)).processingState, 'reviewed');
    assert.equal((await f.run('read', 'review', 2)).processingState, 'updated');
    // Fail after the item body/processing evidence commits but before bookkeeping.
    await f.api('/sessions/review/items/2/feedback', { text: 'Handle this once.' });
    const interrupted = await f.run('begin-refresh', 'review');
    const second = interrupted.items.find(i => i.data.id === 2);
    const checksum = path.join(f.runs, 'review', '.checksums.json');
    fs.renameSync(checksum, checksum + '.saved'); fs.mkdirSync(checksum);
    await assert.rejects(f.run('update', 'review', 2, '--revision', second.revision, '--batch', interrupted.batch, '--body', f.body));
    fs.renameSync(checksum, checksum + '.failed-directory'); fs.renameSync(checksum + '.saved', checksum);
    const recovered = await f.run('begin-refresh', 'review');
    assert.equal(recovered.items.some(i => i.data.id === 2), false);
    await f.run('finish-refresh', 'review', '--batch', recovered.batch);

    await f.api('/sessions/review/items/1/feedback', { text: 'New feedback' });
    assert.equal((await f.run('read', 'review', 1)).processingState, 'pending');
    assert.equal((await f.run('read', 'review', 2)).processingState, 'updated');
    // A historical green item has no manufactured decision note.
    const legacy = path.join(f.runs, 'review', 'items', 'item-003.md');
    fs.writeFileSync(legacy, '---\nid: 3\ntitle: Legacy\nstatus: green\ntype: item\nfeedback: ""\n---\nKeep all three backups.\n');
    const old = await f.run('read', 'review', 3);
    assert.match(old.approvalBasis, /^legacy-/);
    assert.equal(old.data.approval, undefined);
  } finally { await f.run('stop', '--all'); }
});

test('receipts recover unseen feedback, scope events per item, and keep creation retries singular', async () => {
  const f = fixture();
  let restore;
  try {
    const created = await f.run('create', 'recovery', '--intake', f.intake);
    const dir = created.path;
    const obstruct = () => {
      const file = path.join(dir, '.checksums.json'), suffix = require('node:crypto').randomUUID();
      fs.renameSync(file, `${file}.${suffix}.saved`); fs.mkdirSync(file);
      return () => { fs.renameSync(file, `${file}.${suffix}.fault`); fs.renameSync(`${file}.${suffix}.saved`, file); };
    };
    const finishPending = async () => {
      const b = await f.run('begin-refresh', 'recovery');
      for (const item of b.items) await f.run('ack', 'recovery', item.data.id, '--revision', item.revision, '--batch', b.batch, '--reason', 'Reviewed synthetic feedback');
      await f.run('finish-refresh', 'recovery', '--batch', b.batch);
    };
    await f.run('add', 'recovery', '--title', 'One', '--body', f.body);
    await f.run('add', 'recovery', '--title', 'Two', '--body', f.body);
    await finishPending();
    const empty = await f.run('begin-refresh', 'recovery');
    restore = obstruct();
    assert.equal((await f.api('/sessions/recovery/items/1/feedback', { text: 'Saved despite bookkeeping failure' })).status, 500);
    restore(); restore = null;
    await assert.rejects(f.run('finish-refresh', 'recovery', '--batch', empty.batch), /New interactions arrived/);
    assert.deepEqual((await f.run('begin-refresh', 'recovery')).items.map(i => i.data.id), [1]);
    await finishPending();
    for (const id of [1, 2]) assert.equal((await f.api(`/sessions/recovery/items/${id}/feedback`, { text: `Feedback ${id}`, operationId: 'shared-receipt-id' })).status, 200);
    assert.deepEqual((await f.run('begin-refresh', 'recovery')).items.map(i => i.data.id), [1, 2]);
    await finishPending();
    restore = obstruct();
    await assert.rejects(f.run('add', 'recovery', '--title', 'Retry me', '--body', f.body));
    restore(); restore = null;
    const retry = await f.run('add', 'recovery', '--title', 'Retry me', '--body', f.body);
    assert.equal(retry.replayed, true);
    await f.api(`/sessions/recovery/items/${retry.id}/status`, { status: 'green' });
    assert.equal((await f.run('add', 'recovery', '--title', 'Retry me', '--body', f.body)).id, retry.id);
    assert.equal((await f.run('read', 'recovery', retry.id)).data.status, 'green');
    assert.equal((await f.run('resume', 'recovery')).items.filter(i => i.data.title === 'Retry me').length, 1);
    assert.notEqual((await f.run('add', 'recovery', '--title', 'Retry me', '--body', f.body, '--operation', 'intentional-repeat')).id, retry.id);
    const original = fs.readFileSync(path.join(dir, 'session.yaml'), 'utf8');
    assert.equal((await f.run('create', 'recovery', '--intake', f.intake)).replayed, true);
    assert.equal(fs.readFileSync(path.join(dir, 'session.yaml'), 'utf8'), original);
    fs.appendFileSync(f.intake, '\nDifferent intake');
    await assert.rejects(f.run('create', 'recovery', '--intake', f.intake), /different or legacy intake/);
    assert.equal((await f.api('/sessions/recovery/items/1junk')).status, 400);
    assert.equal((await f.api('/sessions/recovery/items/new', {title:'Bad',proposed:'false'})).status, 400);
    assert.equal((await f.api('/sessions/recovery/items/new', {title:'Bad',notes:{bad:true}})).status, 400);
    assert.equal((await f.api('/sessions/recovery/items/new', [])).status, 400);
  } finally { if (restore) restore(); await f.run('stop', '--all'); }
});

test('legacy inbox retry never duplicates a committed card; compile requires real headings', async () => {
  const f = fixture();
  try {
    const { path: dir } = await f.run('create', 'legacy', '--intake', f.intake);
    const inbox = path.join(dir, 'inbox');
    fs.writeFileSync(path.join(inbox, 'processed'), 'Obstruct archive move');
    fs.writeFileSync(path.join(inbox, 'proposal.md'), 'Legacy proposal\n\n## Recommendation\nKeep this once.\n');
    const waitFor = async condition => { const deadline=Date.now()+10000; while (!(await condition())) { if(Date.now()>deadline) throw new Error('Timed out waiting for legacy import'); await new Promise(r=>setTimeout(r,200)); } };
    await waitFor(async () => (await f.run('resume','legacy')).items.some(i=>i.data.title==='Legacy proposal'));
    await new Promise(r=>setTimeout(r,5500));
    assert.equal((await f.run('resume','legacy')).items.filter(i=>i.data.title==='Legacy proposal').length,1);
    fs.renameSync(path.join(inbox,'processed'),path.join(inbox,'archive-obstruction.saved'));
    await waitFor(async()=>!fs.existsSync(path.join(inbox,'proposal.md')));
    assert.equal((await f.run('resume','legacy')).items.filter(i=>i.data.title==='Legacy proposal').length,1);
    await f.run('add','legacy','--title','Decision','--body',f.body);
    const approved=(await f.api('/sessions/legacy/items/1/status',{status:'green',note:'Use the recommendation'})).data;
    const blank = await f.run('read','legacy',2);
    await f.run('update','legacy',2,'--title','Supported blank','--revision',blank.revision,'--body',f.body);
    const blankFile=path.join(dir,'items','item-003.md');
    const raw=fs.readFileSync(blankFile,'utf8');
    fs.writeFileSync(blankFile,raw.replace(/(---\n[\s\S]*?---\n)[\s\S]*/, '$1Legacy title\n\n## Content\nLegacy body'));
    await waitFor(async()=>(await f.run('read','legacy',3)).data.status==='red');
    const changes=fs.readFileSync(path.join(dir,'changelog.md'),'utf8');
    assert.match(changes,/item-002: blank populated/);
    assert.match(changes,/item-003: legacy blank populated/);
    const snapshot=await f.run('resume','legacy');
    const coverage=[{id:1,approvalId:approved.approvalBasis,sections:['Fake']}];
    assert.equal((await f.api('/agent/sessions/legacy/compile',{revision:snapshot.revision,document:'# Plan\n\n```md\n## Fake\n```',coverage})).status,400);
    assert.equal((await f.api('/agent/sessions/legacy/compile',{revision:snapshot.revision,document:'# Plan\n\n## Fake\nActual content',coverage:[null]})).status,400);
    assert.equal((await f.api('/agent/sessions/legacy/compile',{revision:snapshot.revision,document:'# Plan\n\n## Fake\nActual content',coverage})).status,200);
  } finally { await f.run('stop','--all'); }
});

test('interrupted scaffold is hidden and retry publishes exactly one complete session', async () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'planner-scaffold-fault-'));
  const hook=path.join(root,'fault.cjs'), marker=path.join(root,'fired');
  fs.writeFileSync(hook, `const fs=require('node:fs'); const rename=fs.renameSync; fs.renameSync=function(from,to){ if(String(to).endsWith('/items/item-008.md')&&!fs.existsSync(${JSON.stringify(marker)})){fs.writeFileSync(${JSON.stringify(marker)},'once');const e=new Error('Synthetic scaffold failure');e.code='EIO';throw e;} return rename.apply(this,arguments); };`);
  const f=fixture({NODE_OPTIONS:`--require=${hook}`});
  try {
    await assert.rejects(f.run('create','atomic','--intake',f.intake),/Synthetic scaffold failure/);
    assert.equal(fs.existsSync(path.join(f.runs,'atomic')),false);
    assert.deepEqual((await f.api('/sessions')).data,[]);
    assert.equal(fs.readdirSync(f.runs).filter(n=>n.endsWith('.pending')).length,1);
    await f.run('create','atomic','--intake',f.intake);
    assert.equal((await f.run('resume','atomic')).items.length,15);
    assert.equal((await f.api('/sessions')).data.length,1);
  } finally { await f.run('stop','--all'); }
});


test('immediate stop/start waits for process exit and always gets a new instance', async () => {
  const f=fixture();
  try {
    await f.run('start');
    for(let n=0;n<5;n++) {
      const before=JSON.parse(fs.readFileSync(path.join(f.runs,'.runtime.json'),'utf8'));
      assert.equal((await f.run('stop','--all')).stopped,true);
      assert.throws(()=>process.kill(before.pid,0),{code:'ESRCH'});
      await f.run('start','--port',before.port);
      const after=JSON.parse(fs.readFileSync(path.join(f.runs,'.runtime.json'),'utf8'));
      assert.notEqual(after.instance,before.instance);
    }
  } finally { await f.run('stop','--all'); }
});


test('concurrent starters preserve abandoned locks and never spawn through them', async () => {
  const f=fixture();
  fs.mkdirSync(f.runs,{recursive:true});
  const deadPid=Number((await execute(process.execPath,['-e','console.log(process.pid)'])).stdout.trim());
  assert.throws(()=>process.kill(deadPid,0),{code:'ESRCH'});
  const lock=path.join(f.runs,'.startup-lock');
  const record=JSON.stringify({pid:deadPid,started:'synthetic abandoned launch'});
  fs.writeFileSync(lock,record);
  const identity=fs.statSync(lock);
  const results=await Promise.allSettled([f.run('start'),f.run('start')]);
  for(const result of results) { assert.equal(result.status,'rejected');assert.match(result.reason.message,/Startup lock retained/); }
  assert.equal(fs.readFileSync(lock,'utf8'),record);
  assert.equal(fs.statSync(lock).ino,identity.ino);
  assert.equal(fs.existsSync(path.join(f.runs,'.runtime.json')),false);
  assert.deepEqual(fs.readdirSync(f.runs),['.startup-lock']);
});


test('template scaffolding preserves all blank card metadata and Markdown', async () => {
  const f = fixture();
  try {
    await f.run('create', 'template-check', '--intake', f.intake);
    const snapshot = await f.run('resume', 'template-check');
    const template = fs.readFileSync(path.resolve(__dirname, '../../templates/item-template.md'), 'utf8');
    const match = template.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
    assert.ok(match);
    const expected = require('js-yaml').load(match[1]);
    assert.equal(snapshot.items.length, 15);
    for (let id = 1; id <= 15; id++) {
      const item = await f.run('read', 'template-check', id);
      for (const [key, value] of Object.entries(expected)) assert.deepEqual(item.data[key], key === 'id' ? id : value);
      assert.equal(item.content.trim(), match[2].trim());
    }
  } finally { await f.run('stop', '--all'); }
});

test('request queries never invoke the unused extended parser, including before host rejection', async () => {
  const hookRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'session-planner-query-'));
  const hook = path.join(hookRoot, 'reject-query-parser.cjs');
  fs.writeFileSync(hook, `require(${JSON.stringify(require.resolve('qs'))}).parse = () => { throw new Error('Unexpected query parser execution'); };\n`);
  const f = fixture({ NODE_OPTIONS: `--require ${JSON.stringify(hook)}` });
  try {
    await f.run('create', 'query-check', '--intake', f.intake);
    const route = '/sessions/query-check?arbitrary[nested][value]=hello&repeated[]=a&repeated[]=b';
    assert.equal((await f.api(route)).status, 200);
    // Node fetch discards a supplied Host header; raw HTTP preserves this test input.
    const runtime = JSON.parse(fs.readFileSync(path.join(f.runs, '.runtime.json'), 'utf8'));
    const rejected = await new Promise((resolve, reject) => {
      const request = http.get(`http://127.0.0.1:${runtime.port}${route}`, {
        headers: { Host: 'untrusted.example', 'X-Session-Planner-Token': runtime.token }
      }, response => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', chunk => { body += chunk; });
        response.on('end', () => resolve({ status: response.statusCode, body }));
        response.on('error', reject);
      });
      request.on('error', reject);
    });
    assert.equal(rejected.status, 403);
    assert.equal(JSON.parse(rejected.body).error, 'forbidden host');
  } finally { await f.run('stop', '--all'); }
});
