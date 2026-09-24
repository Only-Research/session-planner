const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execute = promisify(execFile);

// The viewer builds HTML from card titles, notes, feedback, ids and Markdown
// bodies, including in quoted attribute values. These tests guard what keeps that safe.
const VIEWER = path.join(__dirname, '../../viewer/index.html');
const cli = path.resolve(__dirname, '../planner.js');
const { Marked } = require('../../viewer/vendor/marked-17.0.5.js');

// The text of the brace-delimited block opening at or after `from`.
function block(html, from) {
  const open = html.indexOf('{', from);
  let depth = 0;
  for (let i = open; i < html.length; i++) {
    if (html[i] === '{') depth++;
    if (html[i] === '}' && --depth === 0) return html.slice(open, i + 1);
  }
  throw new Error('unbalanced block in viewer/index.html');
}

function loadEsc() {
  const html = fs.readFileSync(VIEWER, 'utf8');
  const start = html.indexOf('function esc(');
  assert.ok(start !== -1, 'viewer/index.html must define esc()');
  return new Function(`${html.slice(start, html.indexOf('{', start))}${block(html, start)}; return esc;`)();
}

// The viewer's own Markdown rules, applied to a fresh Marked instance.
function loadRenderer() {
  const html = fs.readFileSync(VIEWER, 'utf8');
  const start = html.indexOf('marked.use(');
  assert.ok(start !== -1, 'viewer/index.html must configure marked');
  assert.equal(html.split('marked.use(').length, 2, 'viewer/index.html must configure marked exactly once, or this test misses a rule');
  const options = new Function('esc', `return ${block(html, start)};`)(loadEsc());
  const marked = new Marked(options);
  return markdown => marked.parse(markdown);
}

// Why rendered HTML could run code, or null if it is plain formatting. Only real
// tags count: escaped text such as &lt;img&gt; is displayed, never parsed.
const FORMATTING = new Set(['p', 'h3', 'a', 'ul', 'ol', 'li', 'table', 'thead', 'tbody', 'tr', 'th', 'td',
  'code', 'pre', 'strong', 'em', 'del', 'blockquote', 'hr', 'br', 'input']);
const ATTRIBUTES = new Set(['href', 'rel', 'target', 'class', 'align', 'disabled', 'checked', 'type', 'start']);
function unsafe(html) {
  const tag = /<\/?([a-zA-Z][a-zA-Z0-9]*)([^>]*)>/g;
  for (const [, name, attrs] of html.matchAll(tag)) {
    if (!FORMATTING.has(name.toLowerCase())) return `tag <${name}>`;
    for (const [, attr, value] of attrs.matchAll(/([^\s=]+)(?:="([^"]*)")?/g)) {
      if (!ATTRIBUTES.has(attr.toLowerCase())) return `attribute ${attr} on <${name}>`;
      if (attr.toLowerCase() === 'href' && !/^(https?:|mailto:)/i.test(value)) return `link to ${value}`;
    }
  }
  // A tag left open would be closed by the page's own markup around the card.
  if (/<[A-Za-z/!?]/.test(html.replace(tag, ''))) return 'unterminated tag';
  return null;
}

