const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const yaml = require('js-yaml');
const { processingState, approvalBasis } = require('./item-state');

let PORT = Number(process.env.SESSION_PLANNER_PORT || 0);
if (!Number.isInteger(PORT) || PORT < 0 || PORT > 65535) throw new Error('SESSION_PLANNER_PORT must be an integer between 0 and 65535');
// A restart on a new port changes the page's origin, which strands the browser's
// unsaved drafts in the old tab. Reuse the previous port when it is still free.
// The value comes from a file on disk that may be stale, corrupt or hand-edited,
// so anything that is not a well-formed unprivileged port is simply ignored.
const RECALLED = Number(process.env.SESSION_PLANNER_PORT_PREFERRED);
const PREFERRED_PORT = Number.isInteger(RECALLED) && RECALLED >= 1024 && RECALLED <= 65535 ? RECALLED : 0;
const TOKEN = process.env.SESSION_PLANNER_TOKEN || crypto.randomBytes(32).toString('hex');
const INSTANCE = process.env.SESSION_PLANNER_INSTANCE || crypto.randomUUID();
const activeSessions = new Set();
let backgroundTimer;
const POLL_INTERVAL = 2500;
const REPO_ROOT = path.resolve(__dirname, '..');
const RUNS_DIR = path.resolve(process.env.SESSION_PLANNER_RUNS || path.join(REPO_ROOT, 'runs'));
fs.mkdirSync(RUNS_DIR, { recursive: true });
const RUNTIME_FILE = path.join(RUNS_DIR, '.runtime.json');
const TEMPLATES_DIR = path.join(REPO_ROOT, 'templates');

