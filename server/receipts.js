// Repair derived bookkeeping from the receipts committed with each item.
module.exports = function receiptTools({ fs, path, listItemFiles, parseItemFile, updateChecksum, atomicWrite, assertContained }) {
  const itemName = item => `item-${String(item.data.id).padStart(3, '0')}`;
  function recorded(log, item, receipt) {
    const marker = `[operation:${itemName(item)}:${receipt.kind || 'interaction'}:${receipt.id}]`;
    if (log.includes(marker)) return true;
    // Old browser receipts used an unscoped marker. Match its item as well.
    return !receipt.kind && log.split('\n').some(line => line.includes(` ${itemName(item)}:`) && line.includes(`[operation:${receipt.id}]`));
  }
  function bookkeeping(dir, item, receipt) {
    updateChecksum(dir, item.data.id, item.data);
    const file = path.join(dir, 'changelog.md');
    assertContained(file);
    const log = fs.readFileSync(file, 'utf8');
    if (!recorded(log, item, receipt)) {
      atomicWrite(file, log + `- [${receipt.at}] ${itemName(item)}: ${receipt.event} [operation:${itemName(item)}:${receipt.kind || 'interaction'}:${receipt.id}]\n`);
    }
  }
  function reconcile(dir) {
    const file = path.join(dir, 'changelog.md');
    assertContained(file);
    let log = fs.readFileSync(file, 'utf8');
    for (const filename of listItemFiles(dir)) {
      const item = parseItemFile(fs.readFileSync(path.join(dir, 'items', filename), 'utf8'), `${path.basename(dir)}/items/${filename}`);
      for (const receipt of [item.data.creation, ...(item.data.interactions || [])].filter(Boolean)) {
        if (!recorded(log, item, receipt)) {
          bookkeeping(dir, item, receipt);
          log = fs.readFileSync(file, 'utf8');
        }
      }
    }
  }
  return { bookkeeping, reconcile };
};
