import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import Module from 'node:module';
const require=createRequire(import.meta.url),{observeModules}=require('../runtime/client-bridge-bundle.cjs');
const {installDesktopPlaintext}=require('../codex/host/electron-plaintext.cjs');

async function fixture(t){
  const directory=await mkdtemp(path.join(tmpdir(),'codlet-webpack-')),key=Symbol.for('codlet.test.webpack.'+Math.random()),registry=observeModules(directory,key);
  t.after(async()=>{registry.close();assert.equal(path.dirname(path.resolve(directory)),path.resolve(tmpdir()));await rm(directory,{recursive:true});});
  const compile=(name,code)=>{const filename=path.join(directory,name),module=new Module(filename);module.filename=filename;module.paths=Module._nodeModulePaths(directory);module._compile(code,filename);return module.exports;};
  const load=id=>{if(Object.hasOwn(load.c,id))return load.c[id].exports;const module=load.c[id]={exports:{}};load.m[id].call(module.exports,module,module.exports,load);return module.exports;};
  load.c=Object.create(null);load.m=Object.create(null);
  const chunk=(name,code)=>{const exports=compile(name,'exports.ids=[1];exports.modules={'+code+'};');Object.assign(load.m,exports.modules);return exports;};
  const scopes=()=>registry.list().filter(record=>record.filename.includes('#webpack:'));
  return{registry,compile,load,chunk,scopes};
}

test('a lazy Webpack factory publishes its own lexical bindings only after Native executes it once',async t=>{
  const f=await fixture(t),chunk=f.chunk('early-bootstrap-339-example.js','12(module,exports,require){"use strict";exports.before=this;exports.args=arguments;class Native {constructor(){this.created=true;}value(){return "own";}}function nested(){class Native {foreign(){}}return Native;}exports.Native=Native;exports.nested=nested;exports.created=new Native();}');
  assert.equal(f.scopes().length,0);const callable=chunk.modules[12],value=f.load(12);
  assert.equal(f.load(12),value);assert.equal(chunk.modules[12],callable);assert.equal(value.before,value);assert.equal(value.args[0],f.load.c[12]);
  assert.equal(value.args[1],value);assert.equal(value.args[2],f.load);
  const [record]=f.scopes();assert.equal(record.exported,value);assert.equal(record.evaluate('Native'),value.Native);
  assert.deepEqual(record.classes.find(item=>item.binding==='Native').methods,['value']);
  assert.ok(f.registry.instances(value.Native).includes(value.created));assert.equal(record.evaluate('exports'),value);
});

test('factory return identity and terminal throw or early return are preserved',async t=>{
  const f=await fixture(t),failure=new Error('Native original failure');globalThis.codletWebpackFailure=failure;
  t.after(()=>delete globalThis.codletWebpackFailure);
  const chunk=f.chunk('early-bootstrap-491-example.js','1(module,exports,require){"use strict";class Native {value(){}}module.exports={Native};return module.exports;} ,2(module,exports,require){"use strict";throw globalThis.codletWebpackFailure;class Native {value(){}}},3(module,exports,require){"use strict";return exports;class Native {value(){}}}');
  const firstModule=f.load.c[1]={exports:{}},returned=chunk.modules[1].call(firstModule.exports,firstModule,firstModule.exports,f.load);
  assert.equal(returned,firstModule.exports);assert.equal(f.scopes()[0].exported,returned);
  assert.throws(()=>f.load(2),error=>error===failure);
  assert.throws(()=>f.scopes().find(record=>record.filename.includes('#webpack:2:')).evaluate('Native'),{code:'client_bridge_factory_failed'});
  f.load(3);assert.throws(()=>f.scopes().find(record=>record.filename.includes('#webpack:3:')).evaluate('Native'),{code:'client_bridge_factory_binding_unavailable'});
});

