import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
// Keep this composition byte-for-byte equivalent to js_runtime::BOOTSTRAP.
export async function buildHostBootstrap(root) {
  const read=relative=>readFile(resolve(root,relative),'utf8');
  const [services,license,parser,sdk,codex,traffic,host]=await Promise.all([
    'runtime/core-services.cjs','runtime/sdk-source-parser.LICENSE','runtime/sdk-source-parser.cjs',
    'runtime/sdk-host.cjs','runtime/codex-host-bundle.cjs','runtime/host-traffic-bundle.cjs','runtime/host.cjs'].map(read));
  const source='const createEmbeddedServicesRuntime = (() => { const module = { exports: {} };\n'+services+'\nreturn module.exports.createCoreServicesRuntime; })();\n'
    +'const parseEmbeddedSdkHostSource = (() => { const module = { exports: {} };\n/*\n'+license+'\n*/\n'+parser+'\nreturn module.exports.parse; })();\n'
    +'const createEmbeddedSdkHost = (() => { const module = { exports: {} };\n'+sdk+'\nreturn module.exports.createSdkHost; })();\n'
    +'const createEmbeddedCodexHost = (() => { const module = { exports: {} };\n'+codex+'\nreturn module.exports.createCodexHost; })();\n'+traffic+'\n'+host;
  const file=resolve(root,'runtime/core-modules/host-bootstrap.cjs');await mkdir(dirname(file),{recursive:true});await writeFile(file,source);
  return file;
}
