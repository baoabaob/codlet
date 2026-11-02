import assert from 'node:assert/strict';
import test from 'node:test';
import {uiFixture, deferred, tick} from './support/ui-fixture.mjs';

test('navigation registration acquires UI only on entry and retires each view on departure',async t=>{
  const f=uiFixture();t.after(()=>f.dispose());const baseline={observers:f.observers.size,cleanups:f.cleanups.size};
  const create=f.context.ui.create;let created=0;const owners=[];
  f.context.ui.create=()=>{created++;const ui=create();owners.push(ui);return ui;};
  const page=await f.context.ui.page({label:'Lazy page',render:({ui})=>ui.React.createElement(ui.components.Button,{color:'primary'},'Owned control')});
  assert.equal(created,0);assert.equal(f.mediaListeners.size,0);assert.equal(f.document.querySelector('[data-codlet-official-styles]'),null);
  for(let i=0;i<3;i++){
    await f.open();assert.equal(created,i+1);assert.ok(f.control('Owned control'));assert.equal(owners.at(-1).signal.aborted,false);
    await f.leave();assert.equal(owners.at(-1).signal.aborted,true);assert.equal(f.mediaListeners.size,0);
    assert.equal(f.document.querySelector('[data-codlet-official-ui]'),null);assert.equal(f.document.querySelector('[data-codlet-official-styles]'),null);
  }
  page.dispose();assert.equal(f.observers.size,baseline.observers);assert.equal(f.cleanups.size,baseline.cleanups);
});

test('page badges remain available outside the view and the download glyph reuses Native SVG data',async t=>{
  const f=uiFixture();t.after(()=>f.dispose());
  const page=await f.context.ui.page({label:'Updates',render:({ui})=>ui.React.createElement(ui.icons.Download,{'data-native-download':true})});
  const lease=f.document.querySelector('[data-codlet-page-lease]');page.setBadge('Codlet 2 is available');assert.equal(lease.dataset.codletPageBadge,'Codlet 2 is available');
  lease.dataset.codletNativeDownload=JSON.stringify({viewBox:'0 0 20 20',paths:['M2 3H4V8Z']});
  await f.open();const icon=f.document.querySelector('[data-native-download]');assert.equal(icon.getAttribute('viewBox'),'0 0 20 20');assert.equal(icon.querySelector('path').getAttribute('d'),'M2 3H4V8Z');
  await f.leave();assert.equal(lease.dataset.codletPageBadge,'Codlet 2 is available');page.setBadge(null);assert.equal(lease.hasAttribute('data-codlet-page-badge'),false);
  page.dispose();assert.throws(()=>page.setBadge('retired'),/retired/);
});

test('declined auxiliary page does not initialize the SDK or retain a lease',async t=>{
  const f=uiFixture();t.after(()=>f.dispose());const baseline=f.cleanups.size;
  f.context.ui.create=()=>{throw Error('auxiliary window must not initialize UI');};
  f.overrides.set('register',args=>({api:1,token:args.token,path:null,available:false}));
  const page=await f.context.ui.page({label:'Auxiliary',render:()=>null});
  assert.equal(page.path,null);assert.equal(f.cleanups.size,baseline);assert.equal(f.document.querySelector('[data-codlet-page-lease]'),null);
});

test('retirement while registration is pending releases the lease before its reply',async t=>{
  const f=uiFixture();t.after(()=>f.dispose());const reply=deferred();let token;
  f.overrides.set('register',args=>{token=args.token;return reply.promise;});
  f.context.ui.create=()=>{throw Error('late registration must never initialize UI');};
  const pending=f.context.ui.page({label:'Pending',render:()=>null});
  const rejection=assert.rejects(pending,/retired/);
  for(const cleanup of [...f.cleanups])cleanup();
  assert.equal(f.document.querySelector('[data-codlet-page-lease]'),null);
  reply.resolve({api:1,token,path:'/pending'});await rejection;await tick();
  assert.equal(f.document.querySelector('[data-codlet-official-styles]'),null);
});

test('an accepted pending page waits for its own registration result without repeating the RPC',async t=>{
  const f=uiFixture();t.after(()=>f.dispose());let token,settled=false;
  f.overrides.set('register',args=>{token=args.token;return {api:1,token,path:'/pending',pending:true};});
  const pending=f.context.ui.page({label:'Pending',render:()=>null}).then(page=>{settled=true;return page;});
  await tick();assert.equal(settled,false);assert.equal(f.calls.filter(call=>call.method==='register').length,1);
  const lease=f.document.querySelector('[data-codlet-page-lease]');
  lease.dataset.codletPageRegistration=JSON.stringify({api:1,token,status:'ready',path:'/pending'});
  const page=await pending;assert.equal(page.path,'/pending');assert.equal(f.calls.filter(call=>call.method==='register').length,1);
  page.dispose();assert.equal(f.document.querySelector('[data-codlet-page-lease]'),null);assert.deepEqual(f.errors,[]);
});

