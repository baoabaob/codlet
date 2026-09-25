'use strict';
const assert=require('node:assert/strict');
const readline=require('node:readline');
const {connectPlaintextSource}=require('../../runtime/plaintext-source-client.cjs');
const {createHostedInterceptors}=require('../../runtime/host-interceptors.cjs');
const lines=readline.createInterface({input:process.stdin}),messages=lines[Symbol.asyncIterator]();
const read=async()=>JSON.parse((await messages.next()).value),write=value=>process.stdout.write(JSON.stringify(value)+'\n');
const root=new AbortController();
const bytesOf=async body=>{const out=[];for await(const value of body??[])out.push(Buffer.from(value));return Buffer.concat(out);};
(async()=>{
  const endpoints=await read(),client=connectPlaintextSource(endpoints.source);await client.ready;write({ready:true});
  const registration=await read();
  const host=createHostedInterceptors({rootSignal:root.signal,coreRequest:async method=>{
    if(method==='services.traffic.connectPeer')return endpoints.host;
    if(method==='services.traffic.register')return registration;
    throw new Error('unexpected management operation');
  }});
  const bytes=Buffer.alloc(128*1024+3,0x6a);let observed=0,responseObserved=0;
  const hook=await host.registerInterceptor({}, {
    async request(request){assert(!request.headers.some(([name])=>name==='authorization'));assert.deepEqual(await bytesOf(request.body),bytes);observed++;return {request:{body:[Buffer.from('changed:'),bytes]}};},
    async response(response){assert.equal((await bytesOf(response.body)).toString(),'upstream');responseObserved++;return {body:'rewritten:upstream'};},
  });
  const response=await client.interceptHttp({url:'https://allowed.invalid/responses',method:'POST',headers:[['authorization','fixture-secret'],['content-type','text/plain']],body:[bytes]}, {
    async forward(request){assert.equal(request.headers.find(([name])=>name==='authorization')[1],'fixture-secret');assert.deepEqual(await bytesOf(request.body),Buffer.concat([Buffer.from('changed:'),bytes]));return {status:200,headers:[],body:'upstream'};},
  });
  assert.equal((await bytesOf(response.body)).toString(),'rewritten:upstream');await hook.setEnabled(false);
  assert.equal(hook.inspect().exchanges,0);assert.equal(observed,1);assert.equal(responseObserved,1);
  client.close();root.abort();write({completed:true});lines.close();
})().catch(error=>{write({error:error.code||error.message});root.abort();lines.close();process.exitCode=1;});
