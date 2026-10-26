import assert from 'node:assert/strict';
import net from 'node:net';
import { createRequire } from 'node:module';
import { getEventListeners } from 'node:events';
import test from 'node:test';
const require = createRequire(import.meta.url);
const { createTrafficStreams, connectTrafficPeer, listenTrafficPeer } = require('../runtime/traffic-wire.cjs');
const packet = value => { const bytes=Buffer.from(JSON.stringify(value)), result=Buffer.alloc(bytes.length+4); result.writeUInt32BE(bytes.length); bytes.copy(result,4); return result; };
const delay = ms => new Promise(resolve=>setTimeout(resolve,ms));

test('aborting a source listener while it binds retires the listener', async () => {
  const root = new AbortController();
  const opening = listenTrafficPeer({ signal: root.signal, handle: () => null });
  root.abort();
  await assert.rejects(opening, { code: 'host_stopping' });
});

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

test('authenticated Native streams pass existing content beyond plugin budgets with bounded chunks', async () => {
  const root = new AbortController(), chunk = Buffer.alloc(32 * 1024, 5);
  let source, sink;
  source = createTrafficStreams({}, 'native', root.signal, { native: true });
  sink = createTrafficStreams({ request: async (_method, params) => source.handle(params.operation, params.payload) }, 'native', root.signal, { native: true });
  const make = () => (function* () { for (let index = 0; index < 2049; index++) yield chunk; })();
  let received = 0;
  for await (const value of sink.importBody(source.exportBody(make()))) { assert(value.length <= chunk.length); received += value.length; }
  assert.equal(received, 64 * 1024 * 1024 + chunk.length);
  assert.equal(source.status().streams, 0);
  const plugin = createTrafficStreams({}, 'plugin', root.signal), reference = plugin.exportBody(make());
  for (let index = 0; index < 2048; index++) await plugin.handle('stream.read', reference);
  await assert.rejects(plugin.handle('stream.read', reference), { code: 'body_too_large' });
  const stalled = source.exportBody((function* () { while (true) yield Buffer.alloc(0); })());
  const read = source.handle('stream.read', stalled);
  setImmediate(() => root.abort());
  await assert.rejects(read, { code: 'stream_retired' });
  assert.equal(source.status().streams, 0);
  plugin.dispose(); sink.dispose();
});

test('stream cancellation settles a stalled read even when the producer ignores return', async () => {
  const root=new AbortController();
  const source=createTrafficStreams({},'lease',root.signal);
  const reference=source.exportBody({[Symbol.asyncIterator](){return {next:()=>new Promise(()=>{}),return:()=>new Promise(()=>{})};}});
  const read=source.handle('stream.read',reference);
  await delay(0); assert.deepEqual(await source.handle('stream.cancel',reference),{cancelled:true});
  await assert.rejects(read,{code:'stream_retired'}); assert.equal(source.status().streams,0); source.dispose();
});

