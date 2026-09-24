#!/usr/bin/env node
// Local helper: JSON on stdout, actionable errors on stderr. No downloads.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const ROOT = path.resolve(__dirname, '..');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const argv = process.argv.slice(2);
const positional = [];
const options = {};
for (let i = 0; i < argv.length; i++) {
  if (argv[i].startsWith('--')) {
    const key = argv[i].slice(2);
    if (['all', 'help'].includes(key)) options[key] = true;
    else {
      // A plain message, not a stack trace: argument errors happen before main().
      if (!argv[i + 1] || argv[i + 1].startsWith('--')) { console.error(`Value required for --${key}`); process.exit(1); }
      options[key] = argv[++i];
    }
  } else positional.push(argv[i]);
}
const runs = path.resolve(options.runs || process.env.SESSION_PLANNER_RUNS || path.join(ROOT, 'runs'));
const registry = path.join(runs, '.runtime.json');
function state() { try { return JSON.parse(fs.readFileSync(registry, 'utf8')); } catch { return null; } }
function origin(runtime) {
  if (!Number.isInteger(runtime?.port) || runtime.port < 1 || runtime.port > 65535) throw new Error('Invalid runtime port');
  return `http://127.0.0.1:${runtime.port}`;
}
async function request(runtime, route, body) {
  const response = await fetch(origin(runtime) + route, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Session-Planner-Token': runtime.token },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(5000)
  });
  const data = await response.json();
  if (!response.ok) throw new Error(`${response.status}: ${data.error || 'request failed'}`);
  return data;
}
async function live(runtime) {
  if (runtime?.status !== 'running' || runtime.root !== ROOT || runtime.runs !== runs) return null;
  try {
    const health = await request(runtime, '/health');
    if (health.app === 'session-planner' && health.protocol === 1 && health.instance === runtime.instance && health.root === ROOT && health.runs === runs) return health;
  } catch {}
  return null;
}
async function start() {
  fs.mkdirSync(runs, { recursive: true });
  const existing = state();
  if (await live(existing)) return existing;
  const lock = path.join(runs, '.startup-lock');
  let lockFd;
  try { lockFd = fs.openSync(lock, 'wx', 0o600); }
  catch (err) {
    if (err.code !== 'EEXIST') throw err;
    // Never reclaim by pathname after a stale owner check: another starter
    // may already own it. A healthy starter can finish; abandoned locks stop.
    for (let attempt = 0; attempt < 50; attempt++) {
      await sleep(100);
      const current = state();
      if (await live(current)) return current;
    }
    throw new Error(`Another start is in progress, or a previous start was interrupted. Startup lock retained at ${lock}. Inspect the lock and runtime with other starters stopped before deliberate recovery; do not kill another application or blindly remove the lock.`);
  }
  try {
    fs.writeFileSync(lockFd, JSON.stringify({ pid: process.pid, started: new Date().toISOString() }));
    const current = state();
    if (await live(current)) return current;
    // A nonresponsive existing process may still own the store. Do not create a
    // competing writer merely because the health check timed out.
    if (current?.status === 'running' && current.pid) {
      let alive = true;
      try { process.kill(current.pid, 0); } catch (err) { if (err.code === 'ESRCH') alive = false; }
      if (alive) throw new Error('Registered server is not responding but its process still exists. Inspect it before restarting.');
    }
    const port = options.port === undefined ? 0 : Number(options.port);
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Port must be between 0 and 65535');
    // Reopening the planner on its previous address keeps the browser's unsaved
    // drafts reachable. The server falls back to any free port if it is taken.
    // Only when no port was requested at all: an explicit --port 0 means the
    // caller deliberately wants a fresh ephemeral port. Privileged ports are
    // never recalled, because a recorded one would fail to bind every time.
    const preferred = options.port === undefined && Number.isInteger(current?.port) && current.port >= 1024 && current.port <= 65535 ? current.port : 0;
    const token = crypto.randomBytes(32).toString('hex');
    const instance = crypto.randomUUID();
    // The most common first-run failure is that dependencies were never installed.
    // Say so plainly instead of letting it surface as a vague startup error. The
    // agent reads this too, so it is addressed to the user: installing is the
    // user's decision, never an incidental step of planning.
    const missing = Object.keys(require('./package.json').dependencies || {}).filter(name => {
      try { require.resolve(name, { paths: [__dirname] }); return false; } catch { return true; }
    });
    if (missing.length) throw new Error(`Session Planner's dependencies are not installed (missing: ${missing.join(', ')}). The user needs to run \`npm ci --ignore-scripts\` in ${__dirname}; see the README. Installing is the user's decision, not part of planning.`);
    const log = fs.openSync(path.join(runs, '.server.log'), 'a', 0o600);
    const child = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
      cwd: ROOT, detached: true, stdio: ['ignore', log, log],
      env: { ...process.env, SESSION_PLANNER_RUNS: runs, SESSION_PLANNER_PORT: String(port), SESSION_PLANNER_PORT_PREFERRED: String(preferred), SESSION_PLANNER_TOKEN: token, SESSION_PLANNER_INSTANCE: instance }
    });
    fs.closeSync(log);
    let failure;
    child.on('error', err => { failure = err; });
    child.unref();
    for (let attempt = 0; attempt < 100; attempt++) {
      if (failure) throw failure;
      const runtime = state();
      if (runtime?.instance === instance && await live(runtime)) return runtime;
      if (child.exitCode !== null) throw new Error(`Planner failed to start. Details are in ${path.join(runs, '.server.log')}.${Number(options.port) > 0 ? ` Port ${options.port} may already be in use.` : ''}`);
      await sleep(100);
    }
    // This is the child we just spawned, not an arbitrary PID from disk.
    child.kill('SIGTERM');
    throw new Error('Planner did not become ready. Its newly launched process was stopped.');
  } finally {
    try {
      const held = fs.fstatSync(lockFd);
      let current;
      try { current = fs.lstatSync(lock); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (current?.isFile() && current.dev === held.dev && current.ino === held.ino) {
        fs.unlinkSync(lock); // Only the same transient file this helper acquired.
      }
    } finally { fs.closeSync(lockFd); }
  }
}
function required(key) { if (!options[key]) throw new Error(`--${key} is required`); return options[key]; }
function file(key) { return fs.readFileSync(path.resolve(required(key)), 'utf8'); }
function sessionName() {
  const name = positional[1];
  if (!name || !/^[a-z0-9][a-z0-9-]{0,79}$/.test(name)) throw new Error('Provide the exact session name (lowercase letters, numbers, hyphens).');
  return name;
}
const help = `Session Planner — local commands (Node 20+)
  node server/planner.js start [--port NUMBER]
  node server/planner.js status
  node server/planner.js list
  node server/planner.js create NAME --intake FILE [--parent WORKSPACE]
  node server/planner.js resume NAME
  node server/planner.js read NAME ITEM_ID
  node server/planner.js add NAME --title TEXT --body FILE [--operation ID]
  node server/planner.js propose NAME --title TEXT --body FILE [--operation ID]
  node server/planner.js update NAME ITEM_ID --revision VALUE --body FILE [--title TEXT] [--batch VALUE]
  node server/planner.js begin-refresh NAME
  node server/planner.js ack NAME ITEM_ID --batch VALUE --revision VALUE --reason TEXT
  node server/planner.js finish-refresh NAME --batch VALUE
  node server/planner.js compile NAME --revision VALUE --document FILE --coverage JSON_FILE
  node server/planner.js export-sources NAME --revision VALUE --framing FILE
  node server/planner.js stop [--all]
All commands accept --runs PATH. Sessions default to the installed app's runs/.
resume returns full saved context. Use read for an individual current revision.
start prints a verified local URL; open it with your host's browser tool.
stop affects the shared server; --all is required after multiple sessions were used.
No command installs packages, downloads resources, publishes, or deletes sessions.`;

