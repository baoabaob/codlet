import assert from 'node:assert/strict';
import test from 'node:test';
import {createNativeWorking,loadNativeWorking,nativeWorkingState,WORKING_PROFILE,WORKING_PROFILES} from '../frontend/src/desktop/native-working.js';
import {createLoadedThreads} from '../frontend/src/desktop/loaded-threads.js';

test('Working uses Native loading, blocking input and publication rather than runtimeStatus or unread presentation',()=>{
  assert.equal(nativeWorkingState('loading',null,false),true);
  assert.equal(nativeWorkingState('idle',null,false),false);
  assert.equal(nativeWorkingState('error',null,false),false);
  assert.equal(nativeWorkingState('loading',{kind:'input',blocking:true},false),false);
  assert.equal(nativeWorkingState('loading',{kind:'approval',blocking:true},false),false);
  assert.equal(nativeWorkingState('loading',{kind:'input',blocking:false,source:'userInputAsync'},false),true);
  assert.equal(nativeWorkingState('idle',null,true),true);
  assert.equal(nativeWorkingState('loading',{kind:'input',blocking:true},true),true);
  for(const value of [undefined,'unrecognized'])assert.equal(nativeWorkingState(value,null,false),null);
  assert.equal(nativeWorkingState('loading',{kind:'unknown',blocking:false},false),null);
  assert.equal(nativeWorkingState('idle',null,undefined),null);
});

function fixture(profile=WORKING_PROFILE){
  const token={},node={token},families={response:{scope:token,read(){}},pending:{scope:token,read(){}},publishing:{scope:token,read(){}}};
  const initial=Object.fromEntries(Object.entries(families).map(([name,value])=>[profile[name],value])),extra=profile.publishingModule?{[profile.publishing]:families.publishing}:null,states=new Map(),watchers=new Map();let reads=0,checks=0;
  if(extra)delete initial[profile.publishing];
  const get=(family,args)=>{reads++;const state=states.get(args.conversationId);return state?.[Object.keys(families).find(name=>families[name]===family)];};
  const facade={scope:token,node,get,watch(fn){let id;const track=(family,args)=>{id=args.conversationId;return get(family,args);};fn({get:track});watchers.set(id,fn);return()=>watchers.delete(id);}};
  const connection={node,check(){checks++;}};
  const options={asset:role=>`app://-/assets/${profile[role]}`,load:async url=>url===`app://-/assets/${profile.publishingModule}`?extra:url.includes('app-initial')?initial:{},connect:()=>connection,scope:()=>facade};
  const notify=id=>watchers.get(id)?.({get});
  return{families,initial,extra,states,watchers,notify,options,stats:()=>({reads,checks})};
}

test('reviewed Native selectors and AppScope work without any mounted row or document',async()=>{
  const f=fixture();f.states.set('offscreen-cached',{response:'loading',pending:null,publishing:false});
  const driver=await loadNativeWorking(f.options);assert.equal(driver.read('offscreen-cached'),true);
  const changes=[],stop=driver.watch('offscreen-cached',value=>changes.push(value));assert.deepEqual(changes,[true]);
  f.states.get('offscreen-cached').pending={kind:'input',blocking:true};f.notify('offscreen-cached');assert.deepEqual(changes,[true,false]);
  f.states.get('offscreen-cached').pending={kind:'input',blocking:false};f.notify('offscreen-cached');assert.equal(changes.at(-1),true);
  stop();assert.equal(f.watchers.size,0);
  await assert.rejects(loadNativeWorking({...f.options,asset:()=> 'app://-/assets/unreviewed.js'}),/not reviewed/);
  await assert.rejects(loadNativeWorking({...f.options,scope:()=>({...f.options.scope(),watch:undefined})}),/unavailable/);
  f.initial[WORKING_PROFILE.response]={scope:{},read(){}};await assert.rejects(loadNativeWorking(f.options),/unavailable/);
});