// --- Security ---
// This server has file read/write/delete power. It binds to loopback, but a
// loopback bind alone does not stop a malicious website from reaching it via
// the user's own browser (DNS rebinding / cross-origin). Defenses:
//   1. Host-header allowlist — rejects DNS-rebinding (attacker Host != localhost).
//   2. Origin-scoped CORS — the viewer is same-origin, so no wildcard is needed.
//   3. Path-traversal containment in sessionDir() — session names can't escape RUNS_DIR.
// Runtime credentials protect API access; the viewer receives its credential only
// through a same-origin document. No token is embedded in a URL or a public asset.
function allowedOrigins() {
  return [`http://localhost:${PORT}`, `http://127.0.0.1:${PORT}`];
}
function hostGuard(req, res, next) {
  if (![`localhost:${PORT}`, `127.0.0.1:${PORT}`].includes(req.headers.host)) {
    return res.status(403).json({ error: 'forbidden host' });
  }
  if (req.headers.origin && !allowedOrigins().includes(req.headers.origin)) {
    return res.status(403).json({ error: 'forbidden origin' });
  }
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)) {
    return res.status(403).json({ error: 'loopback required' });
  }
  res.set('Cache-Control', 'no-store');
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'no-referrer');
  res.set('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'self'; base-uri 'none'; form-action 'self'");
  next();
}
function atomicWrite(filepath, content) {
  assertContained(filepath);
  const temporary = `${filepath}.${crypto.randomUUID()}.tmp`;
  const fd = fs.openSync(temporary, 'wx', 0o600);
  try { fs.writeFileSync(fd, content, 'utf8'); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  fs.renameSync(temporary, filepath);
}
function assertContained(filepath) {
  const base = fs.realpathSync(RUNS_DIR);
  const absolute = path.resolve(filepath);
  if (!absolute.startsWith(RUNS_DIR + path.sep)) throw new Error('path outside session store');
  let cursor = RUNS_DIR;
  for (const part of path.relative(RUNS_DIR, absolute).split(path.sep)) {
    cursor = path.join(cursor, part);
    if (fs.existsSync(cursor)) {
      if (fs.lstatSync(cursor).isSymbolicLink()) throw new Error('linked session paths are not supported');
      const real = fs.realpathSync(cursor);
      if (!real.startsWith(base + path.sep)) throw new Error('linked path outside session store');
    }
  }
}
function revision(item) {
  return crypto.createHash('sha256').update(JSON.stringify([item.data, item.content])).digest('hex');
}

// --- Utilities ---

function formatTimestamp() {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  return `[${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}]`;
}

function padId(id) {
  return String(id).padStart(3, '0');
}

function itemFilename(id) {
  return `item-${padId(id)}.md`;
}

function titleCase(str) {
  return str.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

// --- File I/O Helpers ---

function sessionDir(name) {
  if (typeof name !== 'string' || !/^[a-z0-9][a-z0-9-]{0,79}$/.test(name)) {
    const err = new Error('use a session name of 1–80 lowercase letters, numbers, or hyphens');
    err.code = 'EINVALIDNAME';
    throw err;
  }
  const p = path.join(RUNS_DIR, name);
  assertContained(p);
  for (const child of ['items', 'inbox', 'reference', 'output', 'session.yaml', 'changelog.md', '.checksums.json', '.refresh.json']) assertContained(path.join(p, child));
  return p;
}

function parseItemFile(raw, source = 'A card file') {
  // Parse each saved item or maintained template afresh; metadata is never cached.
  // A damaged card stops the session loading, naming the file: skipping it could
  // silently drop an approved card from a compiled plan.
  const damaged = reason => Object.assign(new Error(`${source} can't be read: ${reason}. Fix or restore that file.`), { status: 500, code: 'EBADCARD' });
  const match = raw.replace(/\r\n/g, '\n').match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) throw damaged('its metadata block between --- lines is missing');
  let data;
  try { data = yaml.load(match[1]); } catch (err) { throw damaged(`its metadata is not valid YAML (${err.message.split('\n')[0]})`); }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw damaged('its metadata is not a set of fields');
  return { data, content: match[2] };
}

function readItem(sDir, id) {
  if (!Number.isSafeInteger(id) || id < 1) throw new Error('invalid item number');
  const filename = itemFilename(id);
  const filepath = path.join(sDir, 'items', filename);
  assertContained(filepath);
  const raw = fs.readFileSync(filepath, 'utf8');
  const { data, content } = parseItemFile(raw, `${path.basename(sDir)}/items/${filename}`);
  // The filename number is the card's identity; the API addresses cards by it.
  // A hand-edited metadata id must never reach the page, where ids sit in HTML.
  data.id = id;
  return { data, content, filepath, filename };
}

function writeItem(filepath, data, content) {
  // Preserve server-owned nested approval/processing records on every write.
  const metadata = yaml.dump(data, { lineWidth: -1, noRefs: true });
  atomicWrite(filepath, `---\n${metadata}---\n${content}`);
}

function readSession(sDir) {
  const filepath = path.join(sDir, 'session.yaml');
  const raw = fs.readFileSync(filepath, 'utf8');
  return yaml.load(raw);
}

function writeSession(sDir, data) {
  const filepath = path.join(sDir, 'session.yaml');
  atomicWrite(filepath, yaml.dump(data, { lineWidth: -1 }));
}

// --- Checksum Functions ---

function hashFrontmatter(data) {
  const yamlStr = yaml.dump(data, { sortKeys: true });
  return crypto.createHash('md5').update(yamlStr).digest('hex').slice(0, 8);
}

function readChecksums(sDir) {
  const filepath = path.join(sDir, '.checksums.json');
  try {
    return JSON.parse(fs.readFileSync(filepath, 'utf8'));
  } catch {
    return {};
  }
}

function writeChecksums(sDir, checksums) {
  const filepath = path.join(sDir, '.checksums.json');
  atomicWrite(filepath, JSON.stringify(checksums, null, 2) + '\n');
}

function updateChecksum(sDir, id, data) {
  const checksums = readChecksums(sDir);
  checksums[String(id)] = hashFrontmatter(data);
  writeChecksums(sDir, checksums);
}

function validateChecksum(sDir, id, data) {
  const checksums = readChecksums(sDir);
  const stored = checksums[String(id)];
  if (stored && stored !== hashFrontmatter(data)) {
    console.warn(`⚠ item-${padId(id)}: frontmatter modified outside server`);
  }
}

// --- Feedback ---

function appendFeedback(data, text) {
  const ts = formatTimestamp();
  const newLine = `${ts} ${text}`;
  if (!data.feedback || data.feedback.trim() === '') {
    data.feedback = newLine + '\n';
  } else {
    const existing = data.feedback.endsWith('\n') ? data.feedback : data.feedback + '\n';
    data.feedback = existing + newLine + '\n';
  }
}

// --- Title Extraction ---

function extractTitleFromBody(content) {
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === '') continue;
    if (line.startsWith('## ')) return null;
    const title = line;
    const rest = lines.slice(i + 1).join('\n');
    return { title, body: rest };
  }
  return null;
}

