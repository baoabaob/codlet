import {pathToFileURL} from 'node:url';

// Preview used major.minor.sequence, so 0.2.0 must sort after 0.2.29 in MSI.
// Reserve builds 0..999 for that historical channel. Stable patch versions use
// 1000 + patch and retain the same UpgradeCode/component identities.
export function windowsVersion(version) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-preview\.(0|[1-9]\d*))?$/.exec(version);
  if (!match) throw new Error('Expected a stable version or historical preview version');
  const [major, minor, patch] = match.slice(1, 4).map(Number);
  const preview = match[4] === undefined ? null : Number(match[4]);
  const build = preview ?? 1000 + patch;
  if (major > 255 || minor > 255 || patch > 64535 || build > 65535 ||
      (preview !== null && (patch !== 0 || preview >= 1000))) {
    throw new Error('Version exceeds the supported Windows Installer range');
  }
  return {msiVersion: `${major}.${minor}.${build}`, fileVersion: `${major}.${minor}.${patch}.${preview ?? 0}`};
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(JSON.stringify(windowsVersion(process.argv[2])));
}
