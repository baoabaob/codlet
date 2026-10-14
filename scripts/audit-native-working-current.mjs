// Static exact-source comparison only; never imports or executes Native assets.
import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';
import {createHash}from'node:crypto';import {createRequire}from'node:module';
const [legacyDirectory,currentDirectory,output]=process.argv.slice(2);
if(!legacyDirectory||!currentDirectory)throw Error('Pass preserved 2314 and extracted 9446 asset directories');
const pins={
 legacy:{initial:{name:'app-initial-b8e1c8014bb4.js',sha256:'799331dde54905c4df5e360f23a9621141759e2c0acb230aeab909f9904b646f'},shared:{name:'app-shared-737655e1fb23.js',sha256:'a1daa891e89a395b8db399ff6eaa365f12a86880c3d8cf891caf4ccbcb9eebf5'}},
 current:{initial:{name:'app-initial-102e45562729.js',sha256:'c59b2a0be6c13496b30ebda167925cdccab26799cae350c62d2b37afe3589b57'},shared:{name:'app-shared-30671c57ec82.js',sha256:'392b023063a3569a2efc47a019accb2d1e72295b1bfec2cbb81fc37e1515580a'}},
};
const require=createRequire(new URL('../frontend/package.json',import.meta.url)),{parse}=require('acorn');
function read(directory,entries){let initial;for(const [role,pin]of Object.entries(entries)){const bytes=fs.readFileSync(path.join(directory,pin.name));assert.equal(createHash('sha256').update(bytes).digest('hex'),pin.sha256,pin.name);if(role==='initial')initial=bytes.toString()}
 const ast=parse(initial,{ecmaVersion:'latest',sourceType:'module'}),nodes=new Map();
 function visit(node){if(!node||typeof node!=='object')return;if(node.type==='FunctionDeclaration')nodes.set(node.id.name,node);if(node.type==='AssignmentExpression'&&node.left.type==='Identifier')nodes.set(node.left.name,node);for(const value of Object.values(node)){if(Array.isArray(value))for(const item of value)visit(item);else if(value&&typeof value==='object')visit(value)}}visit(ast);
 const exports=new Map(ast.body.filter(node=>node.type==='ExportNamedDeclaration').flatMap(node=>node.specifiers).map(node=>[node.exported.name,node.local.name]));return{nodes,exports};}
function shape(node,parent=null,key=null){if(typeof node==='bigint')return{bigint:String(node)};if(!node||typeof node!=='object')return node;if(Array.isArray(node))return node.map(value=>shape(value,parent,key));return Object.fromEntries(Object.entries(node).filter(([name])=>!['start','end','raw'].includes(name)).map(([name,value])=>[name,node.type==='Identifier'&&name==='name'&&!(key==='property'&&parent?.computed===false||key==='key'&&parent?.computed===false)?'#':shape(value,node,name)]));}
const old=read(legacyDirectory,pins.legacy),current=read(currentDirectory,pins.current),checks={};
const selectors={response:{export:'vfn',legacy:'f9n',current:'tF'},pending:{export:'nfn',legacy:'k9n',current:'P9n'},publishing:{export:'AW',legacy:'lGo',current:'uGo'}};
for(const [role,selector]of Object.entries(selectors)){assert.equal(old.exports.get(selector.export),selector.legacy);assert.equal(current.exports.get(selector.export),selector.current);checks[role+'ExportBinding']=true;}
const pairs=[['responseSelector','f9n','tF'],['pendingSelector','k9n','P9n'],['publishingSelector','lGo','uGo'],['responseClassification','d9n','y9n'],['ownedChildWork','c9n','g9n'],['blockingAndAsyncInput','T9n','A9n'],['publicationIdentityAndState','cGo','lGo']];
const shapes={};for(const [role,left,right]of pairs){assert.ok(old.nodes.has(left)&&current.nodes.has(right),role);const a=JSON.stringify(shape(old.nodes.get(left))),b=JSON.stringify(shape(current.nodes.get(right)));assert.equal(a,b,role);checks[role+'Preserved']=true;shapes[role]={legacy:left,current:right,normalizedAstSha256:createHash('sha256').update(a).digest('hex')};}
const report={schema:1,packageVersion:'26.1007.9446.0',frontendVersion:'26.1007.71326',buildNumber:'20398',kind:'exact-source-working-selector-review',sourceHashes:pins,selectors,shapes,checks,
 limitations:['Identifier normalization alone is not a support declaration; selected dependency roles were reviewed separately.','Live selectors must still match the owned Native AppScope token and read/watch interface.','Running, blocked, async input, owned child work and publication behavior require actual owned scenarios; an empty read-only probe does not validate them.','No macOS acceptance is established.']};
if(output)fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({checks:Object.keys(checks).length,passed:true}));
