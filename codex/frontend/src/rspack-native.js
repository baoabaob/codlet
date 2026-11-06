import {parse} from 'acorn';
import {analyze} from 'eslint-scope';

const fail=(code,message)=>Object.assign(new Error(message),{code});
const own=(value,key)=>Object.getOwnPropertyDescriptor(value??{},key)?.value;
const literal=node=>node?.type==='Literal'?node.value:undefined;
const member=node=>node?.type==='MemberExpression'&&!node.computed?node.property.name:undefined;
const last=node=>node?.type==='SequenceExpression'?node.expressions.at(-1):node;
const entries=doc=>Array.from(doc.scripts??[]).filter(script=>script.type==='module'&&/^app:\/\/-\/assets\/[0-9]+\.[a-f0-9]+\.js$/.test(script.src));
const cache=new WeakMap();
export function isRspackNamespace(value){try{return typeof value==='function'||value!==null&&typeof value==='object'&&[null,Object.prototype].includes(Object.getPrototypeOf(value));}catch{return false;}}
function* walk(root){const pending=[root],seen=new Set();while(pending.length){const node=pending.pop();if(!node?.type||seen.has(node))continue;seen.add(node);yield node;for(const [key,value]of Object.entries(node)){if(['start','end','range','loc'].includes(key))continue;if(Array.isArray(value))pending.push(...value);else if(value?.type)pending.push(value);}}}

// Parse the actual factory retained by Native's current runtime. A require with
// the same spelling in a nested scope is not an edge in this module graph.
export function rspackFactory(factory){
  const source=typeof factory==='function'?Function.prototype.toString.call(factory):factory;
  let program,fn,offset;
  try{program=parse('('+source+')',{ecmaVersion:'latest',sourceType:'module',ranges:true});fn=program.body[0].expression;offset=1;}
  catch{program=parse('({'+source+'})',{ecmaVersion:'latest',sourceType:'module',ranges:true});fn=program.body[0].expression.properties[0].value;offset=2;}
  if(!['FunctionExpression','ArrowFunctionExpression'].includes(fn?.type)||fn.params.length>3||fn.params.some(p=>p.type!=='Identifier'))throw fail('desktop_asset_drift','Native module factory parameters changed');
  const scopes=analyze(program,{ecmaVersion:2025,sourceType:'module',optimistic:false,ignoreEval:false});
  const scope=scopes.acquire(fn),requireBinding=scope?.set.get(fn.params[2]?.name),exportsBinding=scope?.set.get(fn.params[1]?.name),references=new WeakMap(),definitions=new WeakMap();
  for(const scope of scopes.scopes)for(const ref of scope.references)references.set(ref.identifier,ref.resolved);
  for(const variable of scope?.variables??[])for(const definition of variable.defs)definitions.set(definition.node,variable);
  const isRequire=node=>!!requireBinding&&node?.type==='Identifier'&&references.get(node)===requireBinding;
  const dependencies=new Set(),imports=new Map();
  for(const node of walk(fn.body)){
    if(node.type==='CallExpression'&&isRequire(node.callee)&&node.arguments.length===1&&typeof literal(node.arguments[0])==='string')dependencies.add(literal(node.arguments[0]));
    if(node.type==='CallExpression'&&member(node.callee)==='bind'&&isRequire(node.callee.object)&&isRequire(node.arguments[0])&&typeof literal(node.arguments[1])==='string')dependencies.add(literal(node.arguments[1]));
    if(node.type==='VariableDeclarator'&&definitions.has(node)&&node.id.type==='Identifier'&&node.init?.type==='CallExpression'&&isRequire(node.init.callee)&&typeof literal(node.init.arguments[0])==='string')imports.set(node.id.name,literal(node.init.arguments[0]));
  }
  const exports=new Map(),declarations=new Map();
  for(const node of walk(fn.body)){
    if(node.type==='VariableDeclarator'&&definitions.has(node)&&node.id.type==='Identifier')declarations.set(node.id.name,node.init);
    if(node.type==='FunctionDeclaration'&&definitions.has(node))declarations.set(node.id.name,node);
    if(node.type==='CallExpression'&&member(node.callee)==='d'&&isRequire(node.callee.object)&&references.get(node.arguments[0])===exportsBinding){
      for(let index=1;index<node.arguments.length;index++){const object=node.arguments[index];if(object.type!=='ObjectExpression')continue;
        for(const property of object.properties)if(property.type==='Property'&&!property.computed){let value=property.value;
          if(index===1&&value.type==='ArrowFunctionExpression'&&!value.params.length)value=value.body;
          exports.set(property.key.name??property.key.value,value);
        }
      }
    }
  }
  return{source,fn,offset,dependencies,imports,exports,declarations,isRequire,global:(node,name)=>node?.type==='Identifier'&&node.name===name&&!references.get(node),body:source.slice(fn.body.start-offset+1,fn.body.end-offset-1),text:node=>source.slice(node.start-offset,node.end-offset)};
}

