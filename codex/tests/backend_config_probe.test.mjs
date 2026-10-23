import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const probes = createRequire(import.meta.url)('../host/backend-config-probe.cjs');
const { runConfigProbe } = probes;

test('effective config probe projects only routing data and exits after its owned child', () => {
  const fixture = fileURLToPath(new URL('./fixtures/traffic/probe-app-server.cjs', import.meta.url));
  const plan = { executable: process.execPath, configArguments: [fixture], environment: process.env, cwd: process.cwd() };
  const result = spawnSync(process.execPath, ['--no-addons', '--no-global-search-paths', '--eval', `(${runConfigProbe.toString()})()`], {
    input: JSON.stringify(plan), env: process.env, cwd: process.cwd(), windowsHide: true, encoding: 'utf8', timeout: 5000,
  });
  assert.equal(result.error?.code, undefined);
  assert.equal(result.status, 0);
  assert(!result.stdout.includes('never-project-this-secret'));
  assert(!result.stdout.includes('never-project-this-email'));
  assert.deepEqual(JSON.parse(result.stdout), { modelProvider: 'openai', providerBaseUrls: { custom: 'https://custom.example/v1' },
    openaiBaseUrl: 'https://fixture.example/v1', accountType: 'apiKey',contract:{api:1,initialize:true,configRead:true,accountRead:true,routing:'runtime',
      providerOverrides:['openai_base_url','model_providers.custom.base_url']} });
});

test('runtime capability probes reject missing methods, malformed replies and ignored route settings',()=>{
  const fixture=fileURLToPath(new URL('./fixtures/traffic/probe-app-server.cjs',import.meta.url));
  for(const [mode,error]of [['missing-config','backend_contract_unavailable'],['malformed-account','backend_contract_unavailable'],['ignore-overrides','backend_routing_contract_unavailable']]){
    const environment={...process.env,CODLET_PROBE_FIXTURE:mode};
    const result=spawnSync(process.execPath,['--eval',`(${runConfigProbe.toString()})()`],{input:JSON.stringify({executable:process.execPath,configArguments:[fixture],environment,cwd:process.cwd()}),
      env:environment,cwd:process.cwd(),windowsHide:true,encoding:'utf8',timeout:4500});
    assert.equal(result.error,undefined,mode);assert.equal(result.status,0,mode);assert.deepEqual(JSON.parse(result.stdout),{error},mode);
  }
});

test('declared response providers retain default-endpoint semantics and prove their route override',()=>{
  const fixture=fileURLToPath(new URL('./fixtures/traffic/probe-app-server.cjs',import.meta.url));
  for(const mode of ['default-auth','default-api']){
    const environment={...process.env,CODLET_PROBE_FIXTURE:mode};
    const result=spawnSync(process.execPath,['--eval',`(${runConfigProbe.toString()})()`],{input:JSON.stringify({executable:process.execPath,configArguments:[fixture],environment,cwd:process.cwd()}),env:environment,cwd:process.cwd(),windowsHide:true,encoding:'utf8',timeout:5000});
    assert.equal(result.status,0);const policy=JSON.parse(result.stdout);
    assert.equal(policy.error,undefined);assert.equal(policy.modelProvider,'custom');
    assert.deepEqual(policy.providerBaseUrls,{custom:null});
    assert.deepEqual(policy.providerAuthDefaults,{custom:mode==='default-auth'});
    assert.deepEqual(policy.contract.providerOverrides,['openai_base_url','model_providers.custom.base_url']);
    assert(!result.stdout.includes('never-project-this-secret'));
  }
});

test('in-process async configuration probing yields the event loop and retires its own children', async () => {
  const fixture=fileURLToPath(new URL('./fixtures/traffic/probe-app-server.cjs',import.meta.url)),children=[];
  let ticked=false;
  const work=runConfigProbe({executable:process.execPath,configArguments:[fixture],environment:process.env,cwd:process.cwd()},{
    spawn(...args){const child=spawn(...args);children.push(child);return child;}
  });
  const tick=new Promise(resolve=>setImmediate(()=>{ticked=true;resolve();}));
  await tick;
  const policy=await work;
  assert.equal(ticked,true);assert.equal(policy.accountType,'apiKey');
  assert.equal(children.length,2);
  assert(children.every(child=>child.exitCode!==null||child.signalCode!==null));
});

test('cancelling an async probe stops its owned child without publishing policy', async () => {
  const fixture=fileURLToPath(new URL('./fixtures/traffic/probe-app-server.cjs',import.meta.url)),controller=new AbortController(),children=[];
  const work=runConfigProbe({executable:process.execPath,configArguments:[fixture],environment:process.env,cwd:process.cwd()},{
    signal:controller.signal,spawn(...args){const child=spawn(...args);children.push(child);return child;}
  });
  controller.abort();
  await assert.rejects(work,{code:'backend_probe_cancelled'});
  assert.equal(children.length,1);
  assert(children.every(child=>child.exitCode!==null||child.signalCode!==null));
});