async function main() {
  const command = positional[0] || 'help';
  if (command === 'help' || options.help) { console.log(help); return; }
  let result;
  if (command === 'status') {
    const runtime = state();
    const health = await live(runtime);
    result = health ? { running: true, url: origin(runtime) + '/viewer/index.html', sessions: health.sessions, runs } : { running: false, runs };
  } else if (command === 'stop') {
    const runtime = state();
    if (!await live(runtime)) result = { stopped: false, reason: 'No verified Planner server is running.' };
    else {
      result = await request(runtime, '/shutdown', { instance: runtime.instance, all: !!options.all });
      // A failed health request is not proof that the process exited. Wait for
      // the captured process; never signal an arbitrary registered PID.
      let alive = true;
      for (let attempt = 0; attempt < 30; attempt++) {
        try { process.kill(runtime.pid, 0); }
        catch (error) { if (error.code === 'ESRCH') { alive = false; break; } throw error; }
        await sleep(100);
      }
      if (alive) throw new Error('Shutdown requested, but process exit was not confirmed. Inspect the saved runtime before restarting.');
    }
  } else {
    const allowed = ['start','list','create','resume','read','add','propose','update','begin-refresh','ack','finish-refresh','compile','export-sources'];
    if (!allowed.includes(command)) throw new Error('Unknown command. Run with --help.');
    const name = ['start','list'].includes(command) ? null : sessionName();
    // Validate required input before creating a server process.
    let body;
    if (command === 'create') body = { name, intake: file('intake'), parentWorkspace: options.parent ? path.resolve(options.parent) : undefined };
    if (['add', 'propose'].includes(command)) {
      body = { title: required('title'), content: file('body'), proposed: command === 'propose' };
      body.operationId = options.operation || 'input-' + crypto.createHash('sha256').update(JSON.stringify([command, name, path.resolve(required('body')), body.title, body.content])).digest('hex');
    }
    if (command === 'update') body = { revision: required('revision'), content: file('body'), title: options.title, batch: options.batch };
    if (command === 'ack') body = { id: Number(positional[2]), batch: required('batch'), revision: required('revision'), reason: required('reason') };
    if (command === 'finish-refresh') body = { batch: required('batch') };
    if (command === 'export-sources') body = { revision: required('revision'), framing: file('framing') };
    if (command === 'compile') body = { revision: required('revision'), document: file('document'), coverage: JSON.parse(file('coverage')) };
    const runtime = await start();
    const base = name ? `/sessions/${name}` : '';
    const agent = `/agent${base}`;
    if (command === 'start') result = { url: origin(runtime) + '/viewer/index.html', runs };
    if (command === 'list') result = await request(runtime, '/sessions');
    if (command === 'create') result = await request(runtime, '/sessions/new', body);
    if (command === 'resume') result = await request(runtime, agent);
    if (command === 'read') result = await request(runtime, `${base}/items/${Number(positional[2])}`);
    if (['add', 'propose'].includes(command)) result = await request(runtime, `${base}/items/new`, body);
    if (command === 'update') result = await request(runtime, `${agent}/items/${Number(positional[2])}/body`, body);
    if (command === 'begin-refresh') result = await request(runtime, `${agent}/refresh/begin`, {});
    if (command === 'ack') result = await request(runtime, `${agent}/refresh/ack`, body);
    if (command === 'finish-refresh') result = await request(runtime, `${agent}/refresh/finish`, body);
    if (['compile', 'export-sources'].includes(command)) result = await request(runtime, `${agent}/${command}`, body);
    if (['create','resume'].includes(command)) result.url = `${origin(runtime)}/viewer/index.html#${name}`;
  }
  console.log(JSON.stringify(result, null, 2));
}
main().catch(err => { console.error(err.message); process.exitCode = 1; });
