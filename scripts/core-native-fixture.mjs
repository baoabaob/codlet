// Fresh owned Native test only. Does not initialize a Windows sandbox, import
// credentials/sessions, attach CDP, or connect to an existing Desktop/backend.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const manifestFile=path.resolve(process.argv[2]??''),plan=JSON.parse(fs.readFileSync(manifestFile,'utf8'));
if(!/^core-[a-f0-9-]{36}$/.test(plan.runId)||plan.launched!==false)throw Error('Expected a fresh unlaunched Core plan');
const directory=path.join(repo,'.codlet-artifacts/core-native',plan.runId),root=path.join(directory,'profile');
if(manifestFile!==path.join(directory,'preflight.json')||path.resolve(plan.planned.profileRoot)!==root)throw Error('Plan is outside its owned run');
const prepared=JSON.parse(fs.readFileSync(path.join(directory,'prepared-profile.json'),'utf8'));
if(prepared.runId!==plan.runId||prepared.desktopCreated!==false||prepared.backendCreated!==false)throw Error('Expected prepared empty profile with no children');
const marker=JSON.parse(fs.readFileSync(path.join(root,'.codlet-lab-owner.json'),'utf8'));
if(marker.schema_version!==1||marker.experimental!==true)throw Error('Profile has no experimental owner marker');
const sha=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const builtLab=plan.inputs?.labBinary??path.join(repo,'target/debug/codlet-lab.exe'),cli=path.join(plan.installedPackage.InstallLocation,'app/resources/codex.exe');
const builtRelative=path.relative(repo,path.resolve(builtLab));if(builtRelative.startsWith('..')||path.isAbsolute(builtRelative))throw Error('Planned lab executable is outside this workspace');
if(sha(builtLab)!==plan.hashes.labBinary||sha(cli)!==plan.hashes.officialCli)throw Error('Owned executable hashes changed; generate a fresh plan');
for(const relative of ['codex-home/auth.json','logs/manual-client.json','fixture.json','lab-config.json'])if(fs.existsSync(path.join(root,relative)))throw Error('Fixture only prepares an unused profile: '+relative);
const configFile=path.join(root,'codex-home/config.toml');
if(fs.readFileSync(configFile,'utf8')!=='cli_auth_credentials_store = "file"\n')throw Error('Profile config was not created by empty lab preparation');
const registry=JSON.parse(fs.readFileSync(path.join(root,'codlet/config.json'),'utf8'));
if(registry.schema!==2||Object.keys(registry.plugins??{}).length||Object.keys(registry.localPlugins??{}).length)throw Error('Fixture requires no installed external plugins');
// Cargo's target executable is a hardlink to deps. A detached single-link copy
// supplies immutable identity and a real installed root with only managed Node.
const client=path.join(directory,'client');fs.mkdirSync(client);
const lab=path.join(client,'codlet-lab.exe');fs.copyFileSync(builtLab,lab,fs.constants.COPYFILE_EXCL);
if(sha(lab)!==plan.hashes.labBinary||fs.lstatSync(lab).nlink!==1)throw Error('Detached test executable identity failed');
const nodeRelative='runtime/node-v24.21.0-win-x64',nodeDirectory=path.join(client,nodeRelative);fs.mkdirSync(nodeDirectory,{recursive:true});
const runtimeSource=plan.inputs?.nodeRuntime??path.join(repo,'target/debug',nodeRelative);
for(const [name,pin]of [['node.exe',plan.hashes.runtimeNode],['LICENSE',plan.hashes.runtimeLicense]]){const source=path.join(runtimeSource,name);if(pin&&sha(source)!==pin)throw Error('Planned managed runtime identity changed: '+name);fs.copyFileSync(source,path.join(nodeDirectory,name),fs.constants.COPYFILE_EXCL);}
const runtimePin=plan.inputs?.runtimePin??path.join(path.dirname(builtLab),'runtime/node-runtime.json');
if(!plan.hashes.runtimePin||sha(runtimePin)!==plan.hashes.runtimePin)throw Error('Planned managed runtime pin changed or was not recorded');
fs.copyFileSync(runtimePin,path.join(client,'runtime/node-runtime.json'),fs.constants.COPYFILE_EXCL);
const logFile=path.join(root,'fixture-requests.jsonl');
fs.writeFileSync(logFile,'',{flag:'wx'});
const log=value=>fs.appendFileSync(logFile,JSON.stringify({at:new Date().toISOString(),...value})+'\n');
let requests=0,child;
async function respond(request,response){
  const url=new URL(request.url,'http://127.0.0.1');
  // The SDK's task-local private Responses provider intentionally has no
  // ambient OAuth or env_key. Both modes belong solely to this synthetic server.
  const authorization=request.headers.authorization;
  if(authorization!==undefined&&authorization!=='Bearer codlet-local-fixture'){
    log({path:url.pathname,method:request.method,authorized:false});response.writeHead(401,{'content-type':'application/json'}).end('{"error":{"message":"Synthetic fixture credentials required"}}');return;
  }
  let body='',bytes=0;for await(const part of request){bytes+=part.length;if(bytes>4*1024*1024){response.writeHead(413).end();return;}body+=part;}
  const index=++requests;log({request:index,path:url.pathname,method:request.method,bytes,authorized:true,authorizationMode:authorization===undefined?'synthetic-private-provider':'synthetic-api-key'});
  if(url.pathname==='/v1/models'){response.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({object:'list',data:[{id:'gpt-5.4',object:'model',owned_by:'codlet-local-fixture'}]}));return;}
  if(url.pathname!=='/v1/responses'||request.method!=='POST'){response.writeHead(404,{'content-type':'application/json'}).end('{"error":{"message":"Fixture endpoint unavailable"}}');return;}
  let payload;try{payload=JSON.parse(body);}catch{response.writeHead(400).end();return;}
  if(!payload||typeof payload!=='object'){response.writeHead(400).end();return;}
  const online=JSON.stringify(payload.input??[]).includes('[CODEX_CORE_ONLINE_STREAM]');
  const chunks=online?480:20,delayMs=online?500:100;
  log({request:index,event:'stream_admitted',kind:online?'online-continuity':'functional',chunks,delayMs});
  const id='resp_'+randomUUID(),itemId='msg_'+randomUUID();let sequence=0;
  const output=text=>({id:itemId,type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text,annotations:[]}]});
  response.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-cache'});response.flushHeaders();
  const emit=event=>{if(!response.destroyed)response.write(`event: ${event.type}\ndata: ${JSON.stringify({...event,sequence_number:sequence++})}\n\n`);};
  emit({type:'response.created',response:{id,object:'response',status:'in_progress',output:[]}});
  emit({type:'response.output_item.added',output_index:0,item:{id:itemId,type:'message',role:'assistant',status:'in_progress',content:[]}});
  emit({type:'response.content_part.added',item_id:itemId,output_index:0,content_index:0,part:{type:'output_text',text:'',annotations:[]}});
  let text='';
  for(let chunk=1;chunk<=chunks;chunk++){
    await delay(delayMs);if(response.destroyed){log({request:index,event:'stream_closed',chunks:chunk-1});return;}
    const delta=`codlet-original-response SYNTHETIC_CORE_SEQUENCE_${String(chunk).padStart(4,'0')}\n`;text+=delta;
    emit({type:'response.output_text.delta',item_id:itemId,output_index:0,content_index:0,delta});
    log({request:index,event:'delta',chunk});
  }
  emit({type:'response.output_text.done',item_id:itemId,output_index:0,content_index:0,text});
  emit({type:'response.content_part.done',item_id:itemId,output_index:0,content_index:0,part:{type:'output_text',text,annotations:[]}});
  emit({type:'response.output_item.done',output_index:0,item:output(text)});
  emit({type:'response.completed',response:{id,object:'response',status:'completed',output:[output(text)],usage:{input_tokens:1,output_tokens:chunks,total_tokens:chunks+1}}});
  response.end();log({request:index,event:'completed',chunks});
}
const fixture=http.createServer((request,response)=>{void respond(request,response).catch(error=>{log({event:'fixture_error',code:error.code??null});response.destroy();});});
fixture.on('upgrade',(_request,socket)=>socket.end('HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'));
await new Promise((resolve,reject)=>{fixture.once('error',reject);fixture.listen(0,'127.0.0.1',resolve);});
try{
  const baseUrl=`http://127.0.0.1:${fixture.address().port}/v1`;
  fs.writeFileSync(path.join(root,'codex-home/auth.json'),JSON.stringify({OPENAI_API_KEY:'codlet-local-fixture'})+'\n',{flag:'wx'});
  fs.writeFileSync(configFile,`openai_base_url=${JSON.stringify(baseUrl)}\ncli_auth_credentials_store="file"\nsandbox_mode="read-only"\napproval_policy="never"\nmodel="gpt-5.4"\n[features]\nplugins=false\nremote_models=false\nremote_plugin=false\ncode_mode_host=false\nresponses_websockets=false\nresponses_websockets_v2=false\n[analytics]\nenabled=false\n[mcp_servers.codex_app]\nenabled=false\ncommand=""\n[windows]\nsandbox="unelevated"\n`);
  const config={schema:1,labRoot:root,labBinary:lab,labBinarySha256:plan.hashes.labBinary,officialCli:cli,officialCliSha256:plan.hashes.officialCli,expectedPackageVersion:plan.installedPackage.Version,requireEmptyBackend:true};
  const labConfig=path.join(client,'lab-config.json');fs.writeFileSync(labConfig,JSON.stringify(config,null,2)+'\n',{flag:'wx'});
  fs.writeFileSync(path.join(root,'fixture.json'),JSON.stringify({schema:1,runId:plan.runId,baseUrl,fixturePid:process.pid,syntheticCredentials:true,copiedCredentials:false,copiedSessions:false,externalPlugins:[],readOnly:true,tools:false,sandboxSetup:false,onboarding:false,streams:{functional:{chunks:20,delayMs:100},online:{inputMarker:'[CODEX_CORE_ONLINE_STREAM]',chunks:480,delayMs:500}}},null,2)+'\n',{flag:'wx'});
  child=spawn(process.execPath,[path.join(repo,'scripts/isolated-client.mjs'),'start',labConfig],{cwd:repo,env:process.env,windowsHide:true,stdio:'inherit'});
  const exit=await new Promise((resolve,reject)=>{child.once('exit',resolve);child.once('error',reject);});process.exitCode=exit??1;
}finally{
  fixture.closeAllConnections();await new Promise(resolve=>fixture.close(resolve));
}