// --- List Items in Session ---

function listItemFiles(sDir) {
  const itemsDir = path.join(sDir, 'items');
  assertContained(itemsDir);
  const files = fs.readdirSync(itemsDir).filter(f => f.match(/^item-\d+\.md$/));
  for (const file of files) assertContained(path.join(itemsDir, file));
  files.sort((a, b) => {
    const idA = parseInt(a.match(/\d+/)[0], 10);
    const idB = parseInt(b.match(/\d+/)[0], 10);
    return idA - idB;
  });
  return files;
}

const { bookkeeping, reconcile } = require('./receipts')({ fs, path, listItemFiles, parseItemFile, updateChecksum, atomicWrite, assertContained });
function draftScope(dir, session) {
  return crypto.createHash('sha256').update(JSON.stringify([fs.realpathSync(RUNS_DIR), path.basename(dir), session.id || session.created])).digest('hex');
}

// --- Express App ---

const app = express();
// No endpoint consumes query parameters. Disable parsing before Express builds its router.
app.set('query parser', false);
app.use(hostGuard);
app.use(cors({ origin(origin, callback) { callback(null, !origin || allowedOrigins().includes(origin)); } }));
app.use(express.json({ limit: '2mb' }));
app.use((err, req, res, next) => {
  if (err) return res.status(err.status || 400).json({ error: err.type === 'entity.too.large' ? 'Request exceeds the 2 MB limit.' : 'Invalid JSON request body.' });
  next();
});
app.use((req, res, next) => {
  if (req.method === 'POST' && (!req.body || typeof req.body !== 'object' || Array.isArray(req.body))) return res.status(400).json({ error: 'A JSON object is required.' });
  next();
});
app.get(['/viewer/', '/viewer/index.html'], (req, res) => {
  const html = fs.readFileSync(path.join(REPO_ROOT, 'viewer/index.html'), 'utf8');
  res.type('html').send(html.replace('__SESSION_PLANNER_TOKEN__', TOKEN));
});
app.use('/viewer', express.static(path.join(REPO_ROOT, 'viewer'), { index: false }));
app.use((req, res, next) => {
  const token = req.get('X-Session-Planner-Token') || '';
  if (Buffer.byteLength(token) !== Buffer.byteLength(TOKEN) || !crypto.timingSafeEqual(Buffer.from(token), Buffer.from(TOKEN))) {
    return res.status(401).json({ error: 'Open the planner URL again to reconnect.' });
  }
  next();
});
app.get('/health', (req, res) => res.json({ app: 'session-planner', protocol: 1, instance: INSTANCE, root: REPO_ROOT, runs: RUNS_DIR, sessions: [...activeSessions] }));
app.post('/shutdown', (req, res) => {
  if (req.body.instance !== INSTANCE) return res.status(409).json({ error: 'server instance changed' });
  if (activeSessions.size > 1 && !req.body.all) return res.status(409).json({ error: 'Several sessions use this server. Stop with --all only when finished with all of them.' });
  res.json({ stopped: true });
  setTimeout(shutdown, 50);
});