export function isRspackDocument(doc=globalThis.document){return entries(doc).length>0;}

export function bindRspackRuntime(require,{document:doc,entry,signal}){
  const table=own(require,'m'),modules=own(require,'c');
  const root=doc.getElementById('root'),rootKey=root&&Object.keys(root).find(key=>key.startsWith('__reactContainer$')),container=rootKey&&root[rootKey];
  const internal=container?.stateNode??(container?.current?container:null),publicRoot=own(doc.defaultView,'__codexRoot');
  if(typeof require!=='function'||!table||!modules||!internal?.current||internal.containerInfo!==root||own(publicRoot,'_internalRoot')!==internal)throw fail('desktop_asset_drift','Native module runtime does not own the mounted React root');
  const capturedEntries=entries(doc).map(script=>[script,script.src]);
  const descriptions=new WeakMap(),description=factory=>{if(!descriptions.has(factory))descriptions.set(factory,rspackFactory(factory));return descriptions.get(factory);};
  const roots=[];
  for(const id of Object.keys(modules)){
    const factory=own(table,id);if(typeof factory!=='function'||!Function.prototype.toString.call(factory).includes('__codexRoot'))continue;
    const info=description(factory),nodes=[...walk(info.fn.body)];
    const creation=nodes.filter(node=>node.type==='AssignmentExpression'&&member(node.left)==='__codexRoot'&&last(node.right)?.type==='CallExpression'&&member(last(last(node.right).callee))==='createRoot');
    if(creation.length!==1)continue;
    const call=last(creation[0].right),callee=last(call.callee),reactModule=info.imports.get(callee.object?.name);
    const element=call.arguments[0];
    const containerRead=nodes.some(node=>node.type==='VariableDeclarator'&&node.id.name===element?.name&&node.init?.type==='CallExpression'&&member(node.init.callee)==='getElementById'&&info.global(node.init.callee.object,'document')&&literal(node.init.arguments[0])==='root');
    const windows=new Set(nodes.filter(node=>node.type==='VariableDeclarator'&&info.global(node.init,'window')).map(node=>node.id.name));
    const rootBindings=new Set(nodes.filter(node=>node.type==='VariableDeclarator'&&member(node.init)==='__codexRoot'&&windows.has(node.init.object.name)).map(node=>node.id.name));
    const rendered=nodes.some(node=>node.type==='CallExpression'&&member(node.callee)==='render'&&rootBindings.has(node.callee.object.name));
    if(containerRead&&windows.has(creation[0].left.object.name)&&rendered&&typeof own(modules,reactModule)?.exports?.createRoot==='function')roots.push({id,factory,module:own(modules,id),clientId:reactModule,createRoot:own(modules,reactModule).exports.createRoot});
  }
  if(roots.length!==1)throw fail('desktop_asset_drift','A unique mounted Native root factory is required');
  const owner=roots[0],captured=new Map(),pinned=new Set(),bindings=[];
  const checkOwner=()=>{
    signal?.throwIfAborted();
    if(globalThis.document!==doc||doc.getElementById('root')!==root||root[rootKey]!==container||internal.current?.stateNode!==internal||own(doc.defaultView,'__codexRoot')!==publicRoot||own(publicRoot,'_internalRoot')!==internal||own(require,'m')!==table||own(require,'c')!==modules||own(modules,owner.id)!==owner.module)throw fail('desktop_asset_owner_replaced','Native module runtime or React root was replaced');
    const current=entries(doc);if(current.length!==capturedEntries.length||capturedEntries.some(([script,url],index)=>current[index]!==script||script.src!==url))throw fail('desktop_asset_owner_replaced','Native entry scripts were replaced');
  };
  const currentRecord=id=>{checkOwner();const record=captured.get(id);if(record&&(own(modules,id)!==record.module||own(record.module,'exports')!==record.namespace))throw fail('desktop_asset_owner_replaced','Native module binding was replaced');return record;};
  const pin=record=>{if(currentRecord(record.id)!==record)throw fail('desktop_asset_owner_replaced','Native module owner was replaced');pinned.add(record);};
  const check=()=>{checkOwner();for(const record of pinned)currentRecord(record.id);for(const {record,key,value}of bindings)if(record.namespace[key]!==value)throw fail('desktop_asset_owner_replaced','Native export binding was replaced');};
  const records=()=>{
    check();const result=new Map();
    // The cache belongs to this mounted document's proven runtime. Inspect
    // exported objects first; only a selected role needs its factory's AST.
    for(const id of Object.keys(modules)){
      const module=own(modules,id),factory=own(table,id);if(!module||typeof factory!=='function')continue;
      const namespace=own(module,'exports');
      // Later chunks can register another factory for an already cached module.
      // The live cache owner still retains its original exports and source.
      const previous=captured.get(id);
      const record=previous?.module===module&&previous.namespace===namespace?previous:{id,url:entry.src+'#module='+encodeURIComponent(id),module,factory,namespace,get info(){return description(factory);}};
      captured.set(id,record);result.set(record.url,record);
    }
    check();return result;
  };
  const pinValue=value=>{let found=false;for(const record of records().values()){
    if(!isRspackNamespace(record.namespace))continue;
    if(record.namespace===value){pin(record);found=true;continue;}
    for(const[key,item]of Object.entries(record.namespace??{}))if(item===value){pin(record);found=true;if(!bindings.some(binding=>binding.record===record&&binding.key===key))bindings.push({record,key,value});}
  }if(!found)throw fail('desktop_asset_owner_replaced','Selected Native export is no longer owned by the current module cache');};
  const prepareExport=async(name,{signal}={})=>{
    const active=()=>{signal?.throwIfAborted();check();};active();const matches=[];
    for(const record of records().values()){
      if(!Object.hasOwn(record.namespace??{},name))continue;
      const exported=record.info.exports.get(name),value=exported?.type==='Identifier'?record.info.declarations.get(exported.name):exported;
      const loader=value?.type==='CallExpression'?value.arguments[0]:null,selected=loader?.body;
      if(loader?.type!=='ArrowFunctionExpression'||!loader.async||loader.params.length||selected?.type!=='MemberExpression'||selected.computed||selected.property.name!==name||selected.object.type!=='AwaitExpression')continue;
      const load=selected.object.argument,then=load?.callee,bound=load?.arguments?.[0],promise=then?.object,all=promise?.callee,chunks=promise?.arguments?.[0],info=record.info;
      if(load?.type!=='CallExpression'||member(then)!=='then'||load.arguments.length!==1||bound?.type!=='CallExpression'||member(bound.callee)!=='bind'||!info.isRequire(bound.callee.object)||!info.isRequire(bound.arguments[0])||typeof literal(bound.arguments[1])!=='string'||promise?.type!=='CallExpression'||member(all)!=='all'||!info.global(all.object,'Promise')||promise.arguments.length!==1||chunks?.type!=='ArrayExpression')continue;
      if(chunks.elements.some(chunk=>chunk?.type!=='CallExpression'||member(chunk.callee)!=='e'||!info.isRequire(chunk.callee.object)||chunk.arguments.length!==1||!Number.isSafeInteger(literal(chunk.arguments[0]))))continue;
      matches.push({record,id:literal(bound.arguments[1]),chunks:chunks.elements.map(chunk=>literal(chunk.arguments[0]))});
    }
    if(matches.length!==1)throw fail('desktop_asset_drift',`A unique Native lazy ${name} export is required`);
    const match=matches[0],loadChunk=own(require,'e');pin(match.record);if(typeof loadChunk!=='function')throw fail('desktop_asset_drift','Native chunk loader is unavailable');
    await Promise.all(match.chunks.map(id=>{active();return loadChunk.call(require,id);}));active();
    if(own(require,'e')!==loadChunk)throw fail('desktop_asset_owner_replaced','Native lazy loader was replaced');
    const namespace=require(match.id);active();return namespace;
  };
  const client=()=>{records();const record=currentRecord(owner.clientId);if(record?.namespace?.createRoot!==owner.createRoot)throw fail('desktop_asset_owner_replaced','Native React root factory was replaced');pin(record);pinValue(record.namespace.createRoot);return record.namespace;};
  return{kind:'rspack',entry:entry.src,require,check,pin,pinValue,client,record:currentRecord,records,prepareExport,modules:()=>new Map([...records()].filter(([,record])=>isRspackNamespace(record.namespace)).map(([url,record])=>[url,record.namespace]))};
}

