import assert from 'node:assert/strict';
import net from 'node:net';
import { createRequire } from 'node:module';
import { getEventListeners } from 'node:events';
import test from 'node:test';
const require = createRequire(import.meta.url);
const { createTrafficStreams, connectTrafficPeer } = require('../runtime/traffic-wire.cjs');
const packet = value => { const bytes=Buffer.from(JSON.stringify(value)), result=Buffer.alloc(bytes.length+4); result.writeUInt32BE(bytes.length); bytes.copy(result,4); return result; };
const delay = ms => new Promise(resolve=>setTimeout(resolve,ms));

test('data stream handles are one-shot, chunk bounded, binary exact and released at EOF', async () => {
  const root = new AbortController();
  let source, sink, calls=0;
  const a={request:async(_method,p)=>{calls++;return sink.handle(p.operation,p.payload);}}, b={request:async(_method,p)=>{calls++;return source.handle(p.operation,p.payload);}};
  source=createTrafficStreams(a,'lease',root.signal); sink=createTrafficStreams(b,'lease',root.signal);
  const bytes=Buffer.alloc(128*1024); for(let i=0;i<bytes.length;i++)bytes[i]=i%256;
  const body=sink.importBody(source.exportBody(bytes)), chunks=[];
  for await(const chunk of body) { assert(chunk.length<=32*1024); chunks.push(chunk); }
  assert.deepEqual(Buffer.concat(chunks),bytes); assert.equal(calls,5); assert.equal(source.status().streams,0);
  assert.throws(()=>body[Symbol.asyncIterator](),{code:'body_already_consumed'});
  for(const frame of [{binary:false,data:'你好'},{binary:true,data:Buffer.alloc(0)}]) assert.deepEqual(await sink.importFrame(source.exportFrame(frame)),frame);
  source.dispose(); sink.dispose(); assert.equal(getEventListeners(root.signal,'abort').length,0);
});

test('stream cancellation settles a stalled read even when the producer ignores return', async () => {
  const root=new AbortController();
  const source=createTrafficStreams({},'lease',root.signal);
  const reference=source.exportBody({[Symbol.asyncIterator](){return {next:()=>new Promise(()=>{}),return:()=>new Promise(()=>{})};}});
  const read=source.handle('stream.read',reference);
  await delay(0); assert.deepEqual(await source.handle('stream.cancel',reference),{cancelled:true});
  await assert.rejects(read,{code:'stream_retired'}); assert.equal(source.status().streams,0); source.dispose();
});

test('empty producers and cross-lease handles fail without an unbounded loop or lookup', async () => {
  const root=new AbortController(), source=createTrafficStreams({},'a',root.signal), other=createTrafficStreams({},'b',root.signal);
  const ref=source.exportBody((function*(){while(true)yield Buffer.alloc(0);})());
  await assert.rejects(other.handle('stream.read',ref),{code:'stream_retired'});
  await assert.rejects(source.handle('stream.read',ref),{code:'invalid_body'});
  source.dispose(); other.dispose();
});

test('peer installs response receipts before a coalesced retirement and rejects oversized frames', {timeout:5000}, async t => {
  const server=net.createServer(), sockets=new Set();
  server.on('connection',socket=>{
    sockets.add(socket); socket.once('close',()=>sockets.delete(socket)); let buffer=Buffer.alloc(0), authenticated=false;
    socket.on('data',chunk=>{
      buffer=Buffer.concat([buffer,chunk]);
      while(buffer.length>=4&&buffer.length>=buffer.readUInt32BE()+4){const size=buffer.readUInt32BE(), value=JSON.parse(buffer.subarray(4,size+4));buffer=buffer.subarray(size+4);
        if(!authenticated){assert.equal(value.token,'fixture');authenticated=true;socket.write(packet({event:'connected'}));}
        else if(value.method==='open')socket.write(Buffer.concat([packet({id:value.id,result:{lease:'owned'}}),packet({event:'leaseClosed',lease:'owned'})]));
        else if(value.method==='bad'){const prefix=Buffer.alloc(4);prefix.writeUInt32BE(65537);socket.write(prefix);}
      }
    });
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>{for(const socket of sockets)socket.destroy();server.close();});
  const root=new AbortController(), order=[];
  const peer=await connectTrafficPeer({host:'127.0.0.1',port:server.address().port,token:'fixture'},{signal:root.signal,event:event=>order.push(event.event)});
  t.after(()=>peer.close());
  await peer.request('open',{}, {prepareResult:()=>order.push('receipt')});
  assert.deepEqual(order,['receipt','leaseClosed']);
  await assert.rejects(peer.request('bad'),{code:'invalid_frame'}); assert.equal(peer.status().pending,0); assert.equal(peer.status().queuedBytes,0);
});