test('cached module ownership survives factory replacement and retires when its cache or exports is replaced',async t=>{
  const f=await fixture(t),chunk=f.chunk('early-bootstrap-824-example.js','7(module,exports,require){"use strict";class Native {value(){}}exports.Native=Native;}');
  const value=f.load(7),[record]=f.scopes(),retired=[];f.registry.subscribe(item=>{if(item.retired)retired.push(item);});
  f.load.m[7]=()=>{throw Error('cached owner still wins');};assert.equal(record.live(),true);assert.equal(f.load(7),value);
  f.load.c[7].exports={replaced:true};assert.equal(record.live(),false);assert.equal(f.scopes().length,0);assert.equal(retired.length,1);
  assert.throws(()=>record.evaluate('Native'),{code:'client_bridge_factory_retired'});
  f.load.m[7]=chunk.modules[7];delete f.load.c[7];const replacement=f.load(7),[next]=f.scopes();
  assert.notEqual(next.evaluate('Native'),value.Native);assert.equal(next.exported,replacement);
  delete f.load.c[7];assert.equal(f.scopes().length,0);assert.equal(retired.length,2);
});

test('separate runtimes retain separate same-spelled factory bindings and close restores factories',async t=>{
  const f=await fixture(t),chunk=f.chunk('early-bootstrap-runtime-example.js','9(module,exports,require){class Native {value(){}}exports.Native=Native;}'),wrapper=chunk.modules[9];
  const first=f.load(9),other=id=>{const module=other.c[id]={exports:{}};other.m[id].call(module.exports,module,module.exports,other);return module.exports;};
  other.c={};other.m={9:wrapper};const second=other(9),records=f.scopes();
  assert.equal(records.length,2);assert.notEqual(records[0].filename,records[1].filename);assert.notEqual(first.Native,second.Native);
  Object.defineProperty(f.load.m,'9',{value:wrapper,writable:true,enumerable:false,configurable:true});
  const replacement=()=> 'Native replacement';other.m[9]=replacement;
  f.registry.close();assert.notEqual(chunk.modules[9],wrapper);assert.equal(f.load.m[9],chunk.modules[9]);assert.equal(other.m[9],replacement);
  assert.deepEqual(Object.getOwnPropertyDescriptor(f.load.m,'9'),{value:chunk.modules[9],writable:true,enumerable:false,configurable:true});
  assert.equal(records.every(record=>record.live()===false),true);
  const owner={exports:{}};assert.doesNotThrow(()=>wrapper.call(owner.exports,owner,owner.exports,other));
});

test('unrelated objects, async factories and getter-backed owners are not invoked by observation',async t=>{
  const f=await fixture(t);let reads=0;
  const plain=f.compile('unrelated.js','module.exports={modules:{1(module,exports,require){class Native {value(){}}exports.Native=Native;}}};');
  assert.equal(f.scopes().length,0);assert.equal(plain.modules[1].name,'1');
  const chunk=f.chunk('early-bootstrap-opaque-example.js','4(module,exports,require){class Native {value(){}}exports.Native=Native;},async 5(module,exports,require){class Native {value(){}}return exports;}');
  const opaque=()=>{};Object.defineProperty(opaque,'c',{get(){reads++;return {};}});opaque.m={4:chunk.modules[4]};
  const owner={exports:{}};chunk.modules[4].call(owner.exports,owner,owner.exports,opaque);assert.equal(reads,0);assert.equal(f.scopes().length,0);
  const promise=chunk.modules[5](owner,owner.exports,opaque);assert.equal(await promise,owner.exports);assert.equal(f.scopes().length,0);
});

