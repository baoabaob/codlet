import { build } from 'esbuild';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const base = dirname(fileURLToPath(import.meta.url));
export async function buildCodex(root = resolve(base, '..')) {
  const sources = resolve(root, 'codex/frontend');
  const artifacts = new Map();
  const packages = new Set();
  function used(meta) {
    for (const output of Object.values(meta.outputs)) for (const [path, input] of Object.entries(output.inputs)) {
      if (!input.bytesInOutput) continue;
      const match = /^(.*node_modules\/(?:@[^/]+\/)?[^/]+)\//.exec(path.replaceAll('\\', '/'));
      if (match) packages.add(resolve(sources, match[1]));
    }
  }
  for (const [entry, destination] of [['adapter/entry.js', 'codex-ui-adapter/dist/renderer.js'], ['desktop/entry.js', 'codex-desktop-adapter/renderer.js']]) {
    const result = await build({ absWorkingDir: sources, entryPoints: [resolve(sources, 'src', entry)], bundle: true, write: false, metafile: true, format: 'cjs', platform: 'browser', target: 'chrome130', legalComments: 'inline', nodePaths: [resolve(base, 'node_modules')], define: { 'process.env.NODE_ENV': '"production"' } });
    artifacts.set(resolve(root, 'codex/bundled', destination), result.outputFiles[0].text);
    used(result.metafile);
  }
  const main = await build({ absWorkingDir: sources, entryPoints: [resolve(root, 'codex/host/electron-main.cjs')], bundle: true, write: false, metafile: true, format: 'cjs', platform: 'node', target: 'node24', nodePaths: [resolve(base, 'node_modules')] });
  const host = await build({ absWorkingDir: sources, entryPoints: [resolve(root, 'codex/host/desktop-launch.cjs')], bundle: true, write: false, metafile: true, format: 'cjs', platform: 'node', target: 'node24', nodePaths: [resolve(base, 'node_modules')], define: { CODEX_TRAFFIC_MAIN_SOURCE: JSON.stringify(main.outputFiles[0].text) } });
  artifacts.set(resolve(root, 'runtime/core-modules/client-source.cjs'), main.outputFiles[0].text);
  artifacts.set(resolve(root, 'codex/bundled/codex-desktop-adapter/host.cjs'), host.outputFiles[0].text);
  used(main.metafile); used(host.metafile);
  const helper = await build({ absWorkingDir: sources, entryPoints: [resolve(root, 'runtime/codex-host.cjs')], bundle: true, write: false, metafile: true, format: 'cjs', platform: 'node', target: 'node24' });
  artifacts.set(resolve(root, 'runtime/codex-host-bundle.cjs'), helper.outputFiles[0].text);
  used(helper.metafile);
  for (const [id, path] of [['core-ui-provider', 'codex-ui-adapter/dist/renderer.js'], ['core-desktop-provider', 'codex-desktop-adapter/renderer.js']]) {
    artifacts.set(resolve(root, 'runtime/core-modules', id + '.cjs'), artifacts.get(resolve(root, 'codex/bundled', path)));
  }
  for (const [id, path] of [['renderer-bootstrap', 'bundled/runtime/bootstrap.js'], ['renderer-helpers', 'bundled/runtime/helpers.js'], ['renderer-ui', 'bundled/runtime/ui.js'], ['renderer-facade', 'bundled/runtime/facade.js'], ['renderer-page', 'bundled/runtime/page.js'], ['renderer-i18n', 'bundled/runtime/i18n.js'], ['renderer-codex-sdk', 'bundled/runtime/codex.js'], ['renderer-core-services', 'runtime/core-services.cjs']]) {
    artifacts.set(resolve(root, 'runtime/core-modules', id + (id === 'renderer-core-services' ? '.cjs' : '.js')), await readFile(resolve(root, path), 'utf8'));
  }
  const notices = [];
  const parserNotice = 'Acorn source parser (MIT)\n\n' + (await readFile(resolve(root, 'runtime/sdk-source-parser.LICENSE'), 'utf8')).trim();
  const parserTargets = new Set([resolve(root, 'runtime/core-modules/client-source.cjs'), resolve(root, 'codex/bundled/codex-desktop-adapter/host.cjs')]);
  for (const directory of [...packages].sort()) {
    const pkg = JSON.parse(await readFile(resolve(directory, 'package.json'), 'utf8'));
    let license;
    for (const name of ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'LICENSE.BSD', 'license', 'license.md']) try { license = await readFile(resolve(directory, name), 'utf8'); break; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    // Some BSD packages ship their complete notice only as a source header.
    if (!license && pkg.license === 'BSD-2-Clause' && typeof pkg.main === 'string') {
      const entry = resolve(directory, pkg.main);
      if (!entry.startsWith(directory + '/')
          && !entry.startsWith(directory + '\\')) throw Error('Package license entry escapes its directory');
      const header = /^\s*\/\*([\s\S]*?)\*\//.exec(await readFile(entry, 'utf8'))?.[1];
      if (header?.includes('Redistribution and use in source and binary forms') &&
          header.includes('THIS SOFTWARE IS PROVIDED') && header.includes('Copyright')) license = header;
    }
    if (!license) throw new Error(`Missing Codex implementation license: ${pkg.name}@${pkg.version}`);
    notices.push(`${pkg.name}@${pkg.version} (${pkg.license})\n\n${license.trim()}`);
  }
  const licenses = notices.join('\n\n---\n\n');
  const sourceNotice = await readFile(resolve(root, 'codex/NOTICE'), 'utf8');
  const sourceLicense = await readFile(resolve(root, 'codex/LICENSE'), 'utf8');
  const embeddedNotices = sourceNotice.trim() + '\n\n' + sourceLicense.trim() + '\n\n' + licenses;
  for (const [path, code] of artifacts) {
    await mkdir(dirname(path), { recursive: true });
    const attribution = embeddedNotices + (parserTargets.has(path) ? '\n\n' + parserNotice : '');
    await writeFile(path, '// Generated by Core frontend/build-codex.mjs from Core-owned codex sources.\n' + code + '\n/*\n' + attribution.replaceAll('*/', '* /') + '\n*/\n');
  }
  await writeFile(resolve(root, 'codex/THIRD_PARTY_LICENSES.txt'), licenses + '\n\n---\n\n' + parserNotice + '\n');
  const { buildHostBootstrap } = await import('./build-host-bootstrap.mjs');
  await buildHostBootstrap(root);
  return artifacts.size;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) console.log(`Built ${await buildCodex()} Core-owned Codex entries`);
