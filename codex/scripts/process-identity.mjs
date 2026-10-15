// Process identities use creation time, never a reusable PID alone.
export function creationTime(value) {
  if (typeof value !== 'string') return null;
  const precise = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d{1,9}))?Z$/.exec(value);
  if (precise) {
    const seconds = Date.parse(precise[1] + 'Z');
    return Number.isFinite(seconds) ? BigInt(seconds) * 1000000n + BigInt((precise[2] ?? '').padEnd(9, '0')) : null;
  }
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? BigInt(milliseconds) * 1000000n : null;
}
export function sameCreation(left, right) {
  const a = creationTime(left), b = creationTime(right);
  return a !== null && b !== null && a === b;
}
export function childAfterParent(child, parent) {
  const a = creationTime(child), b = creationTime(parent);
  return a !== null && b !== null && a >= b;
}
export function selectOwnedProcesses(rows, roots) {
  const byPid = new Map();
  for (const row of rows) {
    if (row.pid === 0) continue; // Windows System Idle Process is never a root/child.
    if (!Number.isSafeInteger(row.pid) || row.pid < 0 || byPid.has(row.pid)) throw Error('Ambiguous process snapshot');
    byPid.set(row.pid, row);
  }
  const owned = new Map(), rejected = new Map();
  for (const root of roots) {
    const row = byPid.get(root.pid);
    if (!row || !sameCreation(row.created, root.created)) throw Error('Owned root identity changed');
    owned.set(row.pid, { ...row, ownership: 'root' });
  }
  for (let changed = true; changed;) {
    changed = false;
    for (const row of rows) {
      if (owned.has(row.pid)) continue;
      const parent = owned.get(row.parentPid);
      if (!parent) continue;
      if (!childAfterParent(row.created, parent.created)) {
        rejected.set(row.pid, { pid: row.pid, created: row.created, parentPid: parent.pid, parentCreated: parent.created,
          reason: creationTime(row.created) === null ? 'missing_creation_time' : 'created_before_parent' });
        continue;
      }
      owned.set(row.pid, { ...row, parentCreated: parent.created, ownership: 'descendant' }); changed = true;
    }
  }
  return { processes: [...owned.values()], rejectedEdges: [...rejected.values()] };
}
