// Produce compatibility metadata from the exact source bundles embedded in the
// resident build. The installer separately compares actual executable/Node
// payload hashes before allowing online activation.
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
const sourceRoot=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
export const coreModuleIds=['renderer-bootstrap','renderer-helpers','renderer-ui','renderer-facade','renderer-page','renderer-i18n','renderer-codex-sdk','renderer-core-services','core-ui-provider','core-desktop-provider','host-bootstrap'];
export const coreModulePath=id=>'runtime/core-modules/'+id+(id==='renderer-core-services'||id.startsWith('core-')||id==='host-bootstrap'?'.cjs':'.js');
export async function onlineCoreMetadata(root=sourceRoot,{includeModules=false,moduleIds}={}) {
  const metadata={schema:1,bridgeProtocol:1,
    bridgeSha256:digest(await readFile(resolve(root,'runtime/client-bridge-bundle.cjs'))),
    bootstrapSha256:digest(await readFile(resolve(root,'runtime/client-bridge-bootstrap.cjs'))),
    clientSourcePath:'runtime/core-modules/client-source.cjs'};
  const selected=moduleIds??(includeModules?coreModuleIds:[]);
  if(!Array.isArray(selected)||new Set(selected).size!==selected.length||selected.some(id=>!coreModuleIds.includes(id)))throw Error('Unknown or duplicate Core module ID');
  if(selected.length){await Promise.all(selected.map(async id=>{const bytes=await readFile(resolve(root,coreModulePath(id)));if(bytes.length>8*1024*1024)throw Error('Core module exceeds 8 MiB: '+id);}));
    metadata.moduleAbi=1;metadata.modules=selected.map(id=>({id,path:coreModulePath(id)}));}
  return metadata;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const output=process.argv[2];if(!output)throw Error('Usage: node scripts/prepare-online-core.mjs <output-metadata.json> [exact-build-source-root] [--all-modules]');
  const file=resolve(output);await mkdir(dirname(file),{recursive:true});
  const selectedRoot=process.argv[3]&&!process.argv[3].startsWith('--')?resolve(process.argv[3]):sourceRoot;
  const selected=process.argv.find(value=>value.startsWith('--modules='));
  if(selected&&process.argv.includes('--all-modules'))throw Error('Choose all modules or explicit module IDs');
  await writeFile(file,JSON.stringify(await onlineCoreMetadata(selectedRoot,{includeModules:process.argv.includes('--all-modules'),...(selected?{moduleIds:selected.slice(10).split(',')}: {})}),null,2)+'\n',{flag:'wx'});
  console.log(JSON.stringify({metadataPath:file,onlineComponent:'native-client-source',residentActivation:'unchanged'}));
}