test('current reviewed asset pair retains individual Native scope validation and unknown pairs never borrow its keys',async()=>{
 const profile=WORKING_PROFILES.find(value=>value.initial==='app-initial-102e45562729.js');assert.ok(profile);
 const f=fixture(profile);f.states.set('owned',{response:'loading',pending:{kind:'input',blocking:false},publishing:false});
 const driver=await loadNativeWorking(f.options);assert.equal(driver.read('owned'),true);f.states.get('owned').pending={kind:'approval',blocking:true};assert.equal(driver.read('owned'),false);
 await assert.rejects(loadNativeWorking({...f.options,asset:role=>`app://-/assets/${role==='initial'?profile.initial:WORKING_PROFILE.shared}`}),/not reviewed/);
 f.initial[profile.publishing]={scope:{},read(){}};await assert.rejects(loadNativeWorking(f.options),/unavailable/);
});

for(const profile of WORKING_PROFILES.slice(2))test(`Working state uses the reviewed selectors for ${profile.initial}`,async()=>{
  const f=fixture(profile);f.states.set('current',{response:'loading',pending:null,publishing:false});
  const driver=await loadNativeWorking(f.options);assert.equal(driver.read('current'),true);
  f.states.get('current').pending={kind:'approval',blocking:true};assert.equal(driver.read('current'),false);
  f.states.get('current').publishing=true;assert.equal(driver.read('current'),true);
  await assert.rejects(loadNativeWorking({...f.options,asset:role=>role==='shared'?'app://-/assets/unreviewed.js':f.options.asset(role)}),/not reviewed/);
});

test('a relocated publication selector must retain the same Native AppScope and namespace identity',async()=>{
  const profile=WORKING_PROFILES.find(value=>value.publishingModule),f=fixture(profile);assert.ok(f.extra);
  f.states.set('published',{response:'idle',pending:null,publishing:true});
  const driver=await loadNativeWorking(f.options);assert.equal(driver.read('published'),true);
  f.extra[profile.publishing]={scope:{},read(){}};
  assert.throws(()=>driver.read('published'),/profile changed/);
  await assert.rejects(loadNativeWorking(f.options),/unavailable/);
});

test('cached summaries and events carry nullable working independently from their legacy runtimeStatus',async()=>{
  const f=fixture(),threads=new Map([['parent',{id:'parent',resumeState:'resumed',threadRuntimeStatus:{type:'idle'},requests:[]}],['child',{id:'child',resumeState:'resumed',threadRuntimeStatus:{type:'active',activeFlags:['waitingOnUserInput']},requests:[{completed:false}]}]]),events=[];
  f.states.set('parent',{response:'idle',pending:null,publishing:false});f.states.set('child',{response:'loading',pending:{kind:'input',blocking:true},publishing:false});
  const native=createNativeWorking({load:()=>loadNativeWorking(f.options),changed:id=>summaries.refresh(id)}),summaries=createLoadedThreads({getCachedConversations:()=>[...threads.values()],getConversation:id=>threads.get(id)},event=>events.push(event),'working-test',native);
  await native.prepare();let page=summaries.read({limit:100});assert.deepEqual(page.threads.map(value=>[value.id,value.runtimeStatus,value.working]),[['parent','idle',false],['child','attention',false]]);
  // Native f9n's parent loading output changes when its owned child starts.
  f.states.get('child').pending=null;f.states.get('parent').response='loading';f.notify('child');f.notify('parent');
  assert.equal(events.find(event=>event.threadId==='parent').thread.working,true);assert.equal(events.find(event=>event.threadId==='parent').thread.runtimeStatus,'idle');
  assert.equal(events.find(event=>event.threadId==='child').thread.working,true);assert.equal(events.find(event=>event.threadId==='child').thread.runtimeStatus,'attention');
  const count=events.length;f.notify('parent');f.notify('child');assert.equal(events.length,count);
  f.states.get('parent').response='idle';f.notify('parent');assert.equal(events.at(-1).thread.working,false);
  f.states.get('parent').publishing=true;f.notify('parent');assert.equal(events.at(-1).thread.working,true);
  f.states.get('parent').publishing=undefined;f.notify('parent');assert.equal(events.at(-1).thread.working,null);
  assert.equal(summaries.read({threadId:'parent'}).threads[0].working,null);
  threads.delete('child');summaries.refresh('child');assert.equal(f.watchers.has('child'),false);assert.equal(events.at(-1).thread,null);
  summaries.dispose();assert.equal(f.watchers.size,0);
});

