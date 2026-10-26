import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const fixtureRequestHandler = (handler, onError) => (request, response) => {
  Promise.resolve().then(() => handler(request, response)).catch(error => {
    onError(error);
    response.destroy();
  });
};

export async function removeOwnedFixture(directory, prefix, ownedRemaining) {
  if (ownedRemaining !== 0) throw Error('fixture_processes_remaining');
  const temporary = await fs.realpath(os.tmpdir()), absolute = path.resolve(directory);
  if (path.dirname(absolute) !== temporary || !path.basename(absolute).startsWith(prefix)
    || !/^codlet-[a-z-]+-$/u.test(prefix)) throw Error('bad_fixture_path');
  for (let item = absolute;; item = path.dirname(item)) {
    if ((await fs.lstat(item)).isSymbolicLink()) throw Error('fixture_reparse');
    if (path.dirname(item) === item) break;
  }
  const inspect = async item => {
    const stat = await fs.lstat(item);
    if (stat.isSymbolicLink()) throw Error('fixture_reparse');
    if (stat.isDirectory()) for (const entry of await fs.readdir(item)) await inspect(path.join(item, entry));
  };
  await inspect(absolute);
  if (process.platform === 'win32') {
    execFileSync(path.join(process.env.SYSTEMROOT, 'System32/WindowsPowerShell/v1.0/powershell.exe'), [
      '-NoProfile', '-NonInteractive', '-Command',
      "$p=[IO.Path]::GetFullPath($env:CODLET_FIXTURE_DIRECTORY); if(-not [string]::Equals([IO.Path]::GetDirectoryName($p),$env:CODLET_FIXTURE_TEMPORARY,[StringComparison]::OrdinalIgnoreCase) -or -not [IO.Path]::GetFileName($p).StartsWith($env:CODLET_FIXTURE_PREFIX,[StringComparison]::Ordinal)) { throw 'bad_fixture_path' }; for($cursor=Get-Item -LiteralPath $p -ErrorAction Stop; $null -ne $cursor; $cursor=$cursor.Parent) { if(($cursor.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'fixture_reparse' } }; $long='\\\\?\\'+$p; $items=@(Get-Item -LiteralPath $long -ErrorAction Stop)+@(Get-ChildItem -LiteralPath $long -Recurse -Force -ErrorAction Stop); if(@($items | Where-Object {($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0}).Count) { throw 'fixture_reparse' }; foreach($item in $items) { $item.Attributes=$item.Attributes -band (-bnot ([IO.FileAttributes]::ReadOnly -bor [IO.FileAttributes]::Hidden)) }; Remove-Item -LiteralPath $long -Recurse -ErrorAction Stop",
    ], { windowsHide: true, encoding: 'utf8', timeout: 10000, env: { ...process.env,
      CODLET_FIXTURE_DIRECTORY: absolute, CODLET_FIXTURE_TEMPORARY: temporary, CODLET_FIXTURE_PREFIX: prefix } });
  } else await fs.rm(absolute, { recursive: true });
}

export async function writeFixtureReport(directory, name, report) {
  if (directory instanceof URL) directory = fileURLToPath(directory);
  await fs.mkdir(directory, { recursive: true });
  const text = JSON.stringify(report, null, 2) + '\n';
  try {
    const previous = await fs.readFile(path.join(directory, name));
    await fs.writeFile(path.join(directory, `${path.basename(name, '.json')}-previous-${randomUUID()}.json`), previous, { flag: 'wx' });
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const archive = path.join(directory, `${path.basename(name, '.json')}-${Date.now()}-${randomUUID()}.json`);
  await fs.writeFile(archive, text, { flag: 'wx' });
  const temporary = path.join(directory, `.${name}-${randomUUID()}.tmp`);
  try {
    await fs.writeFile(temporary, text, { flag: 'wx' });
    await fs.rename(temporary, path.join(directory, name));
  } finally { await fs.rm(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  return archive;
}
