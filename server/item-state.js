const crypto = require('node:crypto');
const hash = value => crypto.createHash('sha256').update(value || '').digest('hex');
const conflict = message => Object.assign(new Error(message), { status: 409 });
function processingState(item) {
  if (item.data.status === 'green') return 'staged';
  const p = item.data.processing;
  if (p && p.feedbackHash === hash(item.data.feedback) && p.bodyHash === hash(item.content)) {
    return p.action === 'updated' ? 'updated' : 'reviewed';
  }
  return item.data.feedback?.trim() ? 'pending' : 'active';
}
function markProcessed(item, action, reason) {
  item.data.processing = { feedbackHash: hash(item.data.feedback), bodyHash: hash(item.content),
    action, ...(reason ? { reason } : {}), at: new Date().toISOString() };
}
function approvalBasis(item, revision) {
  if (item.data.status !== 'green') return null;
  return item.data.approval?.id || `legacy-${revision(item)}`;
}
module.exports = { hash, conflict, processingState, markProcessed, approvalBasis };
