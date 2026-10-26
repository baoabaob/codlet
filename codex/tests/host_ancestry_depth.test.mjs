import test from 'node:test';
import assert from 'node:assert/strict';
import { currentAncestry, currentElementAncestry } from '../frontend/src/host-discovery.js';

function tree(depth) {
  const root={},oldRoot={},element={},container={stateNode:{current:root}};
  root.alternate=oldRoot;oldRoot.alternate=root;
  let current=root,old=oldRoot;
  for(let index=1;index<depth;index++){
    const child={return:current},alternate={return:old};
    child.alternate=alternate;alternate.alternate=child;
    current.child=child;old.child=alternate;current=child;old=alternate;
  }
  current.stateNode=old.stateNode=element;element.__reactFiber$test=old;
  return {root,oldRoot,current,element,domRoot:{__reactContainer$test:container}};
}

test('main composer ownership survives Native shells deeper than 256 ancestors',()=>{
  for(const depth of [259,300,1100,4000]){
    const f=tree(depth),chain=currentElementAncestry(f.element,f.domRoot);
    assert.equal(chain.length,depth);assert.equal(chain[0],f.current);assert.equal(chain.at(-1),f.root);
    // Child reuse keeps a previous return edge while the current parent owns it.
    const parent=f.current.return;parent.alternate.child=f.current;f.current.return=parent.alternate;
    assert.ok(currentAncestry(f.current,f.root));
    parent.child=null;parent.alternate.child=null;
    assert.equal(currentAncestry(f.current,f.root),null);
  }
});
test('ancestry proof rejects cyclic or disconnected graphs without an arbitrary traversal cutoff',()=>{
  const a={},b={return:a};a.return=b;a.child=b;b.child=a;
  assert.equal(currentAncestry(a,{}),null);
  const stale={return:{child:null,return:{}}};assert.equal(currentAncestry(stale,stale.return.return),null);
});