test('cancelAndWait preserves one cancellation result and distinguishes explicit retirement from lost peers',async()=>{
  for(const code of ['peer_closed','request_cancelled','underlying_cleanup_failed']) {
    const root=new AbortController(),error=Object.assign(Error(code),{code});let calls=0;
    const streams=createTrafficStreams({request(){calls++;return Promise.reject(error);}},'lease',root.signal);
    const body=streams.importBody({stream:'a'.repeat(32)});assert.equal(body.cancel(),true);
    const first=body.cancelAndWait();assert.equal(body.cancelAndWait(),first);
    await assert.rejects(first,value=>value===error);assert.equal(calls,1);streams.dispose();
  }
  for(const reply of [{cancelled:true},Object.assign(Error('closed'),{code:'stream_retired'})]) {
    const root=new AbortController(),streams=createTrafficStreams({request:()=>reply instanceof Error?Promise.reject(reply):Promise.resolve(reply)},'lease',root.signal);
    await streams.importBody({stream:'a'.repeat(32)}).cancelAndWait();streams.dispose();
  }
  const root=new AbortController(),error=Error('producer cleanup failed');let calls=0;
  const streams=createTrafficStreams({},'lease',root.signal),reference=streams.exportBody({[Symbol.iterator]:function*(){},cancelAndWait(){calls++;return Promise.reject(error);}});
  await assert.rejects(streams.handle('stream.cancel',reference),value=>value===error);
  await assert.rejects(streams.handle('stream.cancel',reference),value=>value===error);assert.equal(calls,1);assert.equal(streams.status().streams,1);streams.dispose();
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

test('aborted open sends ordered cancellation even before the Native lease result is delivered', { timeout: 5000 }, async t => {
  const root = new AbortController(), requestAbort = new AbortController();
  let opening, notified; const cancellation = new Promise(resolve => { notified = resolve; });
  const server = net.createServer(socket => {
    t.after(() => socket.destroy()); let buffer = Buffer.alloc(0), authenticated = false;
    socket.on('data', bytes => {
      buffer = Buffer.concat([buffer, bytes]);
      while (buffer.length >= 4 && buffer.length >= buffer.readUInt32BE() + 4) {
        const size = buffer.readUInt32BE(), value = JSON.parse(buffer.subarray(4, size + 4)); buffer = buffer.subarray(size + 4);
        if (!authenticated) { authenticated = true; socket.write(packet({ event: 'connected' })); }
        else if (value.method === 'open') { opening = value.id; requestAbort.abort(); }
        else if (value.method === 'cancelOpen') {
          assert.equal(value.params.request, opening);
          socket.write(packet({ id: opening, result: { lease: 'never-delivered' } })); notified();
        }
      }
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => server.close());
  const peer = await connectTrafficPeer({ host: '127.0.0.1', port: server.address().port, token: 'fixture' }, { signal: root.signal });
  t.after(() => root.abort()); let delivered = false;
  await assert.rejects(peer.request('open', {}, { cancelOpen: true, signal: requestAbort.signal, prepareResult: () => { delivered = true; } }), { code: 'request_cancelled' });
  await cancellation; await delay(10);
  assert.equal(delivered, false); assert.equal(peer.status().pending, 0);
});

test('Native control admission queues existing calls, cancels queued work and dispatches each accepted call once', async t => {
  const root=new AbortController(), queuedAbort=new AbortController();
  const received=[], replies=[];
  const listener=await listenTrafficPeer({signal:root.signal,handle:async(_peer,method)=>{
    received.push(method); return new Promise(resolve=>replies.push(resolve));
  }});
  t.after(()=>root.abort());
  const peer=await connectTrafficPeer({...listener.endpoint,maxPendingRequests:1},{signal:root.signal,queueRequests:true});
  const first=peer.request('first',{}, {timeoutMs:null}), cancelled=peer.request('cancelled',{}, {timeoutMs:null,signal:queuedAbort.signal}), second=peer.request('second',{}, {timeoutMs:null});
  const rejected=assert.rejects(cancelled,{code:'request_cancelled'}); queuedAbort.abort(); await rejected;
  while(!replies.length)await delay(0);
  assert.deepEqual(received,['first']); replies.shift()({done:1}); await first;
  while(!replies.length)await delay(0);
  assert.deepEqual(received,['first','second']); replies.shift()({done:2}); await second;
  assert.equal(peer.status().pending,0);
});

test('Native body reads use owner cancellation while plugin readers retain their explicit wait budget',async()=>{
  for(const native of [true,false]) {
    const root=new AbortController();let options;
    const streams=createTrafficStreams({request(_method,_params,input){options=input;return new Promise((_,reject)=>input.signal.addEventListener('abort',()=>reject(Object.assign(Error(),{code:'request_cancelled'})),{once:true}));}},'lease',root.signal,{native});
    const body=streams.importBody({stream:'a'.repeat(32)}),read=body[Symbol.asyncIterator]().next();
    assert.equal(options.timeoutMs,native?null:300000);root.abort();await assert.rejects(read,{code:'request_cancelled'});
  }
});