test('esc neutralises every character that can open markup or close an attribute', () => {
  const esc = loadEsc();
  assert.equal(esc(`<>&"'`), '&lt;&gt;&amp;&quot;&#39;');
  assert.equal(esc(''), '');
  assert.equal(esc(null), '');
  assert.equal(esc(undefined), '');
  assert.equal(esc(42), '42');
  const attribute = `aria-label="${esc('Probe" onfocus="alert(1)')}"`;
  assert.equal((attribute.match(/"/g) || []).length, 2, 'a title must not be able to close its attribute');
});

test('the page never interpolates a title, note, feedback, date or name without esc()', () => {
  // A correct esc() is useless if a template stops calling it. This scans the real
  // page for any of these user- or agent-supplied fields inserted raw.
  const html = fs.readFileSync(VIEWER, 'utf8');
  const raw = /\$\{\s*[A-Za-z_$][\w$]*(?:\??\.[\w$]+)*\??\.(title|feedback|note|created|name)\s*\}/g;
  const found = [...html.matchAll(raw)].map(m => `line ${html.slice(0, m.index).split('\n').length}: ${m[0]}`);
  assert.deepEqual(found, [], `raw interpolation of user text:\n${found.join('\n')}`);
});

test('the page takes a session name from its address only through the name check', () => {
  // The part after # goes into API paths, so it must pass the session-name rule first.
  const html = fs.readFileSync(VIEWER, 'utf8');
  assert.equal(html.split('location.hash.slice(1)').length, 2, 'read the address only inside sessionFromHash()');
  const start = html.indexOf('function sessionFromHash(');
  assert.ok(start !== -1 && block(html, start).includes('location.hash.slice(1)'));
  const check = new Function('window', `${html.slice(start, html.indexOf('{', start))}${block(html, start)}; return sessionFromHash();`);
  for (const [hash, expected] of [['#kitchen-renovation', 'kitchen-renovation'], ['#../etc', ''], ['#a/items/1', ''], ['#Kitchen', ''], ['#', '']]) {
    assert.equal(check({ location: { hash } }), expected, hash);
  }
});

test('card bodies render as formatting only, never markup, handlers or script links', () => {
  // Bodies can carry text from imported documents and web research. The viewer's
  // Markdown rules must turn hostile input into plain formatting or visible text.
  const render = loadRenderer();
  const hostile = [
    '<script>alert(1)</script>',
    '<img src=x onerror=alert(1)>',
    '<svg onload=alert(1)>',
    '<iframe src="javascript:alert(1)"></iframe>',
    '<details open ontoggle=alert(1)>',
    '<style>body{display:none}</style>',
    '<form action="https://example.com"><button>x</button></form>',
    '<a href="javascript:alert(1)">x</a>',
    '<<script>script>alert(1)<</script>/script>',
    '[click](javascript:alert(1))',
    '[click](JaVaScRiPt:alert(1))',
    '[click](data:text/html,<script>alert(1)</script>)',
    '[click](vbscript:msgbox(1))',
    '[a](<javascript:alert(1)>)',
    '[a](&#106;avascript:alert(1))',
    '[x](https://example.com" onmouseover="alert(1))',
    '<https://example.com" onmouseover="alert(1)>',
    '![x](javascript:alert(1))',
    '![x](x" onerror="alert(1))',
    '## <img src=x onerror=alert(1)>',
    '| a |\n|---|\n| <img src=x onerror=alert(1)> |',
    '- [ ] <script>alert(1)</script>',
    '`<script>alert(1)</script>`',
    '```\n<script>alert(1)</script>\n```'
  ];
  for (const input of hostile) {
    const html = render(input);
    assert.equal(unsafe(html), null, `${JSON.stringify(input)} rendered as ${JSON.stringify(html)}`);
  }
  // Without the viewer's rules the same check catches markup, so it is live.
  assert.ok(unsafe(new Marked().parse('<img src=x onerror=alert(1)>')));
  assert.equal(unsafe('<p>x</p><img src=x onerror=alert(1)'), 'unterminated tag');
  // Ordinary formatting and safe links still work.
  assert.match(render('## Plan\n\n- **Book** the [venue](https://example.com)'),
    /<h3>Plan<\/h3>[\s\S]*<strong>Book<\/strong>[\s\S]*<a href="https:\/\/example\.com" rel="noopener noreferrer" target="_blank">venue<\/a>/);
});

test('a hand-edited card id never reaches the page', async () => {
  // Ids sit unescaped in many attributes, so the server must only ever hand the
  // page the filename number, whatever the card's metadata claims.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'session-planner-ids-'));
  const runs = path.join(root, 'runs');
  const run = async (...args) => JSON.parse((await execute(process.execPath, [cli, ...args, '--runs', runs], { timeout: 20000 })).stdout);
  try {
    const intake = path.join(root, 'intake.md');
    const body = path.join(root, 'body.md');
    fs.writeFileSync(intake, '# Ids\n');
    fs.writeFileSync(body, '## Content\nA card.\n');
    await run('create', 'ids', '--intake', intake);
    await run('add', 'ids', '--title', 'Card', '--body', body);
    const file = path.join(runs, 'ids', 'items', 'item-001.md');
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/^id: .*$/m, `id: '1" autofocus onfocus="alert(1)'`));
    const runtime = JSON.parse(fs.readFileSync(path.join(runs, '.runtime.json'), 'utf8'));
    const get = async route => (await fetch(`http://127.0.0.1:${runtime.port}${route}`, { headers: { 'X-Session-Planner-Token': runtime.token } })).json();
    const listing = await get('/sessions/ids');
    assert.equal(listing.items.find(i => i.filename === 'item-001.md').id, 1);
    const item = await get('/sessions/ids/items/1');
    assert.equal(item.data.id, 1);
  } finally {
    await run('stop').catch(() => {});
    fs.rmSync(root, { recursive: true, force: true });
  }
});
