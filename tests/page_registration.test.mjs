import assert from 'node:assert/strict';
import test from 'node:test';
import {uiFixture, deferred, tick} from './support/ui-fixture.mjs';

test('navigation registration acquires UI only on entry and retires each view on departure',async t=>{
  const f=uiFixture();t.after(()=>f.dispose());const baseline={observers:f.observers.size,cleanups:f.cleanups.size};
  const create=f.context.ui.create;let created=0;const owners=[];
  f.context.ui.create=()=>{created++;const ui=create();owners.push(ui);return ui;};
  const page=await f.context.ui.page({label:'Lazy page',render:({ui})=>ui.React.createElement(ui.components.Button,{color:'primary'},'Owned control')});
  assert.deepEqual(JSON.parse(JSON.stringify(await page.ready)),{available:true,path:page.path});
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
  assert.deepEqual(JSON.parse(JSON.stringify(await page.ready)),{available:false,path:null});
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

test('accepted navigation returns before Native readiness and mounts only after its own receipt',async t=>{
  const f=uiFixture();t.after(()=>f.dispose());let token,settled=false,created=0;
  const create=f.context.ui.create;f.context.ui.create=()=>{created++;return create();};
  f.overrides.set('register',args=>{token=args.token;return {api:1,token,path:'/pending',pending:true};});
  const page=await f.context.ui.page({label:'Pending',render:()=>null});page.ready.then(()=>{settled=true;});
  assert.equal(page.path,'/pending');
  await tick();assert.equal(settled,false);assert.equal(f.calls.filter(call=>call.method==='register').length,1);
  assert.equal(f.errors.length,1);assert.equal(f.errors[0].code,'ui_page_registration_pending');assert.equal(f.errors[0].level,'info');
  const host=f.document.createElement('div');host.dataset.codletPageHost=token;f.document.body.append(host);await tick();assert.equal(created,0);
  const lease=f.document.querySelector('[data-codlet-page-lease]');
  lease.dataset.codletPageRegistration=JSON.stringify({api:1,token,status:'ready',path:'/pending'});
  assert.deepEqual(JSON.parse(JSON.stringify(await page.ready)),{available:true,path:'/pending'});await tick();
  assert.equal(created,1);assert.equal(f.calls.filter(call=>call.method==='register').length,1);
  assert.equal(f.errors.length,2);assert.equal(f.errors[1].code,'ui_page_registration_pending');assert.equal(f.errors[1].resolved,true);
  page.dispose();assert.equal(f.document.querySelector('[data-codlet-page-lease]'),null);
});

test('deferred registration reports the original failure to its consumer even when its lease is removed',async t=>{
  const f=uiFixture();t.after(()=>f.dispose());const baseline=f.cleanups.size;let token;
  f.overrides.set('register',args=>{token=args.token;return {api:1,token,path:'/pending',pending:true};});
  const page=await f.context.ui.page({label:'Unavailable toolbar',toolbar:true,render:()=>null});
  const rejected=assert.rejects(page.ready,error=>error.code==='ui_build_drift'&&error.message==='Native toolbar changed');
  await tick();const lease=f.document.querySelector('[data-codlet-page-lease]');
  lease.dataset.codletPageRegistration=JSON.stringify({api:1,token,status:'failed',error:{code:'ui_build_drift',message:'Native toolbar changed'}});lease.remove();
  await rejected;assert.equal(f.cleanups.size,baseline);assert.equal(f.document.querySelector('[data-codlet-page-lease]'),null);
  assert.deepEqual(f.errors.map(error=>error.code),['ui_page_registration_pending','ui_page_registration_pending','ui_page_registration_failed']);
  assert.equal(f.errors[1].resolved,true);assert.equal(f.errors[2].message,'Native toolbar changed');
});

test('pending auxiliary and retired page owners settle without acquiring UI or retaining observers',async t=>{
  for(const retire of [false,true]){
    const f=uiFixture();t.after(()=>f.dispose());const priorCleanups=new Set(f.cleanups),baseline={observers:f.observers.size,cleanups:f.cleanups.size};let token;
    f.context.ui.create=()=>assert.fail('pending or auxiliary page acquired UI');
    f.overrides.set('register',args=>{token=args.token;return {api:1,token,path:'/pending',pending:true};});
    const page=await f.context.ui.page({label:'Pending',render:()=>null});
    const result=retire?assert.rejects(page.ready,/retired/):page.ready;
    await tick();const lease=f.document.querySelector('[data-codlet-page-lease]');
    if(retire){for(const cleanup of [...f.cleanups])if(!priorCleanups.has(cleanup))cleanup();}
    else{lease.dataset.codletPageRegistration=JSON.stringify({api:1,token,status:'unavailable',path:null,available:false});lease.remove();}
    const ready=await result;if(!retire){assert.equal(page.path,null);assert.equal(ready.available,false);}
    assert.equal(f.observers.size,baseline.observers);assert.equal(f.cleanups.size,baseline.cleanups);
    assert.deepEqual(f.errors.map(error=>[error.code,error.resolved??false]),[['ui_page_registration_pending',false],['ui_page_registration_pending',true]]);
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
    assert.equal(f.document.querySelector('[data-codlet-page-lease]'),null);assert.equal(f.errors.length,replaceOwner?1:0);
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

test('reverse RPC replies cannot replace the latest accepted lease or clear its pending status',async t=>{
  const f=uiFixture();t.after(()=>f.dispose());const replies=[deferred(),deferred()],tokens=[];
  f.overrides.set('register',args=>{tokens.push(args.token);return replies[tokens.length-1].promise;});
  const first=f.context.ui.page({label:'First',render:()=>null});
  const oldRejected=assert.rejects(first,error=>error.code==='ui_page_superseded');
  const second=f.context.ui.page({label:'Second',render:()=>null});
  replies[1].resolve({api:1,token:tokens[1],path:'/new',pending:true});const page=await second;
  let ready=false;page.ready.then(()=>{ready=true;});
  replies[0].resolve({api:1,token:tokens[0],path:'/old',pending:true});await oldRejected;await tick();
  assert.equal(ready,false);assert.equal(f.errors.length,1);assert.equal(f.errors[0].code,'ui_page_registration_pending');
  const leases=f.document.querySelectorAll('[data-codlet-page-lease]');assert.equal(leases.length,1);assert.equal(leases[0].dataset.codletPageLease,tokens[1]);
  leases[0].dataset.codletPageRegistration=JSON.stringify({api:1,token:tokens[1],status:'ready',path:'/new'});
  await page.ready;assert.equal(page.path,'/new');assert.equal(f.errors.at(-1).resolved,true);
});

test('superseded receipts and failures cannot change the current pending page diagnostic',async t=>{
  const f=uiFixture();t.after(()=>f.dispose());const tokens=[];
  f.overrides.set('register',args=>{tokens.push(args.token);return {api:1,token:args.token,path:'/pending',pending:true};});
  const first=await f.context.ui.page({label:'First',render:()=>null});
  const oldLease=f.document.querySelector('[data-codlet-page-lease]'),oldRejected=assert.rejects(first.ready,error=>error.code==='ui_page_superseded');
  const page=await f.context.ui.page({label:'Second',render:()=>null});await oldRejected;
  const prior=f.errors.length;oldLease.dataset.codletPageRegistration=JSON.stringify({api:1,token:tokens[0],status:'failed',error:{code:'ui_build_drift',message:'Stale failure'}});
  await tick();assert.equal(f.errors.length,prior);assert.equal(f.errors.at(-1).resolved,undefined);
  const lease=f.document.querySelector('[data-codlet-page-lease]');assert.equal(lease.dataset.codletPageLease,tokens[1]);
  lease.dataset.codletPageRegistration=JSON.stringify({api:1,token:tokens[1],status:'ready',path:'/pending'});await page.ready;
  assert.equal(f.errors.at(-1).resolved,true);assert.equal(f.errors.some(error=>error.level==='error'),false);
});

test('a stale RPC rejection cannot overwrite a newer registration or resolve its pending state',async t=>{
  const f=uiFixture();t.after(()=>f.dispose());const oldReply=deferred();let calls=0;
  f.overrides.set('register',args=>++calls===1?oldReply.promise:{api:1,token:args.token,path:'/new',pending:true});
  const first=f.context.ui.page({label:'Old',render:()=>null}),failure=Error('Old contract failure');
  const rejected=assert.rejects(first,error=>error===failure);
  const page=await f.context.ui.page({label:'New',render:()=>null});oldReply.reject(failure);await rejected;await tick();
  assert.equal(f.errors.length,1);assert.equal(f.errors[0].code,'ui_page_registration_pending');assert.equal(f.errors[0].resolved,undefined);
  const pending=assert.rejects(page.ready,/retired/);page.dispose();await pending;
});

test('view creation, render and mount failures after readiness report owned errors and recover only on a successful mount',async t=>{
  for(const stage of ['create','render','mount']){
    const f=uiFixture();t.after(()=>f.dispose());const create=f.context.ui.create;
    const failure=Error('Failed '+stage);
    f.context.ui.create=()=>{if(stage==='create')throw failure;const ui=create();return stage==='mount'?{...ui,mount(){throw failure;}}:ui;};
    const page=await f.context.ui.page({label:'Broken',render:()=>{if(stage==='render')throw failure;return null;}});await page.ready;await f.open();
    assert.equal(f.errors.length,1);assert.equal(f.errors[0].code,'ui_page_render_failed');assert.equal(f.errors[0].message,failure.message);
    assert.equal(f.document.querySelector('[data-codlet-page-lease]'),null);
    f.context.ui.create=create;
    const replacement=await f.context.ui.page({label:'Recovered',render:()=>null});await replacement.ready;
    assert.equal(f.errors.length,1,'registration alone does not establish render recovery');
    await f.open();assert.equal(f.errors.length,2);assert.equal(f.errors[1].code,'ui_page_render_failed');assert.equal(f.errors[1].resolved,true);
  }
});

test('an already active route reports a synchronous view failure after registration readiness',async t=>{
  const f=uiFixture();t.after(()=>f.dispose());
  f.overrides.set('register',args=>{const host=f.document.createElement('div');host.dataset.codletPageHost=args.token;f.document.body.append(host);return{api:1,token:args.token,path:'/active'};});
  f.context.ui.create=()=>{throw Error('UI acquisition failed');};
  await assert.rejects(f.context.ui.page({label:'Active',render:()=>null}),/UI acquisition failed/);
  assert.equal(f.errors.length,1);assert.equal(f.errors[0].code,'ui_page_render_failed');assert.equal(f.document.querySelector('[data-codlet-page-lease]'),null);
});

test('cleanup failures stay separate from view readiness and render recovery',async t=>{
  const f=uiFixture();t.after(()=>f.dispose());
  const page=await f.context.ui.page({label:'Cleanup',render:()=>null,onDeactivate(){throw Error('View cleanup failed');}});await page.ready;await f.open();
  const next=await f.context.ui.page({label:'Replacement',render:()=>null});await next.ready;
  assert.throws(()=>page.dispose(),/View cleanup failed/);assert.equal(f.errors.length,1);assert.equal(f.errors[0].code,'ui_cleanup_failed');
  await f.open();
  assert.equal(f.errors.length,1,'a new render cannot clear an unrelated cleanup failure');
});

test('Native lease retirement reports a teardown failure once without relabeling it as rendering failure',async t=>{
  const f=uiFixture();t.after(()=>f.dispose());
  const page=await f.context.ui.page({label:'Cleanup',render:()=>null,onDeactivate(){throw Error('Native retirement cleanup failed');}});await page.ready;await f.open();
  f.document.querySelector('[data-codlet-page-lease]').remove();await tick();
  assert.equal(f.errors.length,1);assert.equal(f.errors[0].code,'ui_cleanup_failed');assert.equal(f.errors[0].message,'Native retirement cleanup failed');
});
