// The server is the single writer for supported agent and browser operations.
module.exports = function registerAgentApi(store) {
  const { app, fs, path, crypto, sessionDir, readSession, readItem, listItemFiles,
    parseItemFile, writeItem, updateChecksum, revision, atomicWrite,
    activeSessions, assertContained, reconcile, bookkeeping } = store;
  const { markProcessed, approvalBasis, processingState } = require('./item-state');
  const hash = text => crypto.createHash('sha256').update(text).digest('hex');
  const conflict = message => Object.assign(new Error(message), { status: 409 });
  const route = handler => (req, res) => {
    try { res.json(handler(req)); }
    catch (err) { res.status(err.status || (err.code === 'ENOENT' ? 404 : err.code ? 500 : 400)).json({ error: err.message }); }
  };
  function readText(file) { assertContained(file); return fs.readFileSync(file, 'utf8'); }
  function documents(dir) {
    return fs.readdirSync(dir).filter(name => name.endsWith('.md')).sort().map(name => {
      const file = path.join(dir, name);
      return { name, content: readText(file) };
    });
  }
  function outputs(dir) {
    const found = documents(dir);
    for (const name of fs.readdirSync(dir).filter(n => !n.startsWith('.')).sort()) {
      // One damaged bundle must not make the whole session unreadable: skip it and say why.
      try {
        const bundle = path.join(dir, name);
        assertContained(bundle);
        if (!fs.statSync(bundle).isDirectory()) continue;
        const sources = path.join(bundle, 'sources.json');
        if (!fs.existsSync(sources)) continue;
        const manifest = JSON.parse(readText(sources));
        if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new Error('sources.json is not a source record');
        // Bundles name their plan after the session; older bundles used plan.md.
        const documentName = typeof manifest.document === 'string' && /^[a-z0-9][a-z0-9-]*\.md$/.test(manifest.document) ? manifest.document : 'plan.md';
        const plan = path.join(bundle, documentName);
        if (!fs.existsSync(plan)) throw new Error(`no plan document named ${documentName}`);
        found.push({ name: `${name}/${documentName}`, content: readText(plan), sources: manifest });
      } catch (err) {
        console.warn(`Skipping output ${name}: ${err.message}`);
      }
    }
    return found;
  }
  function snapshot(name) {
    const dir = sessionDir(name);
    reconcile(dir);
    const session = readSession(dir);
    const items = listItemFiles(dir).map(file => {
      const item = parseItemFile(readText(path.join(dir, 'items', file)), `${path.basename(dir)}/items/${file}`);
      // The filename number is the card's identity, as in readItem, so revisions match.
      item.data.id = Number(file.match(/\d+/)[0]);
      return { ...item, revision: revision(item), approvalBasis: approvalBasis(item, revision), processingState: processingState(item) };
    });
    const changelog = readText(path.join(dir, 'changelog.md'));
    activeSessions.add(name);
    const result = { name, path: dir, session, items,
      reference: documents(path.join(dir, 'reference')),
      referenceFiles: fs.readdirSync(path.join(dir, 'reference')).sort(),
      output: outputs(path.join(dir, 'output')), changelog };
    return { ...result, revision: hash(JSON.stringify(result)) };
  }
  const batchFile = dir => path.join(dir, '.refresh.json');
  function getBatch(dir, id) {
    const batch = JSON.parse(readText(batchFile(dir)));
    if (batch.id !== id || batch.complete) throw conflict('Refresh batch changed. Begin refresh again.');
    return batch;
  }
  function saveBatch(dir, batch) { atomicWrite(batchFile(dir), JSON.stringify(batch, null, 2) + '\n'); }

  app.get('/agent/sessions/:name', route(req => snapshot(req.params.name)));

  app.post('/agent/sessions/:name/items/:id/body', route(req => {
    const dir = sessionDir(req.params.name);
    const item = readItem(dir, Number(req.params.id));
    if (!['blank', 'red', 'proposed'].includes(item.data.status)) {
      throw conflict('This item is approved, shelved, or rejected. The user must return it to the field before editing.');
    }
    if (req.body.revision !== revision(item)) throw conflict('Item changed. Read it again before revising.');
    if (typeof req.body.content !== 'string' || !req.body.content.trim()) throw new Error('Markdown content required');
    let batch;
    if (req.body.batch) {
      batch = getBatch(dir, req.body.batch);
      if (!batch.items.includes(item.data.id)) throw conflict('Item is not part of this refresh batch.');
    }
    if (item.data.status === 'blank') {
      if (typeof req.body.title !== 'string' || !req.body.title.trim()) throw new Error('A title is required to populate a blank');
      item.data.title = req.body.title.trim();
      item.data.status = 'red';
      item.data.creation = { id: crypto.randomUUID(), kind: 'create', at: new Date().toISOString(), event: 'blank populated' };
    }
    // All requests run synchronously between read and atomic replacement. The
    // expected revision includes metadata, so intervening feedback is protected.
    item.content = req.body.content;
    markProcessed(item, 'updated');
    writeItem(item.filepath, item.data, item.content);
    updateChecksum(dir, item.data.id, item.data);
    if (item.data.creation) bookkeeping(dir, item, item.data.creation);
    item.content = req.body.content;
    const updated = revision(item);
    if (batch) {
      batch.processed[item.data.id] = { revision: updated, action: 'updated' };
      saveBatch(dir, batch);
    }
    return { id: item.data.id, revision: updated };
  }));

  app.post('/agent/sessions/:name/refresh/begin', route(req => {
    const current = snapshot(req.params.name);
    const dir = sessionDir(req.params.name);
    const changes = current.changelog.split(/^=== Refresh completed .*===\s*$/m).pop();
    const ids = [...new Set([...changes.matchAll(/item-(\d+)/g)].map(match => Number(match[1])))];
    const selected = current.items.filter(item => ids.includes(item.data.id));
    let old;
    try { old = JSON.parse(readText(batchFile(dir))); } catch {}
    const processed = {};
    for (const item of selected) {
      const previous = old?.processed?.[item.data.id];
      if (previous?.revision === item.revision) processed[item.data.id] = previous;
      else if (item.data.status === 'red' && ['updated', 'reviewed'].includes(processingState(item))) {
        // The item may have committed before a checksum/batch write failed.
        updateChecksum(dir, item.data.id, item.data);
        processed[item.data.id] = { revision: item.revision, action: item.data.processing.action,
          ...(item.data.processing.reason ? { reason: item.data.processing.reason } : {}) };
      }
    }
    const batch = { id: crypto.randomUUID(), logHash: hash(current.changelog),
      items: selected.map(item => item.data.id), processed, complete: false };
    saveBatch(dir, batch);
    return { batch: batch.id, changes, processed,
      items: selected.filter(item => item.data.status === 'red' && !processed[item.data.id]),
      respected: selected.filter(item => item.data.status !== 'red').map(item => ({ id: item.data.id, status: item.data.status })) };
  }));

  app.post('/agent/sessions/:name/refresh/ack', route(req => {
    const dir = sessionDir(req.params.name);
    const batch = getBatch(dir, req.body.batch);
    const id = Number(req.body.id);
    const item = readItem(dir, id);
    if (!batch.items.includes(id) || req.body.revision !== revision(item)) throw conflict('Read the current batch item before acknowledging it.');
    if (typeof req.body.reason !== 'string' || !req.body.reason.trim()) throw new Error('Explain why no body change is needed');
    if (item.data.status !== 'red') throw conflict('Only active items can be acknowledged.');
    markProcessed(item, 'unchanged', req.body.reason);
    writeItem(item.filepath, item.data, item.content);
    updateChecksum(dir, id, item.data);
    batch.processed[id] = { revision: revision(item), action: 'unchanged', reason: req.body.reason };
    saveBatch(dir, batch);
    return { acknowledged: id };
  }));

  app.post('/agent/sessions/:name/refresh/finish', route(req => {
    const dir = sessionDir(req.params.name);
    const batch = getBatch(dir, req.body.batch);
    reconcile(dir);
    const logFile = path.join(dir, 'changelog.md');
    const log = readText(logFile);
    if (hash(log) !== batch.logHash) throw conflict('New interactions arrived. Begin refresh again; completed item revisions will be remembered.');
    for (const id of batch.items) {
      const item = readItem(dir, id);
      if (item.data.status === 'red' && batch.processed[id]?.revision !== revision(item)) {
        throw conflict(`Item ${id} still needs processing or an explicit unchanged acknowledgment.`);
      }
    }
    atomicWrite(logFile, log + `\n=== Refresh completed [${new Date().toISOString()}] ===\n`);
    batch.complete = true;
    saveBatch(dir, batch);
    return { complete: true };
  }));

  app.post('/agent/sessions/:name/export-sources', route(req => {
    const current = snapshot(req.params.name);
    if (current.revision !== req.body.revision) throw conflict('Session changed. Read it again before compiling.');
    const green = current.items.filter(item => item.data.status === 'green');
    if (!green.length) throw new Error('There are no approved items to compile');
    const sections = [`# ${current.session.title} — Source export`, req.body.framing || '', '## Approved work'];
    for (const item of green) sections.push(`### ${item.data.title} (Item #${item.data.id})\n\n${item.content}`);
    for (const [status, heading] of [['shelf', 'Shelved'], ['red', 'Unresolved'], ['proposed', 'Unaccepted proposals']]) {
      const items = current.items.filter(item => item.data.status === status);
      if (items.length) sections.push(`## ${heading}\n\n` + items.map(item => `- Item #${item.data.id}: ${item.data.title}`).join('\n'));
    }
    const dir = sessionDir(req.params.name);
    const filename = `${req.params.name}-sources-${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomUUID().slice(0, 8)}.md`;
    const file = path.join(dir, 'output', filename);
    atomicWrite(file, sections.filter(Boolean).join('\n\n') + '\n');
    return { path: file, approved: green.map(item => item.data.id) };
  }));
  app.post('/agent/sessions/:name/compile', route(req => {
    const current = snapshot(req.params.name);
    if (current.revision !== req.body.revision) throw conflict('Session changed. Read it again before composing the final plan.');
    const approved = current.items.filter(i => i.data.status === 'green');
    if (!approved.length) throw new Error('There are no approved items to compile');
    const document = req.body.document;
    const coverage = req.body.coverage;
    if (typeof document !== 'string' || !document.trim()) throw new Error('A composed Markdown document is required; use export-sources for verbatim records.');
    if (!Array.isArray(coverage) || coverage.length !== approved.length) throw new Error('Account for every approved item in coverage.');
    const headings = [];
    const marked = require('../viewer/vendor/marked-17.0.5.js');
    marked.walkTokens(marked.lexer(document), token => { if (token.type === 'heading') headings.push(token.text); });
    const seen = new Set();
    for (const entry of coverage) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('Each coverage entry must be an object');
      const item = approved.find(i => i.data.id === entry.id);
      if (!item || seen.has(entry.id)) throw new Error('Coverage must name each approved item exactly once.');
      seen.add(entry.id);
      if (entry.approvalId !== item.approvalBasis) throw conflict(`Approval for item ${entry.id} changed.`);
      if (!Array.isArray(entry.sections) || !entry.sections.length || entry.sections.some(h => typeof h !== 'string' || !headings.includes(h))) {
        throw new Error(`Coverage for item ${entry.id} must reference headings in the document.`);
      }
      const source = item.data.approval?.source;
      if (source && (source.content !== item.content || source.feedback !== (item.data.feedback || '') || source.title !== item.data.title)) {
        throw conflict(`Approved item ${entry.id} has newer content or feedback. Resolve its decision before compiling.`);
      }
    }
    // Synchronous snapshot validation + publication: no intervening browser write.
    const dir = sessionDir(req.params.name);
    // Named after the session and the local time, folder and file alike, so each plan
    // identifies itself wherever it is copied and two plans never share a file name:
    // output/kitchen-renovation-session-plan-2026-09-23-1517/kitchen-renovation-session-plan-2026-09-23-1517.md
    // An interrupted compile leaves a hidden .pending folder, so skip names taken by
    // either. The handler is synchronous, so the check cannot race another compile.
    const now = new Date();
    const pad = n => String(n).padStart(2, '0');
    const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
    const base = `${req.params.name}-session-plan`;
    const taken = name => fs.existsSync(path.join(dir, 'output', name)) || fs.existsSync(path.join(dir, 'output', `.${name}.pending`));
    let id = `${base}-${stamp}`;
    for (let n = 2; taken(id); n++) id = `${base}-${stamp}-${n}`;
    const documentName = `${id}.md`;
    const temporary = path.join(dir, 'output', `.${id}.pending`);
    const destination = path.join(dir, 'output', id);
    assertContained(temporary); assertContained(destination);
    fs.mkdirSync(temporary, { recursive: false, mode: 0o700 });
    const manifest = { version: 1, session: current.name, sessionRevision: current.revision,
      created: now.toISOString(), document: documentName, coverage,
      approved: approved.map(i => ({ id: i.data.id, title: i.data.title, approvalId: i.approvalBasis,
        basis: i.data.approval ? 'recorded' : 'legacy', content: i.content, feedback: i.data.feedback || '',
        approval: i.data.approval || null })) };
    atomicWrite(path.join(temporary, documentName), document.trim() + '\n');
    atomicWrite(path.join(temporary, 'sources.json'), JSON.stringify(manifest, null, 2) + '\n');
    fs.renameSync(temporary, destination);
    return { path: path.join(destination, documentName), sources: path.join(destination, 'sources.json'),
      approved: approved.map(i => i.data.id), parentWorkspace: current.session.parent_workspace || null };
  }));

};
