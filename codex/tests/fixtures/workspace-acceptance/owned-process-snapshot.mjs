import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { creationTime, sameCreation, selectOwnedProcesses } from '../../../scripts/process-identity.mjs';

const powershell = path.join(process.env.SYSTEMROOT ?? 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
const read = source => JSON.parse(execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', source],
  { encoding: 'utf8', windowsHide: true, timeout: 15000 }).trim());
export function processFacts(ids, metrics = false) {
  if (!ids.every(pid => Number.isSafeInteger(pid) && pid > 0)) throw Error('Explicit process identities required');
  const fields = metrics ? ';cpuMs=$adapterProcess.TotalProcessorTime.TotalMilliseconds;privateBytes=$adapterProcess.PrivateMemorySize64' : '';
  return read(`$adapterFacts=@(foreach($adapterPid in @(${ids.join(',')})) { $adapterProcess=Get-Process -Id $adapterPid -ErrorAction SilentlyContinue; if($adapterProcess) { [pscustomobject]@{pid=$adapterProcess.Id;created=$adapterProcess.StartTime.ToUniversalTime().ToString('o');image=$adapterProcess.Path${fields}} } }); ConvertTo-Json -InputObject $adapterFacts -Compress`);
}
export function ownedProcessSnapshot(roots, metrics = false) {
  const rows = read("$adapterRows=@(Get-CimInstance Win32_Process | ForEach-Object { [pscustomobject]@{pid=[int]$_.ProcessId;parentPid=[int]$_.ParentProcessId;created=$(if($_.CreationDate){$_.CreationDate.ToUniversalTime().ToString('o')}else{$null})} }); ConvertTo-Json -InputObject $adapterRows -Compress");
  // WMI CreationDate has microsecond precision. It is only a prefilter; the
  // final roots and every parent edge use Get-Process's full FILETIME precision.
  const sameCimCreation = (a, b) => { const x = creationTime(a), y = creationTime(b); return x !== null && y !== null && x / 1000n === y / 1000n; };
  const candidateRoots = roots.map(root => {
    const row = rows.find(value => value.pid === root.pid);
    if (!row || !sameCimCreation(row.created, root.created)) throw Error('Owned root changed before snapshot');
    return { ...root, created: row.created };
  });
  const candidates = selectOwnedProcesses(rows, candidateRoots), facts = processFacts(candidates.processes.map(row => row.pid), metrics);
  const byPid = new Map(facts.map(row => [row.pid, row])), joined = [], raced = [];
  for (const row of candidates.processes) {
    const actual = byPid.get(row.pid);
    if (!actual || !sameCimCreation(actual.created, row.created)) { raced.push({ pid: row.pid, created: row.created, reason: 'changed_during_snapshot' }); continue; }
    joined.push({ ...actual, parentPid: row.parentPid });
  }
  const selection = selectOwnedProcesses(joined, roots), processes = selection.processes;
  for (const root of roots) {
    const actual = processes.find(row => row.pid === root.pid);
    if (!actual || !sameCreation(actual.created, root.created) || path.toNamespacedPath(actual.image ?? '').toLowerCase() !== path.toNamespacedPath(root.image).toLowerCase()) throw Error('Owned root identity changed during snapshot');
  }
  return { capturedAt: new Date().toISOString(), ownershipMethod: 'pid-creation-parent-creation-v1', roots,
    processes, rejectedEdges: [...candidates.rejectedEdges, ...selection.rejectedEdges], raced };
}
