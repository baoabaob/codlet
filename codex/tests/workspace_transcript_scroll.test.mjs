import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createTranscriptScroll,nativeTranscriptScrollBinding,transcriptScrollPosition} from '../frontend/src/adapter/workspace-transcript-scroll.js';
const require=createRequire(new URL('../frontend/package.json',import.meta.url)),{JSDOM}=require('jsdom');

function fixture(t){
  const dom=new JSDOM('<div id="mount"><div class="thread-scroll-container"><div data-thread-find-target="conversation"><div data-turn-key="turn-a"><p data-content-search-unit-key="item-a">Reading content</p></div></div></div></div>');
  t.after(()=>dom.window.close());
  const document=dom.window.document,mount=document.getElementById('mount'),scroll=mount.firstElementChild,body=scroll.firstElementChild,turn=body.firstElementChild,unit=turn.firstElementChild;
  let height=2000,view=400,unitTop=600,unitHeight=200,following=false,latestStop,anchorRequest,alive=true,sequence=0;
  const listeners=new Set(),writes=[],reported=[];
  Object.defineProperties(scroll,{scrollHeight:{get:()=>height},clientHeight:{get:()=>Math.round(view)},offsetHeight:{get:()=>Math.round(view)}});
  scroll.style.height=view+'px';
  scroll.getBoundingClientRect=()=>({top:100,bottom:100+view,height:view});
  unit.getBoundingClientRect=()=>({top:100+unitTop-scroll.scrollTop,bottom:100+unitTop+unitHeight-scroll.scrollTop,height:unitHeight});
  const controller={
    getScrollElement:()=>alive?scroll:null,
    getLastScrollDistanceFromBottomPx:()=>Math.max(0,height-scroll.clientHeight-scroll.scrollTop),
    shouldFollowContentGrowth:()=>following,
    holdViewport(){following=false;const stop=latestStop;latestStop=null;stop?.();},
    scrollToBottom({onStop}){writes.push('latest');following=true;latestStop=onStop;},
    scrollToDistanceFromBottomPx(distance,_behavior,origin){writes.push({distance,origin});const previous=controller.getLastScrollDistanceFromBottomPx();scroll.scrollTop=height-scroll.clientHeight-distance;if(distance===0)following=true;if(origin==='user')for(const listener of [...listeners])listener(distance,previous);},
    compensateScrollToDistanceFromBottomPx(distance){writes.push({distance,origin:'compensate'});scroll.scrollTop=height-scroll.clientHeight-distance;},
    addUserScrollListener(listener){listeners.add(listener);return()=>listeners.delete(listener);},
  };
  const api={getEntryGeometry:key=>key==='turn-a'?{startPx:unitTop,endPx:unitTop+unitHeight}:null,scrollToKey(key,target,options){
    assert.equal(key,'turn-a');assert.equal(options.align,'top');
    return new Promise(resolve=>{anchorRequest={id:++sequence,target,options,resolve};options.signal.addEventListener('abort',resolve,{once:true});});
  }};
  function NativeBody(){return 'getVirtualizedTurnListApi';}
  const context={},root={child:null},provider={tag:10,type:context,memoizedProps:{value:controller},return:root},owner={type:NativeBody,memoizedProps:{conversationId:'thread-a'},dependencies:{firstContext:{context,memoizedValue:controller}},memoizedState:{memoizedState:{current:api}},return:provider},leaf={stateNode:body,return:owner};
  root.child=provider;provider.child=owner;owner.child=leaf;mount.__reactContainer$fixture={stateNode:{current:root}};body.__reactFiber$fixture=leaf;
  const handle=createTranscriptScroll({mount,body,scroll,threadId:'thread-a',check(){if(!alive)throw Error('retired');},report:e=>reported.push(e)});
  t.after(()=>handle.dispose());
  return {dom,document,mount,scroll,body,turn,unit,controller,provider,owner,root,handle,writes,listeners,reported,
    setFollowing(value){following=value;},setUnitTop(value){unitTop=value;},setUnitHeight(value){unitHeight=value;},resize(value){view=value;scroll.style.height=value+'px';if(following)scroll.scrollTop=Math.max(0,height-scroll.clientHeight);},grow(value){height=value;if(following)scroll.scrollTop=Math.max(0,height-scroll.clientHeight);},
    finishLatest(){scroll.scrollTop=Math.max(0,height-scroll.clientHeight);const stop=latestStop;latestStop=null;stop?.();},
    request:()=>anchorRequest,
    finishAnchor(request=anchorRequest){if(request.options.signal.aborted)return;const target=request.target(turn);assert.equal(target,unit);controller.scrollToDistanceFromBottomPx(height-scroll.clientHeight-unitTop+10,'instant','user');request.resolve();},
    userScroll(top){following=false;scroll.scrollTop=top;for(const listener of [...listeners])listener(controller.getLastScrollDistanceFromBottomPx(),0);},
  };
}

