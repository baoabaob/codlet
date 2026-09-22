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
