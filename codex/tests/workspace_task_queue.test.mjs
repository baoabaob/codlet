import test from 'node:test';
import assert from 'node:assert/strict';
import {createWorkspaceTaskQueue} from '../frontend/src/adapter/workspace-task-queue.js';
test('continuous hidden commits yield to input tasks after the first startup microtask',()=>{
  const microtasks=[],tasks=[];let closed=0;
  const queue=createWorkspaceTaskQueue({microtask:fn=>microtasks.push(fn),channel:()=>{
    const port1={close(){closed++;}},port2={postMessage:id=>tasks.push(()=>port1.onmessage({data:id})),close(){closed++;}};return{port1,port2};
  }});
  let renders=0;const render=()=>{renders++;if(renders<60)queue.post(render);};
  queue.post(render);assert.equal(microtasks.length,1);microtasks.shift()();
  assert.equal(renders,1);assert.equal(microtasks.length,0);assert.equal(tasks.length,1);
  const input=[];tasks.unshift(()=>input.push('pointer'));tasks.shift()();assert.deepEqual(input,['pointer']);
  while(tasks.length)tasks.shift()();assert.equal(renders,60);assert.equal(microtasks.length,0);
  queue.clear();assert.equal(closed,2);
});
test('retiring a hidden queue discards both queued phases and a new owner gets one startup microtask',()=>{
  const microtasks=[],tasks=[];const queue=createWorkspaceTaskQueue({microtask:fn=>microtasks.push(fn),channel:()=>{
    const port1={close(){}},port2={postMessage:id=>tasks.push(()=>port1.onmessage({data:id})),close(){}};return{port1,port2};
  }});
  let calls=0;queue.post(()=>calls++);queue.post(()=>calls++);queue.clear();
  microtasks.shift()();tasks.shift()();assert.equal(calls,0);
  queue.post(()=>calls++);microtasks.shift()();assert.equal(calls,1);queue.clear();
});