export function rspackReference(runtime,record,node){
  if(runtime.record(record.id)!==record)throw fail('desktop_asset_owner_replaced','Native factory owner was replaced');const {info}=record;
  if(node?.type==='Identifier'){const aliases=[...info.exports].filter(([,value])=>value.type==='Identifier'&&value.name===node.name);const values=[...new Set(aliases.map(([key])=>record.namespace[key]))];return values.length===1?values[0]:undefined;}
  if(node?.type==='MemberExpression'&&!node.computed&&node.object.type==='Identifier'){
    const id=info.imports.get(node.object.name),target=runtime.record(id);return target?.namespace?.[node.property.name];
  }
}

export function rspackExportRecords(runtime,predicate=()=>true){
  const result=[];
  for(const record of runtime.records().values()){if(!isRspackNamespace(record.namespace))continue;for(const[key,value]of Object.entries(record.namespace)){
    if(!predicate(value))continue;const raw=record.info.exports.get(key);if(!raw)continue;
    result.push({record,key,value,expression:raw.type==='Identifier'?record.info.declarations.get(raw.name)??raw:raw});
  }}
  return result;
}

export async function loadRspackNative({load=url=>import(url),read,signal}={}){
  const doc=globalThis.document;if(!isRspackDocument(doc))return null;
  const scoped=runtime=>{const check=()=>{signal?.throwIfAborted();runtime.check();};return{...runtime,check,records(){check();return runtime.records();},modules(){check();return runtime.modules();},prepareExport(name){check();return runtime.prepareExport(name,{signal});}};};
  const previous=cache.get(doc);if(previous){previous.check();signal?.throwIfAborted();return scoped(previous);}
  const readSource=read??(async url=>{const response=await fetch(url,{credentials:'omit',signal});if(!response.ok||response.url!==url)throw fail('desktop_asset_drift','Native entry source is unavailable');return response.text();});
  const candidates=[];
  for(const entry of entries(doc)){
    signal?.throwIfAborted();const source=await readSource(entry.src),ast=parse(source,{ecmaVersion:'latest',sourceType:'module'});
    if(ast.body.some(node=>node.type==='ExportNamedDeclaration'&&node.specifiers.some(s=>(s.exported.name??s.exported.value)==='__webpack_require__')))candidates.push(entry);
  }
  if(candidates.length!==1)throw fail('desktop_asset_drift','A unique Native Rspack entry is required');
  const entry=candidates[0],namespace=await load(entry.src);signal?.throwIfAborted();
  const runtime=bindRspackRuntime(namespace.__webpack_require__,{document:doc,entry});runtime.check();cache.set(doc,runtime);return scoped(runtime);
}
