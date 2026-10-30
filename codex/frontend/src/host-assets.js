import {parse,tokenizer} from 'acorn';
import {analyze} from 'eslint-scope';
import {desktopDocument,loadedAsset} from './host-discovery.js';

const fail=(code,message)=>Object.assign(new Error(message),{code});
const text=node=>node?.type==='Literal'?node.value:node?.type==='TemplateLiteral'&&!node.expressions.length?node.quasis[0].value.cooked:undefined;
const property=node=>node?.computed?text(node.property):node?.property?.name;
const last=node=>node?.type==='SequenceExpression'?last(node.expressions.at(-1)):node;
const asset=/^app:\/\/-\/assets\/[A-Za-z0-9_.-]+\.js$/;
const role=(url,name)=>new RegExp('^app://-/assets/app-'+name+'-[A-Za-z0-9_-]+\\.js$').test(url);
const completed=new WeakMap();
function* nodes(ast){const pending=[ast],seen=new Set();while(pending.length){const node=pending.pop();if(!node?.type||seen.has(node))continue;seen.add(node);yield node;for(const [key,value]of Object.entries(node)){if(['range','loc','start','end'].includes(key))continue;if(Array.isArray(value))pending.push(...value);else if(value?.type)pending.push(value);}}}
const urlFor=(value,parent)=>{try{const url=new URL(value,parent).href;return asset.test(url)?url:null;}catch{return null;}};

// Tokenize complete modules but parse only their static import declarations.
// Imported role modules are terminals; unrelated lazy imports are never read.
export function staticModuleImports(source,parent){
  const stream=tokenizer(source,{ecmaVersion:'latest',sourceType:'module'}),imports=[];
  let braces=0,brackets=0,parens=0;
  for(;;){const token=stream.getToken(),label=token.type.label;if(label==='eof')break;
    if(label==='import'&&!braces&&!brackets&&!parens){
      let item=stream.getToken();
      if(item.type.label==='('){parens++;continue;}
      if(item.type.label==='.')continue;
      let depth=0;
      for(;;){const kind=item.type.label;if(kind==='eof')throw fail('desktop_asset_drift','Native static import is incomplete');
        if(kind==='string'&&!depth){const url=urlFor(item.value,parent);if(!url)throw fail('desktop_asset_drift','Native static import is outside the supported module graph');imports.push(url);break;}
        if(kind==='{')depth++;if(kind==='}')depth--;item=stream.getToken();
      }
      continue;
    }
    if(label==='{'||label==='${')braces++;if(label==='}')braces--;
    if(label==='[')brackets++;if(label===']')brackets--;
    if(label==='(')parens++;if(label===')')parens--;
  }
  return[...new Set(imports)];
}

