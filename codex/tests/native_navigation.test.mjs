import test from 'node:test';
import assert from 'node:assert/strict';
import {reviewedNavigator} from '../frontend/src/native-navigation.js';

test('data router navigation tracks committed locations and owns removable subscriptions',async()=>{
  const listeners=new Set(),calls=[],navigator={push(){},replace(){},go(){}},
    router={routes:[{id:'root',path:'*'}],state:{location:{pathname:'/'}},
      navigate(...args){calls.push(args);return Promise.resolve();},
      subscribe(fn){listeners.add(fn);return()=>listeners.delete(fn);}};
  const locate=()=>reviewedNavigator(new Set([navigator]),new Set([{navigator,router}]));
  const bridge=locate();assert.equal(locate(),bridge);assert.equal(bridge.location,router.state.location);
  let events=0;const stop=bridge.listen(()=>events++);
  for(const fn of listeners)fn({...router.state,navigation:{state:'loading'}});
  assert.equal(events,0);
  router.state={location:{pathname:'/local/fixture'},historyAction:'PUSH'};
  for(const fn of listeners)fn(router.state);
  assert.equal(events,1);assert.equal(bridge.location.pathname,'/local/fixture');
  await bridge.push('/codlet/demo',{fixture:true});await bridge.replace('/');await bridge.go(-1);
  assert.deepEqual(calls, [['/codlet/demo',{state:{fixture:true}}],['/',{replace:true,state:undefined}],[-1]]);
  stop();assert.equal(listeners.size,0);
  router.navigate=()=>Promise.resolve();assert.equal(locate(),null,'replaced native methods invalidate the bridge');
});

test('unreviewed or ambiguous native router shapes do not acquire a navigation bridge',()=>{
  const navigator={},router={routes:[{path:'/different-root'}],state:{location:{pathname:'/'}},navigate(){},subscribe(){}};
  assert.equal(reviewedNavigator(new Set([navigator]),new Set([{navigator,router}])),null);
  router.routes=[{path:'*'}];
  assert.equal(reviewedNavigator(new Set([navigator,{}]),new Set([{navigator,router}])),null);
  assert.equal(reviewedNavigator(new Set([navigator]),new Set([{navigator,router},{navigator,router:{...router}}])),null);
});