// GET /sessions — list all runs
app.get('/sessions', (req, res) => {
  try {
    if (!fs.existsSync(RUNS_DIR)) return res.json([]);
    const dirs = fs.readdirSync(RUNS_DIR).filter(name => {
      const p = path.join(RUNS_DIR, name);
      return fs.statSync(p).isDirectory() && /^[a-z0-9][a-z0-9-]{0,79}$/.test(name);
    });
    const sessions = dirs.map(name => {
      try {
        const data = readSession(sessionDir(name));
        return { name, title: data.title, created: data.created, status: data.status };
      } catch {
        return { name, title: name, created: '', status: 'unknown' };
      }
    });
    res.json(sessions);
  } catch (err) {
    console.error('Error listing sessions:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /sessions/new — create run folder
app.post('/sessions/new', (req, res) => {
  try {
    const { name, intake, parentWorkspace } = req.body;
    if (!name) return res.status(400).json({ error: 'name required' });

    const destination = sessionDir(name);
    if (intake !== undefined && typeof intake !== 'string') throw new Error('Intake must be Markdown text');
    if (parentWorkspace !== undefined && typeof parentWorkspace !== 'string') throw new Error('Parent workspace must be a path');
    const creationFingerprint = crypto.createHash('sha256').update(JSON.stringify([intake ?? null, parentWorkspace ?? null])).digest('hex');
    if (fs.existsSync(destination)) {
      const existing = readSession(destination);
      if (existing.creation_fingerprint === creationFingerprint) { activeSessions.add(name); return res.json({ name, path: destination, replayed: true }); }
      return res.status(409).json({ error: 'session already exists with different or legacy intake' });
    }
    // Publish only a complete scaffold. Failed attempts remain hidden for diagnosis.
    const sDir = path.join(RUNS_DIR, `.${name}-${crypto.randomUUID()}.pending`);
    assertContained(sDir);

    // Create directory structure
    fs.mkdirSync(path.join(sDir, 'items'), { recursive: true });
    fs.mkdirSync(path.join(sDir, 'inbox'), { recursive: true });
    fs.mkdirSync(path.join(sDir, 'reference'), { recursive: true });
    fs.mkdirSync(path.join(sDir, 'output'), { recursive: true });
    fs.mkdirSync(path.join(sDir, 'scratch'), { recursive: true });

    if (typeof intake === 'string') atomicWrite(path.join(sDir, 'reference', 'intake.md'), intake);

    // session.yaml
    const sessionData = {
      id: crypto.randomUUID(),
      creation_fingerprint: creationFingerprint,
      title: titleCase(name),
      created: new Date().toISOString().split('T')[0],
      status: 'active',
      ...(typeof req.body.parentWorkspace === 'string' ? { parent_workspace: req.body.parentWorkspace } : {}),
      next_item_number: 16
    };
    writeSession(sDir, sessionData);

    // changelog.md
    const changelogTemplate = fs.readFileSync(path.join(TEMPLATES_DIR, 'changelog-template.md'), 'utf8');
    atomicWrite(path.join(sDir, 'changelog.md'), changelogTemplate);

    // .checksums.json
    const checksums = {};

    // Scaffold 15 blank items
    const itemTemplate = fs.readFileSync(path.join(TEMPLATES_DIR, 'item-template.md'), 'utf8');
    for (let i = 1; i <= 15; i++) {
      const parsed = parseItemFile(itemTemplate, 'The card template templates/item-template.md');
      parsed.data.id = i;
      const filepath = path.join(sDir, 'items', itemFilename(i));
      writeItem(filepath, parsed.data, parsed.content);
      checksums[String(i)] = hashFrontmatter(parsed.data);
    }

    writeChecksums(sDir, checksums);

    fs.renameSync(sDir, destination);
    activeSessions.add(name);
    res.json({ name, path: destination });
  } catch (err) {
    console.error('Error creating session:', err.message);
    res.status(err.code && err.code !== 'EINVALIDNAME' ? 500 : 400).json({ error: err.message });
  }
});

// GET /sessions/:name — session metadata + item list
app.get('/sessions/:name', (req, res) => {
  try {
    const sDir = sessionDir(req.params.name);
    const session = readSession(sDir);
    activeSessions.add(req.params.name);
    const files = listItemFiles(sDir);
    const items = files.map(filename => {
      const filepath = path.join(sDir, 'items', filename);
      const raw = fs.readFileSync(filepath, 'utf8');
      const parsed = parseItemFile(raw, `${path.basename(sDir)}/items/${filename}`);
      // Check the metadata as stored, then use the filename number as the card's
      // identity: a hand-edited id is reported, and never reaches the page's HTML.
      const fileId = Number(filename.match(/\d+/)[0]);
      validateChecksum(sDir, fileId, parsed.data);
      parsed.data.id = fileId;
      // Strip markdown headings for body preview (collapsed card 2-line text)
      const bodyText = parsed.content
        .replace(/^## .+$/gm, '').replace(/\*\*(.+?)\*\*/g, '$1')
        .replace(/^- /gm, '').replace(/\n{2,}/g, ' ').replace(/\n/g, ' ').trim();
      return {
        id: parsed.data.id,
        title: parsed.data.title,
        status: parsed.data.status,
        type: parsed.data.type,
        feedback: parsed.data.feedback,
        revision: revision(parsed),
        processingState: processingState(parsed),
        approval: parsed.data.approval || null,
        approvalBasis: approvalBasis(parsed, revision),
        preview: bodyText.slice(0, 300),
        filename
      };
    });
    res.json({ session, items, draftScope: draftScope(sDir, session) });
  } catch (err) {
    if (err.code === 'ENOENT') return res.status(404).json({ error: 'session not found' });
    if (err.code === 'EINVALIDNAME') return res.status(400).json({ error: 'invalid session name' });
    console.error('Error reading session:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /sessions/:name/items/:id — single item
app.get('/sessions/:name/items/:id', (req, res) => {
  try {
    const sDir = sessionDir(req.params.name);
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id < 1) return res.status(400).json({ error: 'invalid item id' });
    const item = readItem(sDir, id);
    validateChecksum(sDir, id, item.data);
    res.json({ data: item.data, content: item.content, revision: revision(item), processingState: processingState(item), approvalBasis: approvalBasis(item, revision) });
  } catch (err) {
    if (err.code === 'ENOENT') return res.status(404).json({ error: 'item not found' });
    if (err.code === 'EINVALIDNAME') return res.status(400).json({ error: 'invalid session name' });
    console.error(`Error reading item ${req.params.id}:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

require('./interaction-api')({ app, fs, path, crypto, sessionDir, readItem, revision,
  writeItem, updateChecksum, atomicWrite, assertContained, appendFeedback, bookkeeping });

// Shared creation operation used by the browser, agent helper, and inbox.
function createItem(sDir, { title, content, proposed = false, notes, operationId = crypto.randomUUID() }) {
  if (typeof title !== 'string' || !title.trim()) throw new Error('title required');
  if (content !== undefined && typeof content !== 'string') throw new Error('content must be Markdown text');
  if (typeof proposed !== 'boolean') throw new Error('proposed must be a boolean');
  if (notes !== undefined && typeof notes !== 'string') throw new Error('notes must be text');
  if (typeof operationId !== 'string' || !/^[a-zA-Z0-9-]{8,80}$/.test(operationId)) throw new Error('A valid operationId is required');
  const fingerprint = crypto.createHash('sha256').update(JSON.stringify([title.trim(), content ?? null, proposed, notes ?? null])).digest('hex');
  const files = listItemFiles(sDir);
  for (const filename of files) {
    const existing = parseItemFile(fs.readFileSync(path.join(sDir, 'items', filename), 'utf8'), `${path.basename(sDir)}/items/${filename}`);
    if (existing.data.creation?.id === operationId) {
      if (existing.data.creation.fingerprint !== fingerprint) throw Object.assign(new Error('Creation operation ID already used for different content'), { status: 409 });
      bookkeeping(sDir, existing, existing.data.creation);
      return { id: existing.data.id, filename, revision: revision(existing), replayed: true };
    }
  }
  let item;
  if (!proposed) {
    for (const filename of files) {
      const parsed = parseItemFile(fs.readFileSync(path.join(sDir, 'items', filename), 'utf8'), `${path.basename(sDir)}/items/${filename}`);
      if (parsed.data.status === 'blank') { item = parsed; break; }
    }
  }
  if (!item) {
    const session = readSession(sDir);
    // Never overwrite an existing item even if an older counter is stale.
    const next = Math.max(session.next_item_number || 1, ...files.map(f => Number(f.match(/\d+/)[0]) + 1));
    session.next_item_number = next + 1;
    writeSession(sDir, session);
    item = parseItemFile(fs.readFileSync(path.join(TEMPLATES_DIR, 'item-template.md'), 'utf8'), 'The card template templates/item-template.md');
    item.data.id = next;
  }
  item.data.title = title.trim();
  item.data.status = proposed ? 'proposed' : 'red';
  item.data.type = proposed ? 'proposed' : 'item';
  if (notes) appendFeedback(item.data, notes);
  if (content !== undefined) item.content = content;
  const filename = itemFilename(item.data.id);
  item.data.creation = { id: operationId, kind: 'create', fingerprint, at: new Date().toISOString(), event: proposed ? 'agent proposed' : 'user requested item' };
  writeItem(path.join(sDir, 'items', filename), item.data, item.content);
  bookkeeping(sDir, item, item.data.creation);
  return { id: item.data.id, filename, revision: revision(item) };
}
app.post('/sessions/:name/items/new', (req, res) => {
  try { res.json(createItem(sessionDir(req.params.name), req.body)); }
  catch (err) { res.status(err.status || (err.code ? 500 : 400)).json({ error: err.message }); }
});

require('./agent-api')({ app, fs, path, crypto, sessionDir, readSession, readItem,
  listItemFiles, parseItemFile, writeItem, updateChecksum, revision, atomicWrite,
  activeSessions, assertContained, reconcile, bookkeeping });

// --- Background Processing ---

function processInbox(sDir) {
  const inboxDir = path.join(sDir, 'inbox');
  if (!fs.existsSync(inboxDir)) return;

  const files = fs.readdirSync(inboxDir).filter(f => f.endsWith('.md'));
  for (const file of files) {
    try {
      const filepath = path.join(inboxDir, file);
      assertContained(filepath);
      const raw = fs.readFileSync(filepath, 'utf8');
      const lines = raw.split('\n');

      // First non-empty line is the title
      let title = '';
      let bodyStart = 0;
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].trim() !== '') {
          title = lines[i].trim();
          bodyStart = i + 1;
          break;
        }
      }
      const body = lines.slice(bodyStart).join('\n');

      const operationId = 'inbox-' + crypto.createHash('sha256').update(JSON.stringify([file, raw])).digest('hex');
      const result = createItem(sDir, { title, content: body, proposed: true, operationId });
      fs.mkdirSync(path.join(inboxDir, 'processed'), { recursive: true });
      let destination = path.join(inboxDir, 'processed', `${result.id}-${file}`);
      assertContained(destination);
      if (fs.existsSync(destination)) destination = path.join(inboxDir, 'processed', `${result.id}-${crypto.randomUUID()}-${file}`);
      assertContained(destination);
      fs.renameSync(filepath, destination);
      console.log(`Inbox: processed ${file} → ${result.filename}`);
    } catch (err) {
      console.error(`Inbox error processing ${file}:`, err.message);
    }
  }
}

function processTitlePromotions(sDir) {
  const itemsDir = path.join(sDir, 'items');
  if (!fs.existsSync(itemsDir)) return;

  const files = listItemFiles(sDir);
  for (const filename of files) {
    try {
      const filepath = path.join(itemsDir, filename);
      const raw = fs.readFileSync(filepath, 'utf8');
      const parsed = parseItemFile(raw, `${path.basename(sDir)}/items/${filename}`);

      if (parsed.data.status !== 'blank') continue;

      const extracted = extractTitleFromBody(parsed.content);
      if (!extracted) continue;

      parsed.data.title = extracted.title;
      parsed.data.status = 'red';
      parsed.data.creation = { id: crypto.randomUUID(), kind: 'create', at: new Date().toISOString(), event: 'legacy blank populated' };
      writeItem(filepath, parsed.data, extracted.body);
      bookkeeping(sDir, parsed, parsed.data.creation);

      console.log(`Title promoted: ${filename} → "${extracted.title}"`);
    } catch (err) {
      console.error(`Title promotion error for ${filename}:`, err.message);
    }
  }
}

function startBackgroundProcessing() {
  backgroundTimer = setInterval(() => {
    try {
      if (!fs.existsSync(RUNS_DIR)) return;
      for (const name of activeSessions) {
        const sDir = sessionDir(name);
        processInbox(sDir);
        processTitlePromotions(sDir);
      }
    } catch (err) {
      console.error('Background processing error:', err.message);
    }
  }, POLL_INTERVAL);
}

// --- Server Startup ---
try {
  const previous = JSON.parse(fs.readFileSync(RUNTIME_FILE, 'utf8'));
  if (previous.status === 'running' && Number.isInteger(previous.pid) && previous.pid > 0) {
    let alive = true;
    try { process.kill(previous.pid, 0); } catch (err) { alive = err.code !== 'ESRCH'; }
    if (alive) throw new Error('A registered process already owns this store. Use planner.js to reuse or inspect it.');
  }
} catch (err) {
  if (err.message.includes('already owns')) throw err;
}
function runtimeState(status) {
  return { app: 'session-planner', protocol: 1, status, pid: process.pid,
    port: PORT, instance: INSTANCE, token: TOKEN, root: REPO_ROOT, runs: RUNS_DIR };
}
let listener;
function listen(port, mayFallBack) {
  listener = app.listen(port, '127.0.0.1', () => {
    PORT = listener.address().port;
    atomicWrite(RUNTIME_FILE, JSON.stringify(runtimeState('running')) + '\n');
    startBackgroundProcessing();
    console.log(`Session Planner ready at http://127.0.0.1:${PORT}/viewer/index.html`);
  });
  listener.on('error', err => {
    // An explicitly requested port still fails; only the remembered one falls back,
    // and it falls back on ANY bind failure. A remembered port that became
    // unusable for any reason must never be able to wedge startup permanently.
    if (mayFallBack) {
      console.error(`Previous port ${port} is unavailable (${err.code || err.message}); starting on an available port instead.`);
      return listen(0, false);
    }
    console.error(err.message);
    process.exitCode = 1;
  });
}
listen(PORT || PREFERRED_PORT, PORT === 0 && PREFERRED_PORT > 0);
function shutdown() {
  clearInterval(backgroundTimer);
  try {
    const current = JSON.parse(fs.readFileSync(RUNTIME_FILE, 'utf8'));
    if (current.instance === INSTANCE) atomicWrite(RUNTIME_FILE, JSON.stringify(runtimeState('stopped')) + '\n');
  } catch {}
  listener.close(() => process.exit(0));
  listener.closeIdleConnections();
  setTimeout(() => process.exit(0), 1500).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
