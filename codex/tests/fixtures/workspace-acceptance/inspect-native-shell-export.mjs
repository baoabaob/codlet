import fs from 'node:fs';
import { parse } from '../../../frontend/node_modules/acorn/dist/acorn.mjs';
const files=['X:/codlet-plugins/.artifacts/composer-native-26.1007/app-initial-b8e1c8014bb4.js','X:/codlet-plugins/.artifacts/composer-native-26.1007/app-shared-737655e1fb23.js'];
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
