import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import vm from 'node:vm';
import {buildPlugin} from '../frontend/build-plugin.mjs';

// Compile maintained source in memory: these tests never depend on a stale
// checked-in adapter bundle and never write distribution output.
const source=(await buildPlugin(fileURLToPath(new URL('../frontend',import.meta.url)),'src/desktop/entry.js')).code;
const plain=value=>JSON.parse(JSON.stringify(value)),tick=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(){
  const scope=vm.createContext({module:{exports:{}},crypto:{randomUUID},document:{},setTimeout,clearTimeout,AbortController,URL});
  const create=vm.runInContext(source+'\ncreateAdapter',scope),build=vm.runInContext('BUILDS[1]',scope);
  const thread={id:'thread-a',resumeState:'resumed',turns:[],requests:[],latestThreadSettings:{approvalPolicy:'never',sandboxPolicy:{type:'dangerFullAccess'}}};
  const sent=[],writes=[],errors=[],client={requestPromises:new Map(),addRequestLifecycleListener(){return()=>{};},onError(id,error){errors.push({id,error});this.requestPromises.delete(id);}};
  const postbox={postMessage(message){sent.push(message);}},original=postbox.postMessage;
  const navigator={location:{pathname:'/local/thread-a'},push(){},replace(){},go(){},listen(){}};
  let mode='full-access',sequence=0;
  const manager={getConversation:()=>thread,getStreamRole:()=>({role:'owner'}),addNotificationCallback(){return()=>{};},addConversationStateCallback(){return()=>{};},waitForPendingThreadSettingsUpdate:async()=>{},
    async updateThreadPermissions(_id,settings){writes.push(settings);thread.latestThreadSettings=settings;mode=settings.approvalPolicy==='never'?'full-access':'auto';},
    async sendRequest(method,params){const id=`sdk-${++sequence}`;client.requestPromises.set(id,{});postbox.postMessage({type:'mcp-request',hostId:'local',request:{id,method,params}});client.requestPromises.delete(id);return{data:[],nextCursor:null};}};
  const driver={sendPathVerified:true,canonical:()=>thread.latestThreadSettings,
    read:()=>({phase:'ready',selection:{kind:'agent-mode',mode},source:'thread',options:['auto','full-access'].map(mode=>({selection:{kind:'agent-mode',mode},label:mode,enabled:true})),diagnostic:null}),
    convert:(_id,choice)=>choice.mode==='full-access'?{approvalPolicy:'never',sandboxPolicy:{type:'dangerFullAccess'}}:{approvalPolicy:'on-request',sandboxPolicy:{type:'workspaceWrite'}}};
  scope.fixtureDriver=driver;vm.runInContext('loadNativePermissions = async () => fixtureDriver',scope);
  const connection={manager,client,postbox,build,locateNavigator:()=>navigator,check(){}};
  const start=generation=>{
    const endpoints=new Map(),ctx={world:'main',pluginId:'codex.desktop.adapter',generation,onDeactivate(){return()=>{};},reportDiagnostic(){},rpc:{provide(cap,method,fn){endpoints.set(`${cap.name}:${method}`,fn);},unavailable(){}}};
    const adapter=create(connection,ctx);return{...adapter,endpoints};
  };
  const register=(adapter,generation)=>{const caller={pluginId:'consumer',generation},ctx={...caller,world:'main',onDeactivate(fn){return()=>{};}};
    const ticket=adapter.endpoints.get('codex.backend.write:getApi')({}, {caller});scope[Symbol.for('codlet.codex.desktop.v1')].registerPermissions(ctx,ticket.ticket);return caller;};
  const native=id=>{client.requestPromises.set(id,{});return{type:'mcp-request',hostId:'local',request:{id,method:'turn/start',params:{threadId:'thread-a',approvalPolicy:'never',sandboxPolicy:{type:'dangerFullAccess'},input:[{type:'text',text:'synthetic'}]}}};};
  return{scope,start,register,native,thread,sent,writes,errors,postbox,original,client};
}
test('Desktop source reload keeps canonical permission guards with no preSubmit hook, no Native settings replay, and one current dispatch',async()=>{
  const f=fixture(),old=f.start(1),caller=f.register(old,1);
  const before=await old.api.read('permissions.get',{threadId:'thread-a'});
  await old.api.write('permissions.update',{threadId:'thread-a',selection:{kind:'agent-mode',mode:'auto'},expectedRevision:before.revision},null,caller);
  const gate=f.scope[Symbol.for('codlet.core.native-ingress.v1')];gate.pause('core-update');
  const snapshot=plain(old.saveState());assert.deepEqual(snapshot,{schema:1,value:{permissions:{guards:[{threadId:'thread-a',pluginId:'consumer',generation:1}]}}});
  f.postbox.postMessage(f.native('queued'));assert.equal(f.sent.length,0);old.dispose();
  assert.notEqual(f.postbox.postMessage,f.original);f.thread.latestThreadSettings={approvalPolicy:'on-request',sandboxPolicy:{type:'readOnly'}};
  const fresh=f.start(2);await fresh.restoreState(snapshot);f.register(fresh,2);
  assert.equal(f.writes.length,1);assert.equal(gate.resume('core-update',{outcome:'applied'}).ok,true);await tick();
  assert.equal(f.sent.length,1);assert.equal(f.sent[0].request.id,'queued');assert.equal(f.sent[0].request.params.sandboxPolicy.type,'readOnly');assert.equal(f.errors.length,0);
  assert.equal(fresh.saveState().value.permissions.guards[0].generation,2);fresh.dispose();assert.equal(f.postbox.postMessage,f.original);
});
test('Core manager facade dispatches an admitted SDK request through held ingress without making the ordinary Native queue writable',async()=>{
  const f=fixture(),adapter=f.start(1),gate=f.scope[Symbol.for('codlet.core.native-ingress.v1')];gate.pause('accepted');
  f.postbox.postMessage(f.native('ordinary'));
  assert.deepEqual(plain(await adapter.api.read('turns.list',{threadId:'thread-a'})),{turns:[],cursor:null});
  assert.deepEqual(f.sent.map(value=>value.request.id),['sdk-1']);
  gate.resume('accepted',{outcome:'rolledBack'});assert.deepEqual(f.sent.map(value=>value.request.id),['sdk-1','ordinary']);adapter.dispose();
});
