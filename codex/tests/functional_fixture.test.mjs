import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const host=require('./fixtures/runtime-compatibility/consumer/host.cjs');

test('functional fixture never enables native model interception outside its owned loopback profile',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'codlet-functional-guard-'));
  assert.equal(path.dirname(root),path.resolve(os.tmpdir()));
  const pluginRoot=path.join(root,'fixture-plugins','compatibility.acceptance');fs.mkdirSync(pluginRoot,{recursive:true});
  try{
    for(const item of [
      {marker:false,url:'http://127.0.0.1:12345/v1',enabled:true,expected:false},
      {marker:true,url:'https://api.openai.com/v1',enabled:true,expected:false},
      {marker:true,url:'http://127.0.0.1:12345/v1',enabled:false,expected:false},
      {marker:true,url:'http://127.0.0.1:12345/v1',enabled:true,expected:true},
    ]){
      if(item.marker)fs.writeFileSync(path.join(root,'owner.txt'),'codlet-desktop-acceptance\n');
      fs.writeFileSync(path.join(pluginRoot,'fixture.json'),JSON.stringify({baseUrl:item.url,autorun:item.enabled}));
      const methods=new Map();let registrations=0,closed=0;
      await host.activate({root:pluginRoot,plugin:{id:'compatibility.acceptance',version:'0.0.3',generation:1},services:{},
        rpc:{provide:(_cap,method,handler)=>methods.set(method,handler)},
        traffic:{registerInterceptor:async()=>{registrations++;return {close:async()=>{closed++;}};}}});
      try{
        const inspect=methods.get('inspect'),report=inspect(null,{caller:{pluginId:'compatibility.acceptance'}});
        assert.equal(report.fixture.autorun,item.expected);
        assert.equal(report.report.phase,'idle');assert.equal(registrations,0);
        assert.throws(()=>inspect(null,{caller:{pluginId:'foreign.plugin'}}),/Only the test plugin/);
        if(item.expected)await methods.get('native.begin')(null,{caller:{pluginId:'compatibility.acceptance'}});
        else await assert.rejects(()=>methods.get('native.begin')(null,{caller:{pluginId:'compatibility.acceptance'}}),/owned loopback/);
        assert.equal(registrations,Number(item.expected));
      }finally{await host.deactivate();}
      assert.equal(closed,Number(item.expected));
      assert.equal(JSON.parse(fs.readFileSync(path.join(pluginRoot,'cleanup.json'))).retired,true);
    }
  }finally{fs.rmSync(root,{recursive:true});}
});

function draftOpener(){
  let now=0;
  const sandbox=vm.createContext({module:{exports:{}},Date:{now:()=>now},setTimeout:(callback,delay)=>{now+=delay;queueMicrotask(callback);}});
  const source=fs.readFileSync(new URL('./fixtures/runtime-compatibility/consumer/renderer.js',import.meta.url),'utf8');
  vm.runInContext(source,sandbox);
  return vm.runInContext('openDraftWhenReady',sandbox);
}

test('draft checks wait for native navigation without replaying an applied action',async()=>{
  const open=draftOpener(),params={prompt:'Unsent test draft'};let calls=0,actions=0;
  const result=await open(async(capability,method,args,options)=>{
    assert.equal(capability,'codex.ui.navigation.page');assert.equal(method,'newTaskDraft');assert.equal(args,params);assert.ok(options.timeoutMs>0&&options.timeoutMs<=10000);
    calls++;
    if(calls===1)throw Object.assign(Error('Waiting for the current native navigation tree'),{code:'ui_host_pending'});
    if(calls===2)throw Error('ui_host_pending: Waiting for the current native navigation tree');
    actions++;return {opened:true,submitted:false};
  },()=>true,params);
  assert.equal(calls,3);assert.equal(actions,1);assert.deepEqual(result,{opened:true,submitted:false});
});

test('draft checks preserve uncertain failures and never replay them',async()=>{
  for(const code of ['request_timeout','invalid_owner','ui_host_drift']){
    const open=draftOpener();let calls=0;
    const failure=Object.assign(Error(code),{code});
    await assert.rejects(()=>open(async()=>{calls++;throw failure;},()=>true,{prompt:'Unsent test draft'}),error=>error===failure);
    assert.equal(calls,1);
  }
});

test('draft navigation waits end at their deadline and at generation retirement',async()=>{
  const pending=Object.assign(Error('Waiting for the current native navigation tree'),{code:'ui_host_pending'});
  let calls=0;
  await assert.rejects(()=>draftOpener()(async()=>{calls++;throw pending;},()=>true,{prompt:'Unsent test draft'},160),error=>error===pending);
  assert.ok(calls<=3);
  let alive=true,retiredCalls=0;
  await assert.rejects(()=>draftOpener()(async()=>{retiredCalls++;alive=false;throw pending;},()=>alive,{prompt:'Unsent test draft'}),/Test retired/);
  assert.equal(retiredCalls,1);
});

test('complete reports can only be saved by the owning plugin generation and remain bounded',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'codlet-functional-report-'));
  assert.equal(path.dirname(root),path.resolve(os.tmpdir()));
  const methods=new Map(),caller={caller:{pluginId:'compatibility.acceptance'}};
  try{
    await host.activate({root,plugin:{id:'compatibility.acceptance',version:'0.0.3',generation:4},services:{},rpc:{provide:(_cap,method,handler)=>methods.set(method,handler)}});
    const save=methods.get('save-report'),report={schema:1,version:'0.0.3',generation:4,phase:'complete',checks:[{id:'native.editable-draft',status:'passed'},{id:'desktop.model-operations',status:'manual'}]};
    assert.throws(()=>save({report},{caller:{pluginId:'foreign.plugin'}}),/Only the test plugin/);
    assert.throws(()=>save({report:{...report,generation:3}},caller),/this generation/);
    assert.throws(()=>save({report:{...report,padding:'x'.repeat(65536)}},caller),/size limit/);
    assert.deepEqual(save({report},caller),{saved:true});
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root,'functional-report.json'),'utf8')),report);
    assert.equal(methods.get('inspect')(null,caller).fixture.autorun,false);
  }finally{await host.deactivate();fs.rmSync(root,{recursive:true});}
});