test('the Desktop source uses completed factory contracts and retires hooks with the actual cache owner',async t=>{
  const f=await fixture(t),hook=installDesktopPlaintext({app:{isReady:()=>false}},{source:{interceptHttp(input,{forward}){return forward(input);}},moduleRegistry:f.registry},{expectedHashes:{}});
  t.after(()=>hook.close());
  f.chunk('early-bootstrap-network-example.js','10(module,exports,require){class Network {assertAllowed(url){}fetch(url,options){this.assertAllowed(url);return electron.net.fetch(url,options);}request(options){this.assertAllowed(options.url);return electron.net.request(options);}}exports.Network=Network;}');
  f.chunk('early-bootstrap-fetch-example.js','11(module,exports,require){class Fetch {performDesktopFetch(url){this.options.applicationNetwork.assertAllowed(url);return this.options.applicationNetwork.fetch(url)||this.performProgressRequest(url);}performProgressRequest(options){return this.options.applicationNetwork.request(options);}}exports.Fetch=Fetch;}');
  assert.equal(hook.inspect().available,false);const network=f.load(10),fetch=f.load(11),original=network.Network.prototype.fetch;
  assert.equal(hook.inspect().available,true);assert.equal(hook.inspect().deferredBindings,0);
  delete f.load.c[10];assert.equal(hook.inspect().available,false);assert.notEqual(network.Network.prototype.fetch,original);
  f.load(10);assert.equal(hook.inspect().available,true);
  f.chunk('early-bootstrap-ambiguous-example.js','12(module,exports,require){class Network {assertAllowed(url){}fetch(url,options){this.assertAllowed(url);return electron.net.fetch(url,options);}request(options){this.assertAllowed(options.url);return electron.net.request(options);}}exports.Network=Network;}');
  f.load(12);assert.equal(hook.inspect().reason,'ambiguous_contract');
});

test('a current proof for the same constructor survives retirement of its earlier module scope',async t=>{
  const f=await fixture(t),hook=installDesktopPlaintext({app:{isReady:()=>false}},{source:{interceptHttp(){}},moduleRegistry:f.registry},{expectedHashes:{}});
  t.after(()=>hook.close());
  f.chunk('early-bootstrap-shared-proof.js','20(module,exports,require){class Network {assertAllowed(url){}fetch(url,options){this.assertAllowed(url);return electron.net.fetch(url,options);}request(options){this.assertAllowed(options.url);return electron.net.request(options);}}exports.Network=Network;},21(module,exports,require){class Fetch {performDesktopFetch(url){this.options.applicationNetwork.assertAllowed(url);return this.options.applicationNetwork.fetch(url)||this.performProgressRequest(url);}performProgressRequest(options){return this.options.applicationNetwork.request(options);}}exports.Fetch=Fetch;}');
  const {Network}=f.load(20);f.load(21);assert.equal(hook.inspect().available,true);const wrapped=Network.prototype.fetch;
  let nextLive=true;
  f.registry.register('shared-current-proof','hash',{},()=>Network,[{binding:'Network',methods:['assertAllowed','fetch','request']}],()=>nextLive);
  delete f.load.c[20];assert.equal(hook.inspect().available,true);assert.equal(Network.prototype.fetch,wrapped);
  nextLive=false;assert.equal(hook.inspect().available,false);assert.notEqual(Network.prototype.fetch,wrapped);
});

test('lexical identities retain lazy outer assignments and cannot be shadowed by nested classes or capture parameters',async t=>{
  const f=await fixture(t),native=f.compile('native-lazy.cjs','let Native;function initialize(){Native=class {value(){return "outer";}};}function nested(){class Native {foreign(){}}return Native;}if(true){class Native {blockShadow(){}}}class expression {value(){}}class __codletExpression {own(){}}module.exports={initialize,nested,expression,__codletExpression};');
  const common=f.registry.list().find(record=>record.name==='native-lazy.cjs');
  assert.deepEqual(common.classes.find(value=>value.binding==='Native').methods,['value']);assert.equal(common.evaluate('Native'),undefined);
  native.initialize();assert.equal(new (common.evaluate('Native'))().value(),'outer');assert.equal(common.evaluate('expression'),native.expression);
  assert.equal(common.evaluate('__codletExpression'),native.__codletExpression);
  f.chunk('early-bootstrap-capture-example.js','25(module,exports,require){class expression {own(){}}class __codletExpression {native(){}}exports.expression=expression;exports.other=__codletExpression;}');
  const value=f.load(25),[record]=f.scopes();assert.equal(record.evaluate('expression'),value.expression);assert.equal(record.evaluate('__codletExpression'),value.other);
});
