import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPlugin } from '../../../frontend/build-plugin.mjs';
const here = dirname(fileURLToPath(import.meta.url)), root = resolve(here, '../../..'), out = resolve(root, '.artifacts/workspace-shadow-profile');
const capability = { name: 'workspace.shadow.audit', api: 1, scope: 'target' };
for (const role of ['provider', 'consumer']) {
  const dest = resolve(out, role); await mkdir(dest, { recursive: true });
  await writeFile(resolve(dest, 'renderer.js'), (await buildPlugin(resolve(root, 'frontend'), '../tests/fixtures/workspace-acceptance/profile/shadow-' + role + '.js')).code);
  const manifest = { schema: 1, id: 'dev.workspace.shadow-' + role, name: 'Native shadow transcript ' + role, version: '0.0.1', renderer: { entry: 'renderer.js', world: 'main' }, permissions: role === 'provider' ? ['ui.dom', 'ui.mainWorld'] : ['ui.dom', 'ui.mainWorld', 'host.process', 'cdp.raw'], ...(role === 'provider' ? { provides: [capability] } : { requires: [capability], host: { entry: 'host.cjs' } }) };
  await writeFile(resolve(dest, 'codlet.json'), JSON.stringify(manifest, null, 2) + '\n');
  if (role === 'consumer') await writeFile(resolve(dest, 'host.cjs'), (await readFile(resolve(here, 'cold/host.cjs'), 'utf8')).replaceAll('codlet.workspace.cold.audit', 'codlet.workspace.shadow.result'));
}
console.log(out);
