import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { buildPlugin } from '../../../frontend/build-plugin.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..'), out = resolve(root, '.artifacts/workspace-acceptance');
async function save(file, contents) {
  try { if ((await readFile(file)).equals(Buffer.from(contents))) return; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const temporary = file + '.next'; await writeFile(temporary, contents);
  for (let attempt = 0; ; attempt++) try { await rename(temporary, file); break; } catch (error) {
    if (!['EBUSY', 'EPERM'].includes(error.code) || attempt >= 2) throw error;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}
for (const name of ['provider', 'consumer']) {
  const src = resolve(root, 'tests/fixtures/workspace-acceptance', name), dest = resolve(out, name); await mkdir(dest, { recursive: true });
  await save(resolve(dest, 'codlet.json'), await readFile(resolve(src, 'codlet.json')));
  if (name === 'provider') await save(resolve(dest, 'renderer.js'), (await buildPlugin(resolve(root, 'frontend'), '../tests/fixtures/workspace-acceptance/provider/renderer-source.js')).code);
  else for (const file of ['renderer.js', 'host.cjs']) await save(resolve(dest, file), await readFile(resolve(src, file)));
}
console.log(out);