export function nativeRootModuleContract(source,parent){
  const ast=parse(source,{ecmaVersion:'latest',sourceType:'module',ranges:true});
  const scopes=analyze(ast,{ecmaVersion:2024,sourceType:'module',optimistic:true,ignoreEval:true}),references=new WeakMap(),writes=new Map(),imports=new Map();
  for(const scope of scopes.scopes){for(const variable of scope.variables)for(const id of variable.identifiers)references.set(id,variable);for(const reference of scope.references)references.set(reference.identifier,reference.resolved);}
  const binding=node=>node?.type==='Identifier'?references.get(node):undefined;
  for(const node of ast.body)if(node.type==='ImportDeclaration')for(const specifier of node.specifiers)imports.set(binding(specifier.local),urlFor(node.source.value,parent));
  const all=[...nodes(ast)];
  for(const node of all){const left=node.type==='AssignmentExpression'&&node.operator==='='?node.left:node.type==='VariableDeclarator'?node.id:null,right=node.type==='AssignmentExpression'?node.right:node.init,variable=binding(left);if(variable&&right){const values=writes.get(variable)??[];values.push(right);writes.set(variable,values);}}
  const global=(node,name,seen=new Set())=>{
    if(node?.type!=='Identifier')return false;const variable=binding(node);
    if(!variable)return node.name===name;
    if(seen.has(variable))return false;seen.add(variable);const values=writes.get(variable);
    return!!values?.length&&values.every(value=>global(value,name,new Set(seen)));
  };
  const globalRoot=(node,key)=>node?.type==='MemberExpression'&&property(node)===key&&global(node.object,'window');
  const assigned=(node,predicate)=>{const variable=binding(node),values=variable&&writes.get(variable);return!!values?.length&&values.every(predicate);};
  const fromShared=node=>{const call=last(node);return call?.type==='CallExpression'&&!call.arguments.length&&role(imports.get(binding(last(call.callee))),'shared');};
  const roots=[];
  for(const node of all){
    if(node.type!=='LogicalExpression'||node.operator!=='??'||node.right.type!=='AssignmentExpression'||node.right.operator!=='=')continue;
    const key=property(node.left),assignment=node.right,call=last(assignment.right),callee=last(call?.callee);
    if(typeof key!=='string'||!globalRoot(node.left,key)||!globalRoot(assignment.left,key)||call?.type!=='CallExpression'||call.arguments.length!==1||callee?.type!=='MemberExpression'||property(callee)!=='createRoot'||!assigned(callee.object,fromShared))continue;
    const rootIds=new Set();
    if(!assigned(call.arguments[0],value=>{const get=last(value);if(get?.type!=='CallExpression'||get.arguments.length!==1||get.callee.type!=='MemberExpression'||property(get.callee)!=='getElementById'||!global(get.callee.object,'document')||typeof text(get.arguments[0])!=='string')return false;rootIds.add(text(get.arguments[0]));return true;})||rootIds.size!==1)continue;
    const render=all.some(value=>{const member=last(value.callee);return value.type==='CallExpression'&&value.arguments.length===1&&member?.type==='MemberExpression'&&property(member)==='render'&&assigned(member.object,value=>globalRoot(value,key));});
    if(render)roots.push({key,rootId:[...rootIds][0]});
  }
  if(roots.length!==1)throw fail('desktop_asset_drift',`A unique Native root creation and render contract is required (found ${roots.length})`);
  return roots[0];
}

function captureOwner(){
  desktopDocument();const doc=document,href=location.href;
  const root=doc.getElementById('root'),key=root&&Object.keys(root).find(key=>key.startsWith('__reactContainer$')),container=key&&root[key];
  if(!root||!container)throw fail('ui_host_pending','Waiting for the mounted Native React root');
  const entries=[...doc.scripts].filter(script=>script.type==='module'&&/^app:\/\/-\/assets\/index-[A-Za-z0-9_-]+\.js$/.test(script.src));
  if(entries.length!==1)throw fail('desktop_asset_drift','A unique current Native entry module is required');
  const entry=entries[0],entryUrl=entry.src;
  const internal=container?.stateNode??(container?.current?container:null);
  if(!internal?.current||internal.containerInfo!==root)throw fail('desktop_asset_drift','The current Native React root is unavailable');
  let publicRoot,rootKey;
  const check=()=>{
    if(document!==doc||location.href!==href||doc.getElementById('root')!==root||root[key]!==container||container?.stateNode!==internal&&container!==internal||internal.containerInfo!==root||internal.current?.stateNode!==internal||entry.src!==entryUrl||entry.type!=='module'||![...doc.scripts].includes(entry))throw fail('desktop_asset_owner_replaced','Native entry or React root was replaced');
    const currentEntries=[...doc.scripts].filter(script=>script.type==='module'&&/^app:\/\/-\/assets\/index-[A-Za-z0-9_-]+\.js$/.test(script.src));
    if(currentEntries.length!==1||currentEntries[0]!==entry)throw fail('desktop_asset_owner_replaced','Native entry ownership changed');
    if(rootKey){const current=Object.getOwnPropertyDescriptor(globalThis.window??globalThis,rootKey)?.value;if(current!==publicRoot||Object.getOwnPropertyDescriptor(current??{},'_internalRoot')?.value!==internal)throw fail('desktop_asset_owner_replaced','Native public root was replaced');}
  };
  check();
  return{doc,entryUrl,check,bind(contract){check();const value=Object.getOwnPropertyDescriptor(globalThis.window??globalThis,contract.key)?.value;
    if(contract.rootId!==root.id||!value||Object.getOwnPropertyDescriptor(value,'_internalRoot')?.value!==internal)throw fail('desktop_asset_drift','Native root module does not own the mounted React root');
    publicRoot=value;rootKey=contract.key;check();
  }};
}

