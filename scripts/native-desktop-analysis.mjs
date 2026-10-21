import fs from 'node:fs';
import path from 'node:path';
import {digest} from './lib/native-source-snapshot.mjs';
import {resolveModulePath} from './lib/native-source-index.mjs';
import {NATIVE_PERMISSION_FUNCTIONS,matchesNativePermissionSource} from '../codex/frontend/src/desktop/permission-contracts.js';
import {WORKING_PROFILES} from '../codex/frontend/src/desktop/native-working.js';

const [input,output]=process.argv.slice(2);
if(!input||!path.isAbsolute(output??'')||fs.existsSync(output))throw Error('Use INDEX_JSON NEW_ABSOLUTE_REPORT_JSON');
const index=JSON.parse(fs.readFileSync(input,'utf8'));
const metadata=fs.readFileSync(path.join(index.snapshot,'snapshot.json'));
if(digest(metadata)!==index.snapshotSha256)throw Error('Snapshot changed after indexing');
const files=new Map(JSON.parse(metadata).files.map(file=>[file.path,file]));
const modules=index.modules.filter(module=>/^webview\/assets\/app-(?:shared|initial)-[^/]+\.js$/.test(module.path));
const sources=new Map(modules.map(module=>{
  const bytes=fs.readFileSync(path.join(index.snapshot,'sources',module.path));
  if(digest(bytes)!==module.sha256||files.get(module.path)?.sha256!==module.sha256)throw Error('Indexed desktop source changed');
  return[module.path,bytes.toString('utf8')];
}));
const records=modules.flatMap(module=>module.records.map(record=>({module,record})));
const evidence=({module,record})=>({file:module.path,sha256:module.sha256,binding:record.binding,local:record.local,
  exports:record.exportNames,start:record.start,end:record.end,normalizedHash:record.normalizedHash});
const located=candidates=>({status:candidates.length===1?'located':candidates.length?'ambiguous':'not-located',candidates:candidates.map(evidence)});
const scopes=Object.fromEntries(['AppScope','ComposerScope','ThreadScope','RouteScope'].map(brand=>[brand,located(records.filter(item=>
  item.record.exportNames.length&&item.record.value?.type==='CallExpression'&&item.record.value.arguments[0]?.literal===brand))]));
const functions=Object.fromEntries(Object.entries(NATIVE_PERMISSION_FUNCTIONS).map(([name,contract])=>[name,located(records.filter(item=>
  item.record.exportNames.length&&item.record.interface?.kind==='function'&&matchesNativePermissionSource(
    sources.get(item.module.path).slice(item.record.start.offset,item.record.end.offset),item.record.interface.parameters.length,contract)))]));
const profiles=WORKING_PROFILES.filter(profile=>modules.some(module=>module.path==='webview/assets/'+profile.initial)&&
  modules.some(module=>module.path==='webview/assets/'+profile.shared));
const profile=profiles.length===1?profiles[0]:null;
const key=(module,binding)=>module.path+'#'+binding;
const byPath=new Map(modules.map(module=>[module.path,module]));
const resolve=(module,binding,seen=new Set())=>{
  const id=key(module,binding);if(seen.has(id))return null;seen.add(id);
  for(const imported of module.imports.filter(item=>!item.dynamic)){
    const specifier=imported.specifiers.find(value=>value.binding===binding);if(!specifier)continue;
    const target=byPath.get(resolveModulePath(module.path,imported.source));
    const exported=target?.exports.filter(value=>value.exported===specifier.imported);
    return exported?.length===1?resolve(target,exported[0].binding,seen):null;
  }
  return id;
};
const app=scopes.AppScope.candidates[0];
const workingShapes={response:'eadb208e09e9cee96c1f38c97c308a40256b0cc13ee1743858ae68ad072d30e6',
  pending:'cc7be3020ec28aec98a44318c403524c94326d029ba786a8ac8bedf0677ac7af',
  publishing:'b2be6a8faf19f1bf133a538db50525db3aaeed39c845c9ff2fb07d02b959fda6'};
const working=Object.fromEntries(['response','pending','publishing'].map(role=>{
  const candidates=profile?records.filter(item=>item.module.path==='webview/assets/'+profile.initial&&item.record.exportNames.includes(profile[role])):[];
  const result=located(candidates);
  result.appScopeMatched=candidates.length===1&&!!app&&candidates[0].record.value?.type==='CallExpression'&&
    resolve(candidates[0].module,candidates[0].record.value.arguments[0]?.binding)===app.file+'#'+app.binding;
  result.reviewedShapeMatched=candidates.length===1&&candidates[0].record.normalizedHash===workingShapes[role];
  if(result.status==='located'&&(!result.appScopeMatched||!result.reviewedShapeMatched))result.status='interface-mismatch';
  return[role,result];
}));
const report={schema:1,kind:'native-desktop-source-analysis',identity:index.identity,snapshotSha256:index.snapshotSha256,
  scopes,functions,working:{profile,roles:working},nativeModulesExecuted:0,live:'not-verified'};
report.passed=[...Object.values(scopes),...Object.values(functions),...Object.values(working)].every(role=>role.status==='located');
fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({output,build:index.identity.buildNumber,passed:report.passed,checks:Object.keys(scopes).length+Object.keys(functions).length+Object.keys(working).length,
  failures:Object.entries({...scopes,...functions,...working}).filter(([,role])=>role.status!=='located').map(([role,value])=>({role,status:value.status}))},null,2));
if(!report.passed)process.exitCode=1;
