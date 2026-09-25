import assert from 'node:assert/strict';
import test from 'node:test';
import { nativeTraffic, bodyBytes, idle } from './support/native-traffic.mjs';
const origin='https://fixture.invalid',alternate='https://alternate.invalid';
async function setup(t, options={}) {
  const f=await nativeTraffic(t,{origins:[origin,alternate],...options}), client=f.client();await client.ready;const forwarded=[];
  const request={url:origin+'/responses?private=fixture',method:'POST',headers:[['authorization','Bearer fixture'],['x-vendor-secret','fixture'],['content-type','text/plain']],body:'request'};
  const run=()=>client.interceptHttp(request,{forward:async input=>{forwarded.push({...input,body:await bodyBytes(input.body)});return {status:200,headers:[['set-cookie','fixture']],body:'response'};}});
  return {f,client,request,run,forwarded,register:(id,handlers,options={})=>f.runtime().api.registerInterceptor({id,origins:[origin],...options},handlers)};
}

test('first terminal decision wins and later plugins cannot observe a blocked request',async t=>{
  const s=await setup(t);let responses=0;
  await s.register('block',{request:()=>({block:true}),response:(_r,c)=>{assert.equal(c.source,'synthetic');responses++;}},{priority:-10});
  await s.register('later',{request:()=>assert.fail('must not run')});
  const result=await s.run();assert.equal(result.status,403);await bodyBytes(result.body);assert.equal(s.forwarded.length,0);assert.equal(responses,1);await idle(s.f);
});
for(const permitted of [false,true])test(`cross-origin redirects ${permitted?'strip all unapproved credential headers':'require a separate permission'}`,async t=>{
  const s=await setup(t,{sensitive:permitted});
  await s.register('redirect',{request:()=>({request:{url:alternate+'/responses'}})},{priority:-10});
  await s.register('observer',{request:()=>assert.fail('redirect cannot broaden another observer scope')});
  if(permitted){const result=await s.run();await bodyBytes(result.body);assert.deepEqual(s.forwarded[0].headers,[['content-type','text/plain']]);}
  else{await assert.rejects(s.run(),{code:'permission_denied'});assert.equal(s.forwarded.length,0);}
  await idle(s.f);
});
test('unprivileged header changes preserve hidden credentials and cannot inject new ones',async t=>{
  const s=await setup(t);let inject=false;
  await s.register('headers',{request(input){assert(!input.headers.some(([n])=>n==='authorization'));return {request:{headers:inject?[['Authorization','other']]:[['content-type','application/json']]}};},response(value){assert(!value.headers.some(([n])=>n==='set-cookie'));}});
  const response=await s.run();await bodyBytes(response.body);
  assert.deepEqual(s.forwarded[0].headers,[['content-type','application/json'],['authorization','Bearer fixture'],['x-vendor-secret','fixture']]);
  inject=true;await assert.rejects(s.run(),{code:'permission_denied'});await idle(s.f);
});
for(const permitted of [false,true])test(`synthetic responses ${permitted?'use':'cannot bypass'} the sensitive-header grant`,async t=>{
  const s=await setup(t,{sensitive:permitted});await s.register('synthetic',{request:()=>({respond:{status:200,headers:[['set-cookie','fixture']],body:'synthetic'}})});
  if(permitted){const response=await s.run();assert.equal((await bodyBytes(response.body)).toString(),'synthetic');assert.deepEqual(response.headers,[['set-cookie','fixture']]);}
  else await assert.rejects(s.run(),{code:'permission_denied'});
  assert.equal(s.forwarded.length,0);await idle(s.f);
});
for(const mode of ['disable','retire','timeout'])test(`interceptor ${mode} cancels active callbacks and releases capacity`,{timeout:15000},async t=>{
  const s=await setup(t);let enter;const started=new Promise(r=>enter=r);
  const hook=await s.register('pending',{request:()=>{enter();return new Promise(()=>{});}},{timeoutMs:50});
  const failed=assert.rejects(s.run());await started;
  if(mode==='disable')await hook.setEnabled(false);if(mode==='retire')await s.f.call('retire');
  await failed;await idle(s.f);assert.equal(s.forwarded.length,0);
});
test('private callback exception messages and invented codes never enter traffic responses',async t=>{
  const s=await setup(t);await s.register('failure',{request(){throw Object.assign(new Error('private token'),{code:'private-token'});}});
  await assert.rejects(s.run(),e=>e.code==='traffic_callback_failed'&&!String(e).includes('private'));await idle(s.f);
});
test('large binary bodies cross the Host data plane once and remain byte exact',async t=>{
  const s=await setup(t),bytes=Buffer.alloc(128*1024+3,0xff);s.request.body=bytes;
  let callbackError;
  await s.register('binary',{async request(r){try {assert.deepEqual(await bodyBytes(r.body),bytes);return {request:{body:[Buffer.from('changed:'),bytes]}};}catch(error){callbackError=error;throw error;}},async response(r){try{return {body:[await bodyBytes(r.body),bytes]};}catch(error){callbackError=error;throw error;}}});
  const response=await s.run().catch(error=>{throw new Error((callbackError??error).code+' '+s.f.stderr(),{cause:callbackError??error});});assert.deepEqual(await bodyBytes(response.body),Buffer.concat([Buffer.from('response'),bytes]));assert.deepEqual(s.forwarded[0].body,Buffer.concat([Buffer.from('changed:'),bytes]));await idle(s.f);
});
