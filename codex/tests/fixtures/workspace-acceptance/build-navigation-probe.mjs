import{writeFile,mkdir,copyFile}from'node:fs/promises';
import{resolve,dirname}from'node:path';
import{fileURLToPath}from'node:url';
import{buildPlugin}from'../../../frontend/build-plugin.mjs';
const here=dirname(fileURLToPath(import.meta.url)),root=resolve(here,'../../..'),out=resolve(root,'.artifacts/workspace-navigation-probe'),cap={name:'workspace.audit.navigation',api:1,scope:'target'};
for(const role of ['provider','consumer']){const dest=resolve(out,role);await mkdir(dest,{recursive:true});await writeFile(resolve(dest,'renderer.js'),(await buildPlugin(resolve(root,'frontend'),'../tests/fixtures/workspace-acceptance/navigation/'+role+'.js')).code);const manifest={schema:1,id:'dev.workspace.navigation-probe-'+role,name:'Native warm navigation '+role,version:'0.0.1',renderer:{entry:'renderer.js',world:'main'},permissions:role==='provider'?['ui.dom','ui.mainWorld']:['ui.mainWorld','host.process','cdp.raw'],...(role==='provider'?{provides:[cap]}:{requires:[cap],host:{entry:'host.cjs'}})};await writeFile(resolve(dest,'codlet.json'),JSON.stringify(manifest,null,2)+'\n');if(role==='consumer')await copyFile(resolve(here,'navigation/host.cjs'),resolve(dest,'host.cjs'));}
console.log(out);
