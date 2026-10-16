'use strict';
const { createInterface } = require('node:readline');
const config = {model_provider:'openai',openai_base_url:'https://fixture.example/v1',
  model_providers:{custom:{wire_api:'responses',base_url:'https://custom.example/v1',http_headers:{authorization:'never-project-this-secret'}}}};
if(['default-auth','default-api'].includes(process.env.CODLET_PROBE_FIXTURE)){
  config.model_provider='custom';config.model_providers.custom.base_url=null;
  config.model_providers.custom.requires_openai_auth=process.env.CODLET_PROBE_FIXTURE==='default-auth';
}
for(let i=2;i<process.argv.length;i++) {
  if(process.argv[i]!=='-c')continue;
  const [key,...parts]=process.argv[++i].split('=');
  if(process.env.CODLET_PROBE_FIXTURE==='ignore-overrides')continue;
  if(key==='openai_base_url')config.openai_base_url=JSON.parse(parts.join('='));
  if(key==='model_providers.custom.base_url')config.model_providers.custom.base_url=JSON.parse(parts.join('='));
}
(async () => { for await (const line of createInterface({ input: process.stdin })) {
  let message; try { message = JSON.parse(line); } catch { continue; }
  if(message.method==='config/write'||message.method==='config/value/write'||message.method==='thread/start'||message.method==='turn/start')process.exit(23);
  if (message.id === 1) process.stdout.write(JSON.stringify({ id: 1, result: { userAgent: 'fixture-999.0.0' } }) + '\n');
  if (message.id === 2) process.stdout.write(JSON.stringify(process.env.CODLET_PROBE_FIXTURE==='missing-config'
    ?{id:2,error:{code:-32601,message:'Method not found'}}:{ id: 2, result: {config} }) + '\n');
  if (message.id === 3) process.stdout.write(JSON.stringify({ id: 3, result: process.env.CODLET_PROBE_FIXTURE==='malformed-account'?{}:{ account: { type: process.env.CODLET_PROBE_FIXTURE==='default-auth'?'chatgpt':'apiKey', email: 'never-project-this-email' } } }) + '\n');
} })().catch(() => process.exit(1));
setInterval(() => {}, 1000);
