// Inspect extracted source without importing Native modules or running methods.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),{parse}=require('../runtime/sdk-source-parser.cjs');
const {supportsRole,required}=require('../codex/host/source-contracts.cjs');
const [directory,output]=process.argv.slice(2);
if(!path.isAbsolute(directory??'')||!path.isAbsolute(output??'')||fs.existsSync(output))throw Error('Pass an extracted source directory and a new report path');
const matches=Object.fromEntries(Object.keys(required).map(role=>[role,[]])),files=[];
for(const filename of fs.readdirSync(directory).filter(name=>/^(bootstrap|main|application-network-startup|src)-.*\.js$/u.test(name))){
  const source=fs.readFileSync(path.join(directory,filename),'utf8');
  if(source.length>20*1024*1024)throw Error('Source exceeds observation budget');
  const ast=parse(source,{ecmaVersion:'latest',sourceType:'script'}),classes=[];
  for(const node of ast.body){
    if(node.type==='ClassDeclaration')classes.push({binding:node.id.name,node});
    if(node.type==='VariableDeclaration')for(const value of node.declarations)if(value.id.type==='Identifier'&&value.init?.type==='ClassExpression')classes.push({binding:value.id.name,node:value.init});
  }
  const candidates=[];
  for(const {binding,node}of classes){
    const methods=node.body.body.filter(method=>method.type==='MethodDefinition'&&!method.static&&!method.computed&&method.kind==='method');
    const names=methods.map(method=>method.key.name??method.key.value);
    const roles=Object.entries(required).filter(([,required])=>required.every(name=>names.includes(name))).map(([role])=>role);
    if(!roles.length)continue;
    const selected=methods.filter(method=>roles.some(role=>required[role].includes(method.key.name??method.key.value)));
    let Constructor;try{Constructor=vm.runInNewContext(`(class SourceContract {${selected.map(method=>source.slice(method.start,method.end)).join('\n')}})`,{}, {timeout:100});}catch{continue;}
    for(const role of roles)if(supportsRole(Constructor,role,false)){matches[role].push({filename,binding});candidates.push({binding,role});}
  }
  files.push({filename,sha256:createHash('sha256').update(source).digest('hex'),candidates});
}
const report={schema:1,kind:'structural-method-contracts',files,matches,passed:Object.values(matches).every(values=>values.length===1)};
fs.mkdirSync(path.dirname(output),{recursive:true});fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({passed:report.passed,matches}));if(!report.passed)process.exitCode=1;
