import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawnSync} from 'node:child_process';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {verifyBackend}=require('../codex/host/backend-launch.cjs');
const {runConfigProbe}=require('../codex/host/backend-config-probe.cjs');
const [executable,reportPath]=process.argv.slice(2);
if(!path.isAbsolute(executable??'')||!path.isAbsolute(reportPath??''))throw Error('Pass absolute backend executable and new report paths');
if(fs.existsSync(reportPath))throw Error('The report path must be new');
const identity=verifyBackend(executable);
const root=fs.mkdtempSync(path.join(os.tmpdir(),'codlet-backend-capabilities-'));
try{
  const codexRoot=path.join(root,'codex'),sqliteRoot=path.join(root,'sqlite');fs.mkdirSync(codexRoot);fs.mkdirSync(sqliteRoot);
  fs.writeFileSync(path.join(codexRoot,'auth.json'),JSON.stringify({OPENAI_API_KEY:'codlet-contract-synthetic'}));
  fs.writeFileSync(path.join(codexRoot,'config.toml'),'cli_auth_credentials_store="file"\nsandbox_mode="read-only"\napproval_policy="never"\nopenai_base_url="http://127.0.0.1:9/fixture/"\n[model_providers.contract_fixture]\nname="Contract fixture"\nwire_api="responses"\nbase_url="http://127.0.0.1:9/custom/"\n[features]\nremote_models=false\nremote_plugin=false\ncode_mode_host=false\n[analytics]\nenabled=false\n');
  const environment={...process.env,CODEX_HOME:codexRoot,CODEX_SQLITE_HOME:sqliteRoot,OPENAI_API_KEY:'codlet-contract-synthetic'};
  for(const key of Object.keys(environment))if(/^(CODEX_APP_SERVER_WS_URL|CODEX_APP_SERVER_OPENAI_BASE_URL|CODEX_APP_SERVER_CHATGPT_BASE_URL|OPENAI_BASE_URL)$/iu.test(key))delete environment[key];
  const started=Date.now();
  const result=spawnSync(process.execPath,['--no-addons','--no-global-search-paths','--eval',`(${runConfigProbe.toString()})()`],{
    input:JSON.stringify({executable,configArguments:[],environment,cwd:root,recordedRouting:false}),
    env:environment,cwd:root,windowsHide:true,encoding:'utf8',maxBuffer:256*1024,timeout:5000});
  if(result.error||result.status!==0)throw Error(result.error?.code??'backend_probe_failed');
  const policy=JSON.parse(result.stdout);
  const report={schema:1,identity,elapsedMs:Date.now()-started,contract:policy.contract??null,error:policy.error??null};
  fs.mkdirSync(path.dirname(reportPath),{recursive:true});fs.writeFileSync(reportPath,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
  console.log(JSON.stringify(report));
  if(policy.error)process.exitCode=1;
}finally{
  const resolved=fs.realpathSync(root),temporary=fs.realpathSync(os.tmpdir());
  if(path.dirname(resolved)!==temporary)throw Error('Unexpected temporary profile location');
  fs.rmSync(resolved,{recursive:true,maxRetries:8,retryDelay:100});
}
