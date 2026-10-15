// Developer-only reproducible bundle generation. Runtime loading never searches
// these development dependencies or PATH. Pass the frontend package directory.
import {createRequire} from 'node:module';
import {readFile,copyFile} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const frontend=resolve(process.argv[2]??resolve(root,'frontend'));
const require=createRequire(resolve(frontend,'package.json'));
const acornPath=require.resolve('acorn/package.json');
const metadata=JSON.parse(await readFile(acornPath,'utf8'));
if(metadata.version!=='8.15.0')throw Error('SDK source parser generation requires the pinned Acorn 8.15.0');
const {build}=require('esbuild');
await build({stdin:{contents:"module.exports.parse = require('acorn').parse;",resolveDir:frontend},platform:'node',format:'cjs',bundle:true,minify:true,outfile:resolve(root,'runtime/sdk-source-parser.cjs'),banner:{js:'// Acorn 8.15.0 (MIT), generated SDK source admission parser; see sdk-source-parser.LICENSE.'}});
await copyFile(resolve(dirname(acornPath),'LICENSE'),resolve(root,'runtime/sdk-source-parser.LICENSE'));
