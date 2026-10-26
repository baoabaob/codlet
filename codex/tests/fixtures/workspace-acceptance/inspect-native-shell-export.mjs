import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from '../../../frontend/node_modules/acorn/dist/acorn.mjs';
const directory=process.argv[2]??fileURLToPath(new URL('../../../.artifacts/composer-native-26.1007/',import.meta.url));
if(!path.isAbsolute(directory)||process.argv.length>3)throw Error('Supply one absolute captured Native cache directory');
const files=['app-initial-b8e1c8014bb4.js','app-shared-737655e1fb23.js'].map(name=>path.join(directory,name));
for(const file of files){
  const source=fs.readFileSync(file,'utf8'),ast=parse(source,{ecmaVersion:'latest',sourceType:'module'}),exports=new Map();
  for(const item of ast.body)if(item.type==='ExportNamedDeclaration')for(const spec of item.specifiers)exports.set(spec.local.name,spec.exported.name);
  const found=[];function visit(node){if(!node||typeof node!=='object')return;
    if(node.type==='AssignmentExpression'&&node.right.type==='ObjectExpression'){
      const keys=node.right.properties.map(p=>p.key?.name??p.key?.value);
      if(keys.includes('RightPanelOutlet')&&keys.includes('DetailPanelOutlet'))found.push({local:node.left.name,exported:exports.get(node.left.name),keys,source:source.slice(node.start,node.end).slice(0,18000)});
    }
    for(const [key,value]of Object.entries(node))if(key!=='start'&&key!=='end'){if(Array.isArray(value))value.forEach(visit);else if(value&&typeof value==='object')visit(value);}
  }visit(ast);console.log(JSON.stringify({file,found,setterExport:exports.get('yI'),roles:Object.fromEntries(['TC','CS','EC','Dzt','Ozt','jzt','OIi','YPt','JPt','qPt','KPt','mC','kzt','hI','_I','yI','DI','EI'].map(key=>[key,exports.get(key)??null]))}));
}
