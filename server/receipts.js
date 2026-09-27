// Repair derived bookkeeping from the receipts committed with each item.
module.exports = function receiptTools({ fs, path, listItemFiles, parseItemFile, updateChecksum, atomicWrite, assertContained }) {
  const itemName = item => `item-${String(item.data.id).padStart(3, '0')}`;
  // Receipt fields come from card files, which can be hand-edited. A line break
  // in one, including the Unicode separators a multiline regex also honours,
  // could forge a changelog line such as a refresh boundary.
  const field = value => String(value ?? '').replace(/[\r\n\p{Zl}\p{Zp}]+/gu, ' ');
  function recorded(log, item, receipt) {
    const marker = `[operation:${itemName(item)}:${field(receipt.kind || 'interaction')}:${field(receipt.id)}]`;
    if (log.includes(marker)) return true;
    // Old browser receipts used an unscoped marker. Match its item as well.
    return !receipt.kind && log.split('\n').some(line => line.includes(` ${itemName(item)}:`) && line.includes(`[operation:${field(receipt.id)}]`));
  }
  function bookkeeping(dir, item, receipt) {
    updateChecksum(dir, item.data.id, item.data);
    const file = path.join(dir, 'changelog.md');
    assertContained(file);
    const log = fs.readFileSync(file, 'utf8');
    if (!recorded(log, item, receipt)) {
      atomicWrite(file, log + `- [${field(receipt.at)}] ${itemName(item)}: ${field(receipt.event)} [operation:${itemName(item)}:${field(receipt.kind || 'interaction')}:${field(receipt.id)}]\n`);
    }
  }
  function reconcile(dir) {
    const file = path.join(dir, 'changelog.md');
    assertContained(file);
    let log = fs.readFileSync(file, 'utf8');
    for (const filename of listItemFiles(dir)) {
      const item = parseItemFile(fs.readFileSync(path.join(dir, 'items', filename), 'utf8'), `${path.basename(dir)}/items/${filename}`);
      item.data.id = Number(filename.match(/\d+/)[0]);
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