test('Working preparation coalesces, unsupported/unready stays null, and retirement prevents late subscriptions',async()=>{
  let release,loads=0,watches=0;
  const provider=createNativeWorking({load:()=>{loads++;return new Promise(resolve=>{release=resolve;});}});
  const a=provider.prepare(),b=provider.prepare();await new Promise(resolve=>setImmediate(resolve));assert.equal(loads,1);provider.dispose();
  release({read:()=>true,watch(){watches++;return()=>{};}});await Promise.all([a,b]);assert.equal(provider.read('retired'),null);assert.equal(watches,0);
  const unsupported=createNativeWorking({load:async()=>{throw Error('Unreviewed');}});await unsupported.prepare();assert.equal(unsupported.read('unknown'),null);unsupported.dispose();
  const ready=createNativeWorking({load:async()=>({read:()=>false,watch(){watches++;return()=>{};}})});await ready.prepare();assert.equal(ready.read('not-loaded',{resumeState:'needs_resume',threadRuntimeStatus:{type:'notLoaded'}}),false);assert.equal(watches,1);ready.dispose();
});

test('unready selector output stays subscribed and recovers without opening a row or a new enumeration',async()=>{
  let listener,pending=true,releases=0;const events=[];
  const provider=createNativeWorking({load:async()=>({read(){if(pending)throw Error('Native dependency pending');return true;},watch(_id,fn){listener=fn;return()=>releases++;}}),changed:id=>events.push(id)});
  await provider.prepare();assert.equal(provider.read('cold-cached',{resumeState:'needs_resume',threadRuntimeStatus:{type:'notLoaded'}}),null);
  pending=false;listener(true);assert.deepEqual(events,['cold-cached']);assert.equal(provider.read('cold-cached'),true);provider.remove('cold-cached');assert.equal(releases,1);
});

test('folding, virtualization, unread values and large cached collections do not create Working gaps or count limits',async()=>{
  const f=fixture(),threads=new Map(Array.from({length:4205},(_,index)=>{const id='working-cached-'+index;f.states.set(id,{response:index%2?'loading':'idle',pending:null,publishing:false,unreadCount:50,folded:true,virtualized:true});return[id,{id,resumeState:'needs_resume',threadRuntimeStatus:{type:'notLoaded'},requests:[]}];}));
  const provider=createNativeWorking({load:()=>loadNativeWorking(f.options)});await provider.prepare();
  const summaries=createLoadedThreads({getCachedConversations:()=>[...threads.values()],getConversation:id=>threads.get(id)},()=>{},'all-working',provider);
  let cursor,total=0;do{const page=summaries.read({limit:100,...(cursor?{cursor}:{})});for(const entry of page.threads){const index=Number(entry.id.split('-').at(-1));assert.equal(entry.working,!!(index%2));}total+=page.threads.length;cursor=page.cursor;}while(cursor);
  assert.equal(total,4205);assert.equal(f.watchers.size,4205);summaries.dispose();assert.equal(f.watchers.size,0);
});

test('invalid or foreign cached identities are rejected before Native state reads or subscriptions',()=>{
  let reads=0;for(const thread of [{id:'',resumeState:'resumed'},{id:'foreign',hostId:'remote',resumeState:'resumed'}]){
    const summaries=createLoadedThreads({getCachedConversations:()=>[thread],getConversation:()=>thread},()=>{},'invalid-working',{read(){reads++;return true;}});
    assert.throws(()=>summaries.read({limit:100}),{code:'desktop_summary_drift'});summaries.dispose();
  }assert.equal(reads,0);
});
