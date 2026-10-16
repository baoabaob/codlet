import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const { runConfigProbe } = createRequire(import.meta.url)('../host/backend-config-probe.cjs');

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
