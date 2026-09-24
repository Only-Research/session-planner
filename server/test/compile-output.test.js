const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execute = promisify(execFile);
const cli = path.resolve(__dirname, '../planner.js');

// Compiled plans are named after their session and the local minute. These tests
// cover the edge cases: same-minute collisions, a hidden folder left by an
// interrupted compile, older plan.md bundles, and damaged bundle records.
const stampFor = date => {
  const pad = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`;
};

test('compile output: collisions, interrupted compiles, older bundles and damaged records', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'session-planner-compile-'));
  const runs = path.join(root, 'runs');
  const run = async (...args) => JSON.parse((await execute(process.execPath, [cli, ...args, '--runs', runs], { timeout: 20000 })).stdout);
  try {
    const file = (name, text) => { const p = path.join(root, name); fs.writeFileSync(p, text); return p; };
    await run('create', 'naming', '--intake', file('intake.md', '# Naming\n'));
    await run('add', 'naming', '--title', 'Card', '--body', file('body.md', '## Content\nA card.\n'));

    const runtime = JSON.parse(fs.readFileSync(path.join(runs, '.runtime.json'), 'utf8'));
    const api = async (route, body) => (await fetch(`http://127.0.0.1:${runtime.port}${route}`, {
      method: body ? 'POST' : 'GET',
      headers: { 'Content-Type': 'application/json', 'X-Session-Planner-Token': runtime.token },
      body: body ? JSON.stringify(body) : undefined
    })).json();
    const card = await api('/sessions/naming/items/1');
    await api('/sessions/naming/items/1/status', { status: 'green', revision: card.revision, operationId: crypto.randomUUID() });

    // Occupy this minute's and next minute's names, and their -2 slot with a
    // hidden folder as an interrupted compile would leave, so the result is -3
    // whichever minute the compile lands in.
    const output = path.join(runs, 'naming', 'output');
    const now = new Date();
    for (const date of [now, new Date(now.getTime() + 60000)]) {
      fs.mkdirSync(path.join(output, `naming-session-plan-${stampFor(date)}`), { recursive: true });
      fs.mkdirSync(path.join(output, `.naming-session-plan-${stampFor(date)}-2.pending`), { recursive: true });
    }

    const snapshot = await run('resume', 'naming');
    const approvalId = snapshot.items.find(i => i.data.id === 1).approvalBasis;
    const plan = await run('compile', 'naming', '--revision', snapshot.revision,
      '--document', file('plan.md', '# Plan\n\n## Summary\nDo the thing.\n'),
      '--coverage', file('coverage.json', JSON.stringify([{ id: 1, approvalId, sections: ['Summary'] }])));
    const bundle = path.basename(path.dirname(plan.path));
    assert.match(bundle, /^naming-session-plan-\d{4}-\d{2}-\d{2}-\d{4}-3$/);
    assert.equal(path.basename(plan.path), `${bundle}.md`);
    assert.equal(JSON.parse(fs.readFileSync(plan.sources, 'utf8')).document, `${bundle}.md`);

    // An older bundle named plan.md is still found; damaged bundles are skipped
    // with a warning rather than making the whole session unreadable.
    fs.mkdirSync(path.join(output, 'plan-legacy'));
    fs.writeFileSync(path.join(output, 'plan-legacy', 'plan.md'), '# Older plan\n');
    fs.writeFileSync(path.join(output, 'plan-legacy', 'sources.json'), '{"version":1,"approved":[]}');
    const damaged = {
      'broken-null': 'null',
      'broken-json': '{not json',
      'broken-array': '[]',
      'broken-escape': '{"document":"../escape.md"}',
      'broken-folder': '{"document":"folder.md"}',
      'broken-linked': '{"document":"linked.md"}'
    };
    for (const [name, text] of Object.entries(damaged)) {
      fs.mkdirSync(path.join(output, name));
      fs.writeFileSync(path.join(output, name, 'sources.json'), text);
    }
    // A real file where broken-escape's document points: listed only as a top-level
    // output, never through the bundle, or the name check has failed.
    fs.writeFileSync(path.join(output, 'escape.md'), '# Top-level output\n');
    fs.mkdirSync(path.join(output, 'broken-folder', 'folder.md'));
    fs.symlinkSync(path.join(root, 'intake.md'), path.join(output, 'broken-linked', 'linked.md'));
    fs.symlinkSync(path.join(root, 'nowhere'), path.join(output, 'broken-dangling'));
    const names = (await run('resume', 'naming')).output.map(o => o.name).sort();
    assert.deepEqual(names, [`${bundle}/${bundle}.md`, 'escape.md', 'plan-legacy/plan.md'].sort());
    const log = fs.readFileSync(path.join(runs, '.server.log'), 'utf8');
    for (const name of [...Object.keys(damaged), 'broken-dangling']) assert.match(log, new RegExp(`Skipping output ${name}: `));
  } finally {
    await run('stop').catch(() => {});
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a hand-edited card that no longer parses names its file to the agent and the board', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'session-planner-damaged-'));
  const runs = path.join(root, 'runs');
  const run = async (...args) => JSON.parse((await execute(process.execPath, [cli, ...args, '--runs', runs], { timeout: 20000 })).stdout);
  try {
    const file = (name, text) => { const p = path.join(root, name); fs.writeFileSync(p, text); return p; };
    await run('create', 'damaged', '--intake', file('intake.md', '# Damaged\n'));
    await run('add', 'damaged', '--title', 'Budget', '--body', file('body.md', '## Content\nA card.\n'));
    // An unquoted ": " in a hand-edited title makes the metadata invalid YAML.
    const card = path.join(runs, 'damaged', 'items', 'item-001.md');
    const original = fs.readFileSync(card, 'utf8');
    fs.writeFileSync(card, original.replace(/^title: .*$/m, 'title: Budget: phase 1'));

    const resume = await execute(process.execPath, [cli, 'resume', 'damaged', '--runs', runs], { timeout: 20000 }).catch(err => err);
    assert.notEqual(resume.code, 0);
    assert.match(resume.stderr, /damaged\/items\/item-001\.md can't be read: its metadata is not valid YAML \(.*\(\d+:\d+\)\)/);

    const runtime = JSON.parse(fs.readFileSync(path.join(runs, '.runtime.json'), 'utf8'));
    const board = await fetch(`http://127.0.0.1:${runtime.port}/sessions/damaged`, { headers: { 'X-Session-Planner-Token': runtime.token } });
    assert.equal(board.status, 500);
    assert.match((await board.json()).error, /damaged\/items\/item-001\.md can't be read/);

    fs.writeFileSync(card, original);
    assert.equal((await run('resume', 'damaged')).items.length > 0, true);
    // Saved by an editor with Windows line endings, the same card still reads.
    fs.writeFileSync(card, original.replace(/\n/g, '\r\n'));
    assert.equal((await run('resume', 'damaged')).items.find(i => i.data.id === 1).data.title, 'Budget');
  } finally {
    await run('stop').catch(() => {});
    fs.rmSync(root, { recursive: true, force: true });
  }
});
