// Plan/preflight only. No client/backend starts, CDP, credentials or sessions.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

if (process.platform !== 'win32') throw Error('Windows isolated Native preflight only');
const [coreDirectory, labBinary, expectedLabHash] = process.argv.slice(2);
if (!coreDirectory || !labBinary || !/^[a-f0-9]{64}$/.test(expectedLabHash ?? '')) throw Error('Usage: prepare-native-run.mjs <Core-source-directory> <reviewed-lab-binary> <reviewed-sha256>');
const coreRepo = path.resolve(coreDirectory);
const { auditedVersions, preflightBlockers } = await import(pathToFileURL(path.join(coreRepo, 'scripts/prepare-core-native-run.mjs')).href);
const repo = fileURLToPath(new URL('../../../', import.meta.url));
const powershell = path.join(process.env.SYSTEMROOT ?? 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
const ps = (source, extra = {}) => JSON.parse(execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', source],
  { encoding: 'utf8', windowsHide: true, env: { ...process.env, ...extra } }).trim() || 'null');
const found = ps('Get-AppxPackage -Name OpenAI.Codex | Select-Object Name,Version,PackageFullName,InstallLocation | ConvertTo-Json -Compress');
const packages = found == null ? [] : Array.isArray(found) ? found : [found], installed = packages.length === 1 ? packages[0] : null;
const versions = auditedVersions(fs.readFileSync(path.join(coreRepo, 'src/lab.rs'), 'utf8'));
const cli = installed ? path.join(installed.InstallLocation, 'app/resources/codex.exe') : null;
const files = { labBinaryPresent: fs.existsSync(labBinary), officialCliPresent: !!cli && fs.existsSync(cli), officialCliSignature: null };
if (files.officialCliPresent) files.officialCliSignature = ps('(Get-AuthenticodeSignature -LiteralPath $env:CODLET_ADAPTER_PREFLIGHT_CLI).Status.ToString() | ConvertTo-Json -Compress', { CODLET_ADAPTER_PREFLIGHT_CLI: cli });
const sha = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const labHash = files.labBinaryPresent ? sha(labBinary) : null;
const blockers = preflightBlockers(packages, versions, files);
if (labHash !== expectedLabHash) blockers.unshift('lab_binary_differs_from_reviewed_build');
const runId = 'adapter-' + randomUUID(), directory = path.join(repo, '.artifacts/adapter-native', runId), profileRoot = path.join(directory, 'profile');
const manifest = { schemaVersion: 1, layer: 'adapter', runId, state: 'planned', launched: false,
  installedPackage: installed, reviewedIsolatedPackageVersions: versions, files,
  hashes: { labBinary: labHash, expectedLabBinary: expectedLabHash, officialCli: files.officialCliPresent ? sha(cli) : null,
    coreUI: sha(path.join(coreRepo, 'bundled/runtime/ui.js')), driver: sha(path.join(repo, 'frontend/src/adapter/workspace-native-composer.js')) },
  planned: { profileRoot, registry: path.join(profileRoot, 'codlet/config.json'), userData: path.join(profileRoot, 'user-data'),
    codexHome: path.join(profileRoot, 'codex-home'), sqliteHome: path.join(profileRoot, 'sqlite'), project: path.join(profileRoot, 'project') },
  effective: { registry: null, profile: null, managerPid: null, corePid: null, backendPid: null, desktopPid: null, target: null,
    backendConfigVerified: false, syntheticDataVerified: false },
  blockers, noCredentialsOrSessionsCopied: true };
fs.mkdirSync(directory, { recursive: true });
fs.writeFileSync(path.join(directory, 'preflight.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
process.stdout.write(JSON.stringify({ runId, installedVersion: installed?.Version, blockers, manifest: path.join(directory, 'preflight.json') }) + '\n');