test('startup probing can use the remaining source deadline while ordinary probes stay bounded', {timeout:16000}, async () => {
  const fixture=fileURLToPath(new URL('./fixtures/traffic/probe-app-server.cjs',import.meta.url));
  const plan={executable:process.execPath,configArguments:[fixture],environment:{...process.env,CODLET_PROBE_FIXTURE:'slow-initialize'},cwd:process.cwd(),recordedRouting:true};
  for(const startup of [false,true]){
    const children=[];
    const work=runConfigProbe(plan,{...(startup?{deadlineUnixMs:Date.now()+10000}:{}),spawn(...args){const child=spawn(...args);children.push(child);return child;}});
    if(startup)assert.equal((await work).accountType,'apiKey');
    else await assert.rejects(work,{code:'backend_config_timeout'});
    assert.equal(children.length,1,'The original metadata probe is never replayed');
    assert(children.every(child=>child.exitCode!==null||child.signalCode!==null));
  }
});

test('configuration probes isolate disposable state while retaining config and retire it after success or failure', async () => {
  const fixture=fileURLToPath(new URL('./fixtures/traffic/probe-app-server.cjs',import.meta.url));
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'codlet-probe-test-'));
  fs.writeFileSync(path.join(home,'native-state'),'unchanged');
  try {
    for(const mode of ['isolated-state','isolated-state-failure']) {
      const children=[],directories=[];
      const environment={...process.env,CODEX_HOME:home,CODEX_SQLITE_HOME:home,CODLET_PROBE_FIXTURE:mode};
      const work=runConfigProbe({executable:process.execPath,configArguments:[fixture,'-c',`sqlite_home=${JSON.stringify(home)}`],environment,cwd:home},{
        spawn(file,args,options) {
          assert.equal(options.env.CODEX_HOME,home,'Configuration and account lookup retain their context');
          assert.notEqual(options.env.CODEX_SQLITE_HOME,home,'Probe state must not share the live Native database');
          assert.equal(args.filter(value=>value.startsWith('sqlite_home=')).at(-1),`sqlite_home=${JSON.stringify(options.env.CODEX_SQLITE_HOME)}`);
          directories.push(options.env.CODEX_SQLITE_HOME);
          const child=spawn(file,args,options);children.push(child);return child;
        }
      });
      if(mode==='isolated-state')assert.equal((await work).accountType,'apiKey');
      else await assert.rejects(work,{code:'backend_config_unavailable'});
      assert.equal(environment.CODEX_SQLITE_HOME,home,'The original launch plan is unchanged');
      assert(children.every(child=>child.exitCode!==null||child.signalCode!==null));
      assert.equal(children.length,mode==='isolated-state'?2:1);
      assert(directories.every(directory=>!fs.existsSync(directory)),'Owned state is removed after child retirement');
      assert.deepEqual(fs.readdirSync(home),['native-state']);
    }
  } finally { fs.rmSync(home,{recursive:true}); }
});

test('Native main-loop stalls cannot consume the metadata worker deadline or child retirement callbacks', {timeout:10000}, async () => {
  const fixture=fileURLToPath(new URL('./fixtures/traffic/probe-app-server.cjs',import.meta.url));
  const probe=probes.runConfigProbeInWorker??runConfigProbe;
  const work=probe({executable:process.execPath,configArguments:[fixture],environment:process.env,cwd:process.cwd()});
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,4500);
  const result=await work;
  assert.equal(result.accountType,'apiKey');
  assert.equal(result.contract.routing,'runtime');
});

test('cancelling a metadata worker confirms its child exit and removes owned state before rejection', {timeout:7000}, async () => {
  const fixture=fileURLToPath(new URL('./fixtures/traffic/probe-app-server.cjs',import.meta.url));
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'codlet-worker-test-')),receipt=path.join(root,'children.jsonl');
  const controller=new AbortController();
  try {
    const work=probes.runConfigProbeInWorker({executable:process.execPath,configArguments:[fixture],environment:{...process.env,
      CODLET_PROBE_FIXTURE:'slow-initialize',CODLET_PROBE_FIXTURE_RECEIPT:receipt},cwd:root},{signal:controller.signal});
    const rejected=assert.rejects(work,{code:'backend_probe_cancelled'});
    const until=Date.now()+3000;
    while(!fs.existsSync(receipt)&&Date.now()<until)await new Promise(resolve=>setTimeout(resolve,20));
    controller.abort();
    await rejected;
    const children=fs.readFileSync(receipt,'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(children.length,1);
    for(const child of children){
      assert.throws(()=>process.kill(child.pid,0),{code:'ESRCH'});
      assert.equal(fs.existsSync(child.stateRoot),false);
    }
  } finally { controller.abort();fs.rmSync(root,{recursive:true}); }
});

test('a completed metadata receipt retires its worker even when the embedding leaves a referenced handle', {timeout:7000}, async () => {
  const threads=createRequire(import.meta.url)('node:worker_threads'),Original=threads.Worker;
  const fixture=fileURLToPath(new URL('./fixtures/traffic/probe-app-server.cjs',import.meta.url));
  threads.Worker=class extends Original {
    constructor(source,options){super('setTimeout(()=>{},4500);\n'+source,options);}
  };
  try {
    const started=Date.now();
    const result=await probes.runConfigProbeInWorker({executable:process.execPath,configArguments:[fixture],environment:process.env,cwd:process.cwd()});
    assert.equal(result.accountType,'apiKey');
    assert(Date.now()-started<2500,'A completed probe must not wait for an unrelated embedding handle');
  } finally {threads.Worker=Original;}
});
