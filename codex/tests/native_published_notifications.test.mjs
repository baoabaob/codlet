import test from 'node:test';
import assert from 'node:assert/strict';
import {publishedNotificationExports,nativePublishedNotifications} from '../frontend/src/desktop/native-published-notifications.js';
import {nativePublisherSource,publishedFixture} from './support/native-published-fixture.mjs';
const selection=publishedNotificationExports(nativePublisherSource);

test('published notification selection proves the singleton constructor and its lexical Native postbox',()=>{
  assert.deepEqual(selection,{constructor:'NativeBus',postbox:'Transport',bus:'PublishedMessages'});
  for(const source of [nativePublisherSource.replace('postbox.postMessage','unrelated.postMessage'),nativePublisherSource.replace('dispatchMessage(type,payload){','dispatchMessage(type,payload){const postbox=other;'),nativePublisherSource.replace('stream=Dispatcher.getInstance()','stream=foreign.getInstance()')])
    assert.throws(()=>publishedNotificationExports(source),{code:'desktop_notification_stream_drift'});
});

test('one published stream preserves exact notification objects and order while filtering other hosts and methods',()=>{
  const f=publishedFixture();f.namespace.NativeBus.getInstance=()=>assert.fail('Core must not create or retrieve a Native singleton');
  const events=[],stream=nativePublishedNotifications({...f,selection,check(){}}),native=[];
  const nativeRelease=f.bus.subscribe('mcp-notification',value=>native.push(value));
  const release=stream.subscribe(['thread/started','turn/started','item/started','serverRequest/resolved'],value=>events.push(value));
  const messages=['thread/started','turn/started','item/started','serverRequest/resolved'].map(method=>({type:'mcp-notification',hostId:'local',method,params:{thread:{id:'main'},threadId:'main'}}));
  for(const message of [{...messages[0],hostId:'remote'},...messages,{...messages[0],method:'ignored'}])f.bus.deliverMessage('mcp-notification',message);
  assert.deepEqual(events,messages);messages.forEach((message,index)=>assert.equal(events[index],message));
  release();release();f.bus.deliverMessage('mcp-notification',messages[0]);assert.equal(events.length,4);assert.equal(native.length,7);
  assert.equal(f.bus.handlers.get('mcp-notification').size,1);nativeRelease();
});

test('owner retirement removes only the Core listener and never throws into Native dispatch',()=>{
  const f=publishedFixture(),original=new Error('owner retired'),errors=[];let alive=true,received=0,native=0;
  const stream=nativePublishedNotifications({...f,selection,check(){if(!alive)throw original;}});
  const release=stream.subscribe(['thread/started'],()=>received++,error=>errors.push(error));
  f.bus.subscribe('mcp-notification',()=>native++);alive=false;
  assert.doesNotThrow(()=>f.bus.deliverMessage('mcp-notification',{hostId:'local',method:'thread/started'}));
  assert.equal(received,0);assert.deepEqual(errors,[original]);assert.equal(native,1);assert.equal(f.bus.handlers.get('mcp-notification').size,1);release();
});

test('replaced singleton or descriptor getters cannot be treated as the original stream',()=>{
  const f=publishedFixture(),stream=nativePublishedNotifications({...f,selection,check(){}});f.namespace.NativeBus.instance={};
  assert.throws(()=>stream.check(),{code:'desktop_notification_stream_drift'});
  f.namespace.NativeBus.instance=f.bus;let reads=0;Object.defineProperty(f.bus,'initialized',{get(){reads++;return true;}});
  assert.throws(()=>stream.check(),{code:'desktop_notification_stream_drift'});assert.equal(reads,0);
});

test('failed registration leaves an inert Core callback and preserves the Native error',()=>{
  for(const throws of [true,false]){
    const f=publishedFixture(),original=new Error('Native registration failed');let callback,received=0;
    f.namespace.NativeBus.prototype.subscribe=function(type,listener){callback=listener;if(throws)throw original;return null;};
    const stream=nativePublishedNotifications({...f,selection,check(){}});
    assert.throws(()=>stream.subscribe(['thread/started'],()=>received++),error=>throws?error===original:error.code==='desktop_notification_stream_drift');
    assert.doesNotThrow(()=>callback({hostId:'local',method:'thread/started'}));assert.equal(received,0);
  }
});
