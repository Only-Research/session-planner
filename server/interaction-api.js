// Browser decisions are source-bound. The item is the atomic record; receipts
// let a retry repair derived bookkeeping after an interrupted response/write.
module.exports = function registerInteractions(store) {
  const { app, crypto, sessionDir, readItem, revision, writeItem, appendFeedback, bookkeeping } = store;
  const { hash, conflict, processingState, approvalBasis } = require('./item-state');
  function respond(item, replayed) {
    return { ok: true, replayed, data: item.data, content: item.content,
      revision: revision(item), processingState: processingState(item), approvalBasis: approvalBasis(item, revision) };
  }
  function operation(kind) {
    return (req, res) => {
      try {
        const dir = sessionDir(req.params.name);
        const item = readItem(dir, Number(req.params.id));
        const b = req.body;
        if (typeof b.operationId !== 'string' || !/^[a-zA-Z0-9-]{8,80}$/.test(b.operationId)) throw new Error('A unique operationId is required');
        const payload = kind === 'feedback' ? [kind, b.revision, b.text] : [kind, b.revision, b.status, b.type || null, b.note ?? ''];
        const fingerprint = hash(JSON.stringify(payload));
        const prior = item.data.interactions?.find(r => r.id === b.operationId);
        if (prior) {
          if (prior.fingerprint !== fingerprint) throw conflict('This operation ID was already used for a different change.');
          bookkeeping(dir, item, prior);
          return res.json(respond(item, true));
        }
        if (b.revision !== revision(item)) throw conflict('This item changed since you reviewed it. Your draft is kept; review the current version before saving.');
        let event;
        if (kind === 'feedback') {
          if (typeof b.text !== 'string' || !b.text.trim()) throw new Error('Feedback text required');
          if (item.data.status !== 'red') throw conflict('Return this item to the field for revision, or amend its staged decision note.');
          appendFeedback(item.data, b.text);
          event = 'feedback added';
        } else {
          if (!['red', 'green', 'shelf', 'rejected'].includes(b.status) || (b.type && b.type !== 'item')) throw new Error('Invalid status or type');
          if (item.data.status === 'blank') throw conflict('Populate this item before changing its status.');
          if (b.note !== undefined && typeof b.note !== 'string') throw new Error('Decision note must be text');
          if (b.status !== 'green' && b.note?.trim()) throw new Error('Decision notes accompany staging only');
          if (item.data.approval) {
            item.data.approvalHistory = [...(item.data.approvalHistory || []), item.data.approval];
            delete item.data.approval;
          }
          if (b.status === 'green') {
            item.data.approval = { id: crypto.randomUUID(), at: new Date().toISOString(), note: b.note || '',
              source: { revision: b.revision, title: item.data.title, content: item.content, feedback: item.data.feedback || '' } };
          }
          item.data.status = b.status;
          if (b.type || b.status === 'green' || b.status === 'red') item.data.type = 'item';
          event = b.status === 'green' ? 'approved with decision record' : `status changed to ${b.status}`;
        }
        const receipt = { id: b.operationId, fingerprint, at: new Date().toISOString(), event };
        item.data.interactions = [...(item.data.interactions || []), receipt];
        writeItem(item.filepath, item.data, item.content);
        bookkeeping(dir, item, receipt);
        res.json(respond(item, false));
      } catch (err) { res.status(err.status || (err.code === 'ENOENT' ? 404 : err.code ? 500 : 400)).json({ error: err.message }); }
    };
  }
  app.post('/sessions/:name/items/:id/feedback', operation('feedback'));
  app.post('/sessions/:name/items/:id/status', operation('status'));
};