test('latest intent uses the Native controller completion and survives subsequent Native measurement and viewport resize',async t=>{
  const f=fixture(t);f.scroll.scrollLeft=9;const pending=f.handle.latest();let done=false;pending.then(()=>done=true);
  await Promise.resolve();assert.equal(done,false);assert.deepEqual(f.writes,['latest']);assert.equal(f.handle.capture().followingLatest,true);
  f.finishLatest();await pending;assert.equal(f.scroll.scrollTop,1600);assert.equal(f.scroll.scrollLeft,9);assert.equal(f.listeners.size,0);
  f.grow(3100);assert.equal(f.scroll.scrollTop,2700);f.resize(600);assert.equal(f.scroll.scrollTop,2500);
  assert.deepEqual(f.writes,['latest'],'Core does not run a resize/scroll-to-bottom loop');
});

test('saved tail resumes Native following while explicit history retains its semantic content anchor after reflow',async t=>{
  const f=fixture(t);f.setFollowing(true);f.scroll.scrollTop=1600;const tail=f.handle.capture();
  assert.equal(tail.followingLatest,true);f.grow(3500);f.resize(500);f.setFollowing(false);
  const resumed=f.handle.restore(tail);f.finishLatest();await resumed;assert.equal(f.scroll.scrollTop,3000);
  f.setFollowing(false);f.scroll.scrollTop=650;const history=f.handle.capture();
  assert.deepEqual(history.anchor,{turnKey:'turn-a',unitKey:'item-a',offset:-50});
  f.setUnitTop(1100);f.scroll.scrollTop=0;
  const restored=f.handle.restore(history);assert.deepEqual(f.handle.capture(),history,'pending restore retains its requested state');
  f.finishAnchor();await restored;assert.equal(f.scroll.scrollTop,1150);assert.equal(f.handle.capture().followingLatest,false);assert.equal(f.listeners.size,0);
});

test('Native user scrolling including a scrollbar move cancels old history restoration without late writes',async t=>{
  const f=fixture(t);f.scroll.scrollTop=650;const history=f.handle.capture();f.scroll.scrollTop=0;
  const restored=f.handle.restore(history),request=f.request();f.userScroll(320);
  await assert.rejects(restored,{code:'workspace_scroll_cancelled'});assert.equal(request.options.signal.aborted,true);
  const writes=f.writes.length;f.finishAnchor(request);await Promise.resolve();assert.equal(f.writes.length,writes);assert.equal(f.scroll.scrollTop,320);assert.equal(f.listeners.size,0);
});

test('restoring a held reading anchor at the physical bottom does not enable Native following',async t=>{
  const f=fixture(t);f.setUnitTop(1600);f.scroll.scrollTop=1600;
  const history=f.handle.capture();assert.equal(history.followingLatest,false);assert.ok(history.anchor);
  f.scroll.scrollTop=0;const restoring=f.handle.restore(history);f.finishAnchor();await restoring;
  assert.equal(f.scroll.scrollTop,1600);assert.equal(f.handle.capture().followingLatest,false);
  f.grow(3000);assert.equal(f.scroll.scrollTop,1600);
});

test('fractional pane heights do not turn layout rounding into a reading-anchor zoom factor',async t=>{
  const f=fixture(t);f.grow(12000);f.setUnitHeight(10000);f.resize(400.5);f.scroll.scrollTop=6400;
  const history=f.handle.capture();assert.equal(history.anchor.offset,-5800);
  f.resize(300.25);f.scroll.scrollTop=0;const pending=f.handle.restore(history);f.finishAnchor();await pending;
  assert.equal(f.unit.getBoundingClientRect().top-f.scroll.getBoundingClientRect().top,-5800);
  assert.equal(f.handle.capture().followingLatest,false);
});

