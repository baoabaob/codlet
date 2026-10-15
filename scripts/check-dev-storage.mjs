import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const GiB = 1024 ** 3;
export const DEVELOPMENT_STORAGE_LIMITS = Object.freeze({
  targetBytes: 8 * GiB,
  artifactBytes: 4 * GiB,
  minimumFreeBytes: 20 * GiB,
});

// Count shared files once; do not traverse links below the selected root.
// Reports and retained releases contribute to the artifact budget too.
export function directoryBytes(directory) {
  if (!fs.existsSync(directory)) return 0;
  const pending = [fs.realpathSync(directory)], seen = new Set();
  let bytes = 0;
  while (pending.length) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, {withFileTypes: true})) {
      const file = path.join(current, entry.name);
      const stat = fs.lstatSync(file, {bigint: true});
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) {
        pending.push(file);
      } else if (stat.isFile()) {
        const identity = `${stat.dev}:${stat.ino}`;
        if (stat.ino !== 0n && seen.has(identity)) continue;
        if (stat.ino !== 0n) seen.add(identity);
        bytes += Number(stat.size);
      }
    }
  }
  return bytes;
}

export function availableBytes(directory) {
  let existing = path.resolve(directory);
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) throw Error(`Cannot locate the volume for ${directory}`);
    existing = parent;
  }
  const stat = fs.statfsSync(existing, {bigint: true});
  return Number(stat.bavail * stat.bsize);
}

export function inspectDevelopmentStorage({
  repoRoot,
  targetDirectory = process.env.CARGO_TARGET_DIR || 'target',
  limits = DEVELOPMENT_STORAGE_LIMITS,
  freeBytes = availableBytes,
} = {}) {
  const root = path.resolve(repoRoot);
  const target = path.resolve(root, targetDirectory);
  const artifacts = path.join(root, '.codlet-artifacts');
  const measured = {
    target: {path: target, bytes: directoryBytes(target), freeBytes: freeBytes(target)},
    artifacts: {path: artifacts, bytes: directoryBytes(artifacts), freeBytes: freeBytes(artifacts)},
  };
  const issues = [];
  if (measured.target.bytes > limits.targetBytes) issues.push('target_budget_exceeded');
  if (measured.artifacts.bytes > limits.artifactBytes) issues.push('artifact_budget_exceeded');
  if (measured.target.freeBytes < limits.minimumFreeBytes) issues.push('target_volume_low_space');
  if (measured.artifacts.freeBytes < limits.minimumFreeBytes) issues.push('artifact_volume_low_space');
  return {schema: 1, ok: issues.length === 0, limits, measured, issues};
}

const gib = bytes => `${(bytes / GiB).toFixed(2)} GiB`;
export function formatDevelopmentStorage(result) {
  const {measured, limits} = result;
  return [
    `Rust build output: ${gib(measured.target.bytes)} / ${gib(limits.targetBytes)} (${measured.target.path})`,
    `Local artifacts: ${gib(measured.artifacts.bytes)} / ${gib(limits.artifactBytes)} (${measured.artifacts.path})`,
    `Free space: build ${gib(measured.target.freeBytes)}, artifacts ${gib(measured.artifacts.freeBytes)}; minimum ${gib(limits.minimumFreeBytes)}`,
    ...(!result.ok ? [
      'Development storage budget exceeded. Stop the build/test processes and clear obsolete build output or closed test runtime copies before continuing.',
      'Keep source, delivery packages, test reports, session logs and databases.',
    ] : []),
  ].join('\n');
}

export function assertDevelopmentStorage(options) {
  const result = inspectDevelopmentStorage(options);
  if (!result.ok) {
    const error = Error(formatDevelopmentStorage(result));
    error.code = 'DEV_STORAGE_BUDGET';
    error.storage = result;
    throw error;
  }
  return result;
}

function main(args) {
  let targetDirectory, json = false;
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--json') json = true;
    else if (args[index] === '--target-dir' && args[index + 1] && !args[index + 1].startsWith('--')) targetDirectory = args[++index];
    else throw Error('Usage: node scripts/check-dev-storage.mjs [--target-dir <directory>] [--json]');
  }
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const result = inspectDevelopmentStorage({repoRoot, targetDirectory});
  console.log(json ? JSON.stringify(result) : formatDevelopmentStorage(result));
  if (!result.ok) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