export async function resolveLoadedAsset(name,{read,signal}={}){
  signal?.throwIfAborted();
  try{const url=loadedAsset(name);const previous=completed.get(document);if(previous)try{previous.check();}catch(error){if(error.code!=='desktop_asset_owner_replaced')throw error;completed.delete(document);}signal?.throwIfAborted();return url;}catch(error){if(error.code!=='ui_host_pending')throw error;}
  const owner=captureOwner(),previous=completed.get(owner.doc);
  if(previous){try{previous.check();owner.check();signal?.throwIfAborted();return select(previous.urls,name);}catch(error){completed.delete(owner.doc);if(error.code!=='desktop_asset_owner_replaced')throw error;}}
  const readSource=read??(async url=>{const response=await fetch(url,{credentials:'omit',signal});owner.check();signal?.throwIfAborted();if(!response.ok||response.url!==url)throw fail('ui_asset_unavailable','Unable to read the current Native module graph');return response.text();});
  const sources=new Map();
  const source=async url=>{signal?.throwIfAborted();owner.check();if(!sources.has(url))sources.set(url,Promise.resolve().then(()=>{owner.check();signal?.throwIfAborted();return readSource(url);}));const value=await sources.get(url);owner.check();signal?.throwIfAborted();if(typeof value!=='string')throw fail('desktop_asset_drift','Native module source is unavailable');return value;};
  const entry=parse(await source(owner.entryUrl),{ecmaVersion:'latest',sourceType:'module'}),mains=new Set();
  for(const node of nodes(entry))if(node.type==='ImportExpression'){const url=urlFor(text(node.source),owner.entryUrl);if(role(url,'main'))mains.add(url);}
  if(mains.size!==1)throw fail('desktop_asset_drift',`A unique Native root module import is required (found ${mains.size})`);
  const main=[...mains][0],mainSource=await source(main);owner.bind(nativeRootModuleContract(mainSource,main));
  const pending=[main],seen=new Set(),urls=new Set();
  while(pending.length){const url=pending.pop();if(seen.has(url))continue;seen.add(url);
    if(role(url,'initial')||role(url,'shared')){urls.add(url);continue;}
    for(const dependency of staticModuleImports(await source(url),url))if(!seen.has(dependency))pending.push(dependency);
  }
  owner.check();signal?.throwIfAborted();const result=select(urls,name);completed.set(owner.doc,{check:owner.check,urls});return result;
}
function select(urls,name){const found=[...urls].filter(url=>role(url,name));if(found.length!==1)throw fail('desktop_asset_drift',`A unique Native static ${name} module is required (found ${found.length})`);return found[0];}

// Capture this invocation's proof, not whichever proof a later caller caches.
// Consumers can revalidate synchronously after imports and during Native reads.
export function captureResolvedAssets(urls,{signal}={}){
  const doc=document,href=location.href,root=doc.getElementById?.('root'),key=root&&Object.keys(root).find(key=>key.startsWith('__reactContainer$')),container=key&&root[key],internal=container?.stateNode??(container?.current?container:null),graph=completed.get(doc);
  const ownsCurrent=!!internal&&internal.current?.stateNode===internal,containerInfo=internal?.containerInfo;
  const entries=Array.from(doc.scripts??[]).filter(script=>script.type==='module'&&/^app:\/\/-\/assets\/index-[A-Za-z0-9_-]+\.js$/.test(script.src)).map(script=>[script,script.src]);
  const check=()=>{
    signal?.throwIfAborted();
    if(document!==doc||location.href!==href||doc.getElementById?.('root')!==root||root&&root[key]!==container||internal&&(container?.stateNode!==internal&&container!==internal||internal.containerInfo!==containerInfo||ownsCurrent&&internal.current?.stateNode!==internal))throw fail('desktop_asset_owner_replaced','Native asset document or root was replaced');
    const current=Array.from(doc.scripts??[]).filter(script=>script.type==='module'&&/^app:\/\/-\/assets\/index-[A-Za-z0-9_-]+\.js$/.test(script.src));
    if(current.length!==entries.length||entries.some(([script,url],index)=>current[index]!==script||script.src!==url))throw fail('desktop_asset_owner_replaced','Native entry ownership changed');
    graph?.check();
    for(const [name,expected]of Object.entries(urls)){
      let observed;
      try{observed=loadedAsset(name);}catch(error){if(error.code!=='ui_host_pending'||!graph)throw error;observed=select(graph.urls,name);}
      if(observed!==expected)throw fail('desktop_asset_owner_replaced','Native role module was replaced');
    }
    signal?.throwIfAborted();
  };
  check();return check;
}