test('wheel intent cancels pending latest and new explicit restore supersedes the old Native request',async t=>{
  const f=fixture(t),latest=f.handle.latest();f.scroll.dispatchEvent(new f.dom.window.WheelEvent('wheel',{bubbles:true}));
  await assert.rejects(latest,{code:'workspace_scroll_cancelled'});assert.equal(f.listeners.size,0);
  f.scroll.scrollTop=650;const history=f.handle.capture(),first=f.handle.restore(history),old=f.request(),second=f.handle.latest();
  await assert.rejects(first,{code:'workspace_scroll_cancelled'});assert.equal(old.options.signal.aborted,true);
  f.finishAnchor(old);f.finishLatest();await second;assert.equal(f.handle.capture().followingLatest,true);assert.equal(f.listeners.size,0);
});

test('owner disposal stops pending Native requests and removes all continuation listeners',async t=>{
  const f=fixture(t);f.scroll.scrollTop=650;const pending=f.handle.restore(f.handle.capture()),request=f.request();f.handle.dispose();
  await assert.rejects(pending,{code:'workspace_scroll_cancelled'});assert.equal(f.listeners.size,0);const count=f.writes.length;
  f.finishAnchor(request);await Promise.resolve();assert.equal(f.writes.length,count);assert.throws(()=>f.handle.capture(),{code:'workspace_scroll_retired'});
});

test('a Native context projection may change without retiring its actual controller, but a replaced provider cannot receive a late write',async t=>{
  const f=fixture(t),pending=f.handle.latest(),projection={...f.controller,isScrolledFromBottom:false};
  f.provider.memoizedProps.value=projection;f.owner.dependencies.firstContext.memoizedValue=projection;
  f.finishLatest();await pending;
  f.setFollowing(false);f.scroll.scrollTop=650;const restoring=f.handle.restore(f.handle.capture()),request=f.request();
  const next={...f.provider,alternate:null};next.child=f.owner;f.root.child=next;f.owner.return=next;
  const before=f.writes.length;
  assert.throws(()=>f.finishAnchor(request),{code:'workspace_scroll_owner_changed'});await assert.rejects(restoring,{code:'workspace_scroll_owner_changed'});
  assert.equal(f.writes.length,before);
});

test('controller discovery follows only the current transcript ancestry and rejects another scroller and retired links',t=>{
  const f=fixture(t);f.owner.dependencies.firstContext.next={memoizedValue:{...f.controller,getScrollElement:()=>f.document.createElement('div')}};
  f.owner.dependencies.firstContext.next.next=f.owner.dependencies.firstContext;
  assert.equal(nativeTranscriptScrollBinding({mount:f.mount,body:f.body,scroll:f.scroll,threadId:'thread-a'}).controller,f.controller);
  f.provider.child=null;
  assert.throws(()=>nativeTranscriptScrollBinding({mount:f.mount,body:f.body,scroll:f.scroll,threadId:'thread-a'}),{code:'workspace_scroll_owner_changed'});
});

test('repeated outer context providers keep the nearest lexical scroll owner',t=>{
  const f=fixture(t),outer={...f.provider,child:f.provider,return:f.root};f.root.child=outer;f.provider.return=outer;
  assert.equal(nativeTranscriptScrollBinding({mount:f.mount,body:f.body,scroll:f.scroll,threadId:'thread-a'}).owner,f.provider);
});

test('legacy finite offsets remain valid and malformed semantic states fail before a scroll dispatch',async t=>{
  const f=fixture(t);await f.handle.restore({top:123,left:-5});assert.equal(f.scroll.scrollTop,123);assert.equal(f.scroll.scrollLeft,-5);
  assert.deepEqual(transcriptScrollPosition({top:-41,left:-9}),{top:-41,left:-9});
  const before=f.writes.length;
  for(const value of [{top:0,left:0,followingLatest:'yes'},{top:0,left:0,anchor:{turnKey:'turn-a',unitKey:'item-a',offset:NaN}},{top:0,left:0,anchor:{turnKey:'',unitKey:'item-a',offset:0}},{top:0,left:0,extra:true}])assert.throws(()=>f.handle.restore(value),{code:'invalid_argument'});
  assert.equal(f.writes.length,before);
});
