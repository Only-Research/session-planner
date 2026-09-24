const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile, spawn } = require('node:child_process');
const { promisify } = require('node:util');
const execute = promisify(execFile);
const cli = path.resolve(__dirname, '../planner.js');
const server = path.resolve(__dirname, '../server.js');

// Browser drafts live in sessionStorage, which is scoped to the page's origin.
// A restart that changes port strands them, so a restart must reuse the port.
const roots = [];
test.after(() => { for (const root of roots) fs.rmSync(root, { recursive: true, force: true }); });

function store() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'session-planner-port-'));
  roots.push(root);
  const runs = path.join(root, 'runs');
  const run = async (...args) => JSON.parse((await execute(process.execPath, [cli, ...args, '--runs', runs], { timeout: 20000 })).stdout);
  return { runs, run, stop: () => run('stop').catch(() => {}), port: url => Number(new URL(url).port) };
}

function recordStoppedPort(runs, port) {
  fs.mkdirSync(runs, { recursive: true });
  fs.writeFileSync(path.join(runs, '.runtime.json'), JSON.stringify({
    app: 'session-planner', protocol: 1, status: 'stopped', pid: 1, port,
    instance: '00000000-0000-4000-8000-000000000000', token: 'unused', root: path.resolve(__dirname, '../..'), runs
  }));
}

test('a restart reuses the previous port so open tabs keep their drafts', async () => {
  const s = store();
  try {
    const first = s.port((await s.run('start')).url);
    await s.run('stop');
    const second = s.port((await s.run('start')).url);
    assert.equal(second, first);
  } finally { await s.stop(); }
});

test('a remembered port that is taken falls back to a free one instead of failing', async () => {
  const holder = store();
  const s = store();
  try {
    const taken = holder.port((await holder.run('start')).url);
    recordStoppedPort(s.runs, taken);
    const started = s.port((await s.run('start')).url);
    assert.notEqual(started, taken);
  } finally { await s.stop(); await holder.stop(); }
});

test('a recorded privileged port is ignored rather than wedging startup', async () => {
  const s = store();
  try {
    recordStoppedPort(s.runs, 80);
    const started = s.port((await s.run('start')).url);
    assert.notEqual(started, 80);
    assert.ok(started >= 1024);
  } finally { await s.stop(); }
});

test('a malformed remembered port never crashes the server', async () => {
  for (const value of ['abc', '8080.5', '70000', '-1']) {
    const runs = fs.mkdtempSync(path.join(os.tmpdir(), 'session-planner-preferred-'));
    roots.push(runs);
    const child = spawn(process.execPath, [server], { env: { ...process.env,
      SESSION_PLANNER_RUNS: runs, SESSION_PLANNER_PORT: '0', SESSION_PLANNER_PORT_PREFERRED: value, SESSION_PLANNER_TOKEN: 'test-token' } });
    const ready = await new Promise(resolve => {
      let out = '';
      const timer = setTimeout(() => resolve(false), 5000);
      child.stdout.on('data', chunk => { out += chunk; if (/ready at http:\/\/127\.0\.0\.1:\d+/.test(out)) { clearTimeout(timer); resolve(true); } });
      child.on('exit', () => { clearTimeout(timer); resolve(false); });
    });
    child.kill('SIGTERM');
    assert.ok(ready, `server should start with SESSION_PLANNER_PORT_PREFERRED=${value}`);
  }
});
