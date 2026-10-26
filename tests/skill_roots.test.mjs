import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {createRequire} from 'node:module';
const {createSkillRootFacts}=createRequire(import.meta.url)('../runtime/skill-roots.cjs');
function fixture(t,{fresh=true,facts=createSkillRootFacts()}={}) {
  const child=new EventEmitter();child.stdin={write(){return true;}};child.stdout=new EventEmitter();
  const owner={hostId:'local',isLocal:true,connection:{proc:child},disposed:false},record=facts.observe(child,{fresh,owner});
  const send=(id,method='skills/list',params={})=>child.stdin.write(JSON.stringify({id,method,params})+'\n');
  const reply=(id,success=true)=>child.stdout.emit('data',Buffer.from(JSON.stringify({id,...success?{result:{}}:{error:{code:-1}}})+'\n'));
  const clientId=record.id;
  send('fixture-anchor');facts.query({clientId,clientEpoch:0,anchors:[{id:'fixture-anchor',method:'skills/list'}]});reply('fixture-anchor');
  const query=(extra={})=>facts.query({clientId,clientEpoch:0,authorityId:record.id,...extra});
  t.after(()=>facts.close());return {child,owner,record,facts,send,reply,query};
}
test('a fresh unique verified local owner preserves its baseline even after fast Native replies',t=>{
  const f=fixture(t);assert.equal(f.facts.query({clientId:'new-client',clientEpoch:0,anchors:[]}).provenance,'fresh');
  f.send('one');const value=f.facts.query({clientId:'new-client',clientEpoch:0,anchors:[{id:'one',method:'skills/list'}],cursor:null});
  assert.equal(value.status,'observed');assert.equal(value.provenance,'fresh');assert.equal(value.rootCount,0);
  f.reply('one');assert.equal(f.facts.query({clientId:'other-client',clientEpoch:0,anchors:[{id:'one',method:'skills/list'}]}).provenance,'fresh');
  assert.equal(f.query().status,'observed');
  f.owner.connection.proc={};assert.equal(f.query().reason,'owner_not_current');
});
test('local owner proofs reject stale processes, remote owners and earlier client epochs',t=>{
  const facts=createSkillRootFacts(),a=fixture(t,{facts});
  a.send('reused');a.reply('reused');
  const one=facts.query({clientId:'renderer',clientEpoch:1,anchors:[{id:'reused',method:'skills/list'}]});assert.equal(one.authorityId,a.record.id);
  assert.equal(facts.query({clientId:'renderer',clientEpoch:0,authorityId:one.authorityId}).reason,'retired_client_epoch');
  const b=fixture(t,{facts});b.send('reused');assert.equal(facts.query({clientId:'renderer',clientEpoch:1,authorityId:one.authorityId}).reason,'ambiguous_owner');
  a.owner.connection.proc=b.child;
  assert.equal(facts.query({clientId:'renderer',clientEpoch:1,authorityId:one.authorityId}).reason,'owner_not_current');
  const next=facts.query({clientId:'renderer',clientEpoch:2,anchors:[{id:'reused',method:'skills/list'}]});assert.equal(next.authorityId,b.record.id);
  b.owner.hostId='remote';assert.equal(facts.query({clientId:'renderer',clientEpoch:2,authorityId:b.record.id}).reason,'owner_not_current');
  a.owner.disposed=true;assert.equal(facts.query({clientId:'unbound',clientEpoch:0,anchors:[]}).reason,'no_anchor');
});
test('late attachment stays unobserved until one non-overlapping full roots set has a terminal success',t=>{
  const f=fixture(t,{fresh:false});assert.equal(f.query().reason,'late_attachment');
  f.send(1,'skills/extraRoots/set',{extraRoots:['/existing','/中文😀']});assert.equal(f.query().reason,'root_write_pending');
  f.reply(1);assert.equal(f.query().provenance,'confirmed');assert.deepEqual(f.query().fragments.map(x=>x.text),['/existing','/中文😀']);
  f.send(2,'skills/extraRoots/set',{extraRoots:['/next']});f.reply(2,false);assert.equal(f.query().reason,'root_write_unknown');
  f.send(3,'skills/extraRoots/set',{extraRoots:['/final']});f.reply(3);assert.equal(f.query().fragments[0].text,'/final');
});
test('overlapping sets and ambiguous request IDs never guess the last roots by reply order',t=>{
  const facts=createSkillRootFacts(),a=fixture(t,{facts}),b=fixture(t,{facts});
  a.send('same');b.send('same');assert.equal(facts.query({clientId:'shared-client',clientEpoch:0,anchors:[{id:'same',method:'skills/list'}]}).reason,'ambiguous_owner');
  b.reply('same');b.owner.disposed=true;assert.equal(facts.query({clientId:'shared-client',clientEpoch:0,anchors:[{id:'same',method:'skills/list'}]}).authorityId,a.record.id);
  a.send(1,'skills/extraRoots/set',{extraRoots:['/one']});a.send(2,'skills/extraRoots/set',{extraRoots:['/two']});
  a.reply(2);a.reply(1);assert.equal(a.query().reason,'root_write_unknown');
  a.child.emit('exit',0);assert.equal(a.query().status,'retired');b.owner.disposed=false;assert.equal(b.query().status,'observed');
});
test('root pages preserve long Unicode paths and reject mixed revisions without a total roots quota',t=>{
  const f=fixture(t),roots=Array.from({length:1500},(_,index)=>`/root/${index}`);roots.push('/'+'中😀'.repeat(100000));
  f.send(1,'skills/extraRoots/set',{extraRoots:roots});f.reply(1);
  let page=f.query(),cursor=page.cursor,joined=[],pages=0;
  for(;;){pages++;assert(Buffer.byteLength(JSON.stringify(page))<=33*1024);for(const fragment of page.fragments)joined[fragment.index]=(joined[fragment.index]??'')+fragment.text;if(!page.cursor)break;page=f.query({cursor:page.cursor});}
  assert(pages>17);assert.deepEqual(joined,roots);
  f.send(2,'skills/extraRoots/set',{extraRoots:['/changed']});f.reply(2);
  assert.equal(f.query({cursor}).reason,'revision_changed');
});
test('large unrelated output does not hide following account updates and repeated owners do not accumulate',t=>{
  const f=fixture(t),updates=[];f.record.subscribe(frame=>{if(frame.method==='account/updated')updates.push(frame.params.authMode);});
  for(let i=0;i<100;i++)f.facts.observe(f.child,{owner:f.owner});assert.equal(f.record.owners.size,1);
  f.child.stdout.emit('data',Buffer.from('{"result":{"large":"'+'x'.repeat(200000)+'"}}\n{"method":"account/updated","params":{"authMode":"chatgpt"}}\n'));
  assert.deepEqual(updates,['chatgpt']);assert.equal(f.query().status,'observed');
});
test('passive stdout facts preserve delayed Native readers, pause/resume and original error semantics',async t=>{
  const facts=createSkillRootFacts(),child=new EventEmitter(),output=new PassThrough(),originalEmit=output.emit;
  child.stdin={write(){return true;}};child.stdout=output;
  const owner={hostId:'local',isLocal:true,disposed:false,connection:{proc:child}};
  const record=facts.observe(child,{fresh:true,owner});t.after(()=>{facts.close();output.destroy();});
  assert.equal(output.listenerCount('data'),0);assert.equal(output.listenerCount('error'),0);assert.equal(output.readableFlowing,null);
  const first=Buffer.from('{"id":"fast","result":{"text":"完整😀"}}\n');output.write(first);
  await new Promise(resolve=>setImmediate(resolve));assert.equal(output.readableLength,first.length);assert.equal(output.readableFlowing,null);
  const received=[];output.on('data',bytes=>received.push(bytes));await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(Buffer.concat(received),first);
  child.stdin.write('{"id":"set","method":"skills/extraRoots/set","params":{"extraRoots":["/新😀"]}}\n');
  output.pause();output.write('{"id":"set","result":{}}\n');assert.equal(facts.query({clientId:'client',clientEpoch:0,anchors:[]}).reason,'root_write_pending');
  output.resume();await new Promise(resolve=>setImmediate(resolve));const observed=facts.query({clientId:'client',clientEpoch:0,authorityId:record.id});assert.equal(observed.fragments[0].text,'/新😀');
  const error=Error('Native stream error');assert.throws(()=>output.emit('error',error),value=>value===error);
  let errors=0;output.on('error',value=>{assert.equal(value,error);errors++;});assert.equal(output.emit('error',error),true);assert.equal(errors,1);
  let authObserved=false;record.subscribe(frame=>{if(frame.method==='account/updated')authObserved=true;});
  output.on('data',()=>assert.equal(authObserved,true));output.write('{"method":"account/updated","params":{"authMode":"chatgpt"}}\n');
  await new Promise(resolve=>setImmediate(resolve));
  facts.close();assert.equal(output.emit,originalEmit);assert.equal(output.listenerCount('data'),2);assert.equal(output.listenerCount('error'),1);
  assert.equal(Object.hasOwn(output,'emit'),false);
});
test('observer patch failure and drift preserve Native calls and original property ownership',t=>{
  for(const blocked of [false,true]) {
    const facts=createSkillRootFacts(),child=new EventEmitter(),output=new PassThrough(),originalEmit=output.emit;
    const write=function(){return 'Native result';};child.stdin=Object.create({write});child.stdout=output;
    if(blocked)Object.preventExtensions(output);
    const owner={hostId:'local',isLocal:true,disposed:false,connection:{proc:child}};
    let record;assert.doesNotThrow(()=>{record=facts.observe(child,{fresh:true,owner});});
    t.after(()=>{facts.close();output.destroy();});assert.equal(child.stdin.write('Native bytes'),'Native result');
    if(!blocked){const before=output.emit;output.emit=function(...args){return before.apply(this,args);};}
    assert.equal(facts.query({clientId:'client',clientEpoch:0,anchors:[]}).reason,'observer_contract_changed');
    facts.close();assert.equal(Object.hasOwn(child.stdin,'write'),false);assert.equal(child.stdin.write,write);
    if(blocked){assert.equal(output.emit,originalEmit);assert.equal(Object.hasOwn(output,'emit'),false);}
  }
});
