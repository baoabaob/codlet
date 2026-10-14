// Read-only ownership and empty-data verification for one explicit Core run.
import fs from 'node:fs';import path from 'node:path';import {execFileSync} from 'node:child_process';import {createHash} from 'node:crypto';import {fileURLToPath} from 'node:url';
const directory=path.resolve(process.argv[2]??''),processOnly=process.argv[3]==='--owned-process-only';
if(process.argv.length>3&&!processOnly)throw Error('Optional mode is --owned-process-only');
const plan=JSON.parse(fs.readFileSync(path.join(directory,'preflight.json'),'utf8'));
if(path.basename(directory)!==plan.runId||!/^core-[a-f0-9-]{36}$/.test(plan.runId))throw Error('Explicit owned Core run required');
const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
if(directory!==path.join(repo,'.codlet-artifacts/core-native',plan.runId))throw Error('Run is outside this repository');
const root=path.join(directory,'profile'),configFile=fs.existsSync(path.join(directory,'client/lab-config.json'))?path.join(directory,'client/lab-config.json'):path.join(root,'lab-config.json'),config=JSON.parse(fs.readFileSync(configFile,'utf8'));
const state=JSON.parse(fs.readFileSync(path.join(root,'logs/manual-client.json'),'utf8'));
if(path.resolve(config.labRoot)!==root||path.resolve(state.labRoot)!==root||!['ready','awaiting_authentication','awaiting_sandbox'].includes(state.state)||!/^\d+-\d+$/.test(state.runId)||path.resolve(state.logs)!==path.join(root,'logs','coordinator-'+state.runId))throw Error('Running coordinator ownership mismatch');
const powershell=path.join(process.env.SYSTEMROOT??'C:/Windows','System32/WindowsPowerShell/v1.0/powershell.exe');
const pids=[state.managerPid,state.hostPid,state.backendPid,state.desktopPid];if(pids.some(pid=>!Number.isSafeInteger(pid)||pid<=0))throw Error('Missing process ownership');
const ps=source=>JSON.parse(execFileSync(powershell,['-NoProfile','-NonInteractive','-Command',source],{encoding:'utf8',windowsHide:true}).trim());
const facts=ps(`@(${pids.join(',')}) | ForEach-Object { $codletProcess=Get-Process -Id $_ -ErrorAction Stop; [pscustomobject]@{pid=$codletProcess.Id;created=$codletProcess.StartTime.ToUniversalTime().ToString('o');filetime=$codletProcess.StartTime.ToUniversalTime().ToFileTimeUtc().ToString();image=$codletProcess.Path} } | ConvertTo-Json -Compress`);
const byPid=new Map(facts.map(fact=>[fact.pid,fact]));
if(Date.parse(byPid.get(state.managerPid).created)!==Date.parse(state.managerCreated)||byPid.get(state.desktopPid).filetime!==state.desktopCreated||Date.parse(byPid.get(state.backendPid).created)!==Date.parse(state.backendIdentity.created))throw Error('Process creation identity mismatch');
if(path.resolve(byPid.get(state.hostPid).image).toLowerCase()!==path.join(directory,'client/codlet-lab.exe').toLowerCase()||path.resolve(byPid.get(state.backendPid).image).toLowerCase()!==path.resolve(config.officialCli).toLowerCase())throw Error('Core/backend executable mismatch');
if(path.resolve(byPid.get(state.desktopPid).image).toLowerCase()!==path.join(path.dirname(path.dirname(config.officialCli)),'ChatGPT.exe').toLowerCase())throw Error('Desktop executable mismatch');
const endpoint=new URL(state.endpoint);if(endpoint.protocol!=='ws:'||endpoint.hostname!=='127.0.0.1'||!/^\d+$/.test(endpoint.port)||endpoint.pathname!=='/'||endpoint.search)throw Error('Non-local backend endpoint');
const listener=ps(`Get-NetTCPConnection -LocalPort ${Number(endpoint.port)} -State Listen | Select-Object OwningProcess,LocalAddress | ConvertTo-Json -Compress`);
if(Array.isArray(listener)||listener.OwningProcess!==state.backendPid||listener.LocalAddress!=='127.0.0.1')throw Error('Backend port has another owner');
if(!path.resolve(state.report).startsWith(path.join(root,'logs')+path.sep))throw Error('Report escaped profile');
const rows=fs.readFileSync(state.report,'utf8').trim().split(/\r?\n/).map(line=>JSON.parse(line));
const prepared=rows.find(row=>row.event==='prepared')?.detail,attached=rows.find(row=>row.event==='renderer_attached'),runtime=rows.find(row=>row.event==='plugin_runtime_ready'),startup=rows.find(row=>row.event==='startup_verified');
if(!prepared||!attached||!runtime||!startup||attached.child_pid!==state.desktopPid||attached.host_pid!==state.hostPid)throw Error('Missing owned startup/renderer evidence');
for(const key of ['root','codex_home','sqlite_home','user_data','project','plugin_registry']){const value=path.resolve(prepared[key]);if(value!==root&&!value.startsWith(root+path.sep))throw Error('Prepared data route escaped profile');}
const targetId=attached.detail.target_id,snapshot=rows.filter(row=>row.event==='renderer_snapshot').at(-1)?.detail.renderer;
if(!snapshot?.targets.some(target=>target.target_id===targetId&&target.session_live))throw Error('Target was not live in owned renderer snapshot');
if(processOnly){
 const probe=state.backendProbe;if(!probe?.initialized||!probe.authenticated||!probe.fileCredentialStore||!probe.readOnlyBackend||!probe.desktopAppToolsDisabled||probe.windowsReadiness!=='ready'||probe.chromeInstalled||!probe.originRejected)throw Error('Stored pre-Native readiness evidence is incomplete');
 const labHash=createHash('sha256').update(fs.readFileSync(path.join(directory,'client/codlet-lab.exe'))).digest('hex');if(labHash!==config.labBinarySha256.toLowerCase())throw Error('Lab binary pin changed');
 const evidence={schema:1,runId:plan.runId,coordinatorRunId:state.runId,phase:state.state,packageVersion:config.expectedPackageVersion,registry:prepared.plugin_registry,registryScope:runtime.detail.registry_scope,dataRoutes:{codexHome:prepared.codex_home,sqlite:prepared.sqlite_home,electronUserData:prepared.user_data},processes:facts,targetId,targetEvidence:'Owned CDP pipe renderer snapshot and current PID creation identity',startup:startup.detail.evidence,originalProcessesUnchangedAtStartup:state.originalProcessesUnchanged,backendProbe:probe,labBinarySha256:labHash,noAdditionalBackendConnection:true,threadDataVerification:'Read through the owned standard SDK after this identity check',performanceAssessedByThisCheck:false};
 fs.writeFileSync(path.join(directory,'owned-runtime-evidence.json'),JSON.stringify(evidence,null,2)+'\n');console.log(JSON.stringify({runId:plan.runId,phase:state.state,targetId,noAdditionalBackendConnection:true}));process.exit(0);
}
const ws=new WebSocket(state.endpoint),pending=new Map();let id=0;
ws.addEventListener('message',event=>{const message=JSON.parse(String(event.data));const call=pending.get(message.id);if(call){pending.delete(message.id);clearTimeout(call.timer);message.error?call.reject(Error('Read-only backend request failed')):call.resolve(message.result);}});
function request(method,params){return new Promise((resolve,reject)=>{const ticket=++id,timer=setTimeout(()=>{pending.delete(ticket);reject(Error('Read-only backend request timed out'));},10000);pending.set(ticket,{resolve,reject,timer});ws.send(JSON.stringify({id:ticket,method,params}));});}
try{
 await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Backend connection timed out')),5000);ws.addEventListener('open',()=>{clearTimeout(timer);resolve();},{once:true});ws.addEventListener('error',()=>{clearTimeout(timer);reject(Error('Backend connection failed'));},{once:true});});
 await request('initialize',{clientInfo:{name:'codlet-core-owned-data-check',version:'0.1.0'},capabilities:{experimentalApi:true}});ws.send(JSON.stringify({method:'initialized',params:{}}));
 const account=await request('account/read',{refreshToken:false});
 for(const archived of [false,true]){const reply=await request('thread/list',{limit:1,archived,useStateDbOnly:true});if(!Array.isArray(reply.data)||reply.data.length||reply.nextCursor)throw Error('Profile already contains threads; not an empty-data fixture');}
 const hash=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
 const labHash=hash(path.join(directory,'client/codlet-lab.exe'));if(labHash!==config.labBinarySha256.toLowerCase())throw Error('Lab binary pin changed');
 const evidence={schema:1,runId:plan.runId,coordinatorRunId:state.runId,phase:state.state,packageVersion:config.expectedPackageVersion,registry:prepared.plugin_registry,registryScope:runtime.detail.registry_scope,dataRoutes:{codexHome:prepared.codex_home,sqlite:prepared.sqlite_home,electronUserData:prepared.user_data,webProfileWithinOwnedRoaming:true},processes:facts,targetId,targetEvidence:'Owned CDP pipe renderer snapshot, not a historical/default Target',startup:startup.detail.evidence,originalProcessesUnchangedAtStartup:state.originalProcessesUnchanged,authenticated:account.account!=null,activeThreads:0,archivedThreads:0,labBinarySha256:labHash,performanceAssessedByThisCheck:false};
 const webProfile=path.join(root,'home/AppData/Roaming/Codex/web/Codex');evidence.dataRoutes.webProfileWithinOwnedRoaming=fs.existsSync(webProfile);
 fs.writeFileSync(path.join(directory,'owned-runtime-evidence.json'),JSON.stringify(evidence,null,2)+'\n');
 console.log(JSON.stringify({runId:evidence.runId,phase:evidence.phase,targetId,authenticated:evidence.authenticated,activeThreads:0,archivedThreads:0,performanceAssessedByThisCheck:false}));
}finally{for(const call of pending.values())clearTimeout(call.timer);ws.close();}