test('deferred registration reports the original failure to its consumer even when its lease is removed',async t=>{
  const f=uiFixture();t.after(()=>f.dispose());const baseline=f.cleanups.size;let token;
  f.overrides.set('register',args=>{token=args.token;return {api:1,token,path:'/pending',pending:true};});
  const pending=f.context.ui.page({label:'Unavailable toolbar',toolbar:true,render:()=>null});
  const rejected=assert.rejects(pending,error=>error.code==='ui_build_drift'&&error.message==='Native toolbar changed');
  await tick();const lease=f.document.querySelector('[data-codlet-page-lease]');
  lease.dataset.codletPageRegistration=JSON.stringify({api:1,token,status:'failed',error:{code:'ui_build_drift',message:'Native toolbar changed'}});lease.remove();
  await rejected;assert.equal(f.cleanups.size,baseline);assert.equal(f.document.querySelector('[data-codlet-page-lease]'),null);
  assert.equal(f.errors.length,1);assert.equal(f.errors[0].code,'ui_page_registration_failed');assert.equal(f.errors[0].message,'Native toolbar changed');
});

test('pending auxiliary and retired page owners settle without acquiring UI or retaining observers',async t=>{
  for(const retire of [false,true]){
    const f=uiFixture();t.after(()=>f.dispose());const priorCleanups=new Set(f.cleanups),baseline={observers:f.observers.size,cleanups:f.cleanups.size};let token;
    f.context.ui.create=()=>assert.fail('pending or auxiliary page acquired UI');
    f.overrides.set('register',args=>{token=args.token;return {api:1,token,path:'/pending',pending:true};});
    const pending=f.context.ui.page({label:'Pending',render:()=>null});
    const result=retire?assert.rejects(pending,/retired/):pending;
    await tick();const lease=f.document.querySelector('[data-codlet-page-lease]');
    if(retire){for(const cleanup of [...f.cleanups])if(!priorCleanups.has(cleanup))cleanup();}
    else{lease.dataset.codletPageRegistration=JSON.stringify({api:1,token,status:'unavailable',path:null,available:false});lease.remove();}
    const page=await result;if(!retire)assert.equal(page.path,null);
    assert.equal(f.observers.size,baseline.observers);assert.equal(f.cleanups.size,baseline.cleanups);assert.deepEqual(f.errors,[]);
  }
});

test('a ready receipt cannot revive a removed or replaced generation lease',async t=>{
  for(const pending of [false,true])for(const replaceOwner of [false,true]){
    const f=uiFixture();t.after(()=>f.dispose());
    f.overrides.set('register',args=>{
      const lease=f.document.querySelector('[data-codlet-page-lease]'),reply={api:1,token:args.token,path:'/ready'};
      if(pending)lease.dataset.codletPageRegistration=JSON.stringify({...reply,status:'ready'});
      if(replaceOwner)lease.dataset.codletGeneration='2';else lease.remove();
      return {...reply,...(pending?{pending:true}:{})};
    });
    await assert.rejects(f.context.ui.page({label:'Stale ready',render:()=>null}),error=>error.code===(replaceOwner?'invalid_owner':'ui_retired'));
    assert.equal(f.document.querySelector('[data-codlet-page-lease]'),null);assert.equal(f.errors.length,1);
  }
});

test('an explicit successful retry clears only the page-registration diagnostic for that live generation',async t=>{
  const f=uiFixture();t.after(()=>f.dispose());const failure=Object.assign(Error('Native toolbar changed'),{code:'ui_build_drift'});
  f.overrides.set('register',()=>{throw failure;});
  await assert.rejects(f.context.ui.page({label:'First attempt',render:()=>null}),error=>error===failure);
  assert.equal(f.errors.length,1);assert.equal(f.errors[0].code,'ui_page_registration_failed');
  f.overrides.set('register',args=>({api:1,token:args.token,path:'/ready'}));
  const page=await f.context.ui.page({label:'Retry',render:()=>null});
  assert.equal(f.errors.length,2);assert.equal(f.errors[1].code,'ui_page_registration_failed');assert.equal(f.errors[1].resolved,true);
  page.dispose();
});
