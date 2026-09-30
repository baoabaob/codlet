import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const source=readFileSync(new URL('../runtime/skill-bridge.js',import.meta.url),'utf8');
const settle=async()=>{for(let i=0;i<15;i++)await new Promise(r=>setTimeout(r,0));};
function fixture(t,{mounted=true,ambiguous=false,version='future-backend',origin='app://-'}={}){
  const calls=[],coreCalls=[];let registered=false,ticket=0;
  const connection=()=>{
    const client={requestPromises:new Map(),getAppServerVersion:()=>version,setAppServerVersion(){},async sendRequest(method,params){calls.push({method,params});return {};}};
    const manager={requestClient:client,getHostId:()=> 'local',getConversation(){}};
    const token={id:Symbol()},family={scope:token,read:()=>client},managerFamily={scope:token,read:()=>manager};
    const node={token,familyBindings:new Map([[family,new Map([['local',client]])],[managerFamily,new Map([['local',manager]])]])};
    return {client,manager,family,node};
  };
  const first=connection(),original=first.client.sendRequest;
  const chain=new Map([[first.node.token.id,first.node]]);
  if(ambiguous){const second=connection();chain.set(second.node.token.id,second.node);}
  const fiber={memoizedProps:{value:chain}},root={__reactContainer$test:fiber};
  let attached=mounted;
  const document={scripts:[{src:'app://-/assets/index-new-hash.js'}],readyState:'complete',getElementById:()=>attached?root:null};
  const context=vm.createContext({setTimeout,clearTimeout,Map,Set,Symbol,location:{origin,pathname:'/index.html'},document,
    electronBridge:{getSentryInitOptions:()=>({appVersion:'unlisted-frontend',buildNumber:'future'})}});
  const config={marker:'test.skill',binding:'skillBinding',root:'/runtime',skillPath:'/runtime/codlet/SKILL.md'};
  const state=()=>vm.runInContext('globalThis[Symbol.for("test.skill")]',context);
  context.skillBinding=text=>{const input=JSON.parse(text);coreCalls.push(input.action);let reply;
    if(input.action==='complete'){registered=input.ok;reply={ready:registered};}
    else if(input.action==='invalidate'){registered=false;reply={ready:false};}
    else reply=input.action==='ensure'&&registered?{ready:true}:{ticket:++ticket,roots:[...(input.roots??[]).filter(p=>p!==config.root),config.root]};
    queueMicrotask(()=>state()?.receive(input.id,reply));
  };
  vm.runInContext('('+source+')',context)(config);
  t.after(()=>state()?.dispose([]));
  return {...first,original,context,config,calls,coreCalls,document,state,root,chain,mount:()=>{attached=true;}};
}
test('unlisted frontend and backend reuse the mounted local connection and preserve skill roots',async t=>{
  const f=fixture(t),{client,calls,coreCalls,config}=f;await settle();
  assert.equal(f.state().status,'ready');assert.equal(calls[0].method,'skills/extraRoots/set');
  await client.sendRequest('skills/list',{cwds:['/project']});assert.equal(calls.filter(c=>c.method==='skills/extraRoots/set').length,1);
  await client.sendRequest('skills/extraRoots/set',{extraRoots:['/another-root']});assert.deepEqual([...calls.at(-1).params.extraRoots],['/another-root','/runtime']);
  await client.sendRequest('turn/start',{threadId:'one',input:[{type:'text',text:'/codlet 帮我创建一个插件：'}]});
  assert.equal(calls.at(-1).params.input.at(-1).type,'skill');assert.equal(calls.at(-1).params.input.at(-1).path,config.skillPath);
  await client.sendRequest('turn/start',{threadId:'two',input:[{type:'text',text:'regular message mentioning /codlet elsewhere'}]});assert.equal(calls.at(-1).params.input.length,1);
  client.setAppServerVersion('another-version');await settle();await client.sendRequest('skills/list',{});assert.ok(coreCalls.includes('invalidate'));
  await f.state().dispose(['/another-root']);assert.equal(client.sendRequest,f.original);assert.deepEqual([...calls.at(-1).params.extraRoots],['/another-root']);
});
test('cold documents wait for mounted services; disposal cancels the pending wait',async t=>{
  const f=fixture(t,{mounted:false});await settle();assert.equal(f.state().status,'starting');assert.equal(f.calls.length,0);
  f.mount();await new Promise(r=>setTimeout(r,130));await settle();assert.equal(f.state().status,'ready');
  const waiting=fixture(t,{mounted:false});await settle();const old=waiting.state();assert.equal(old.delays.size,1);
  await old.dispose([]);await settle();assert.equal(old.delays.size,0);assert.equal(waiting.state(),undefined);
});
test('ambiguous connections fail without patching either client',async t=>{
  const f=fixture(t,{ambiguous:true});await settle();assert.equal(f.state().status,'failed');assert.match(f.state().error,/ambiguous/);
  assert.equal(f.client.sendRequest,f.original);assert.equal(f.calls.length,0);assert.ok(f.coreCalls.includes('failed'));
});
test('unbound, remote and mismatched scope clients are never initialized',async t=>{
  for(const change of [f=>f.node.familyBindings.get(f.family).clear(),f=>{f.manager.getHostId=()=> 'remote';},f=>{f.family.scope={};}]){
    const f=fixture(t,{mounted:false});change(f);f.mount();await new Promise(r=>setTimeout(r,130));await settle();
    assert.equal(f.state().status,'starting');assert.equal(f.client.sendRequest,f.original);assert.equal(f.calls.length,0);
  }
});
test('non Desktop documents do not install a skill bridge',async t=>{
  const f=fixture(t,{origin:'https://example.com'});await settle();assert.equal(f.state(),undefined);assert.equal(f.calls.length,0);
});
