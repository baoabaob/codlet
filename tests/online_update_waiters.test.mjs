import test from 'node:test';
import assert from 'node:assert/strict';
import {getEventListeners} from 'node:events';
import {createRequire} from 'node:module';
const {createWriteLedger}=createRequire(import.meta.url)('../runtime/online-update.cjs');
test('Core admission waiters detach their original abort listener on every terminal owner path',async()=>{
  for(const outcome of ['resume','close','abort']) {
    const controller=new AbortController(),ledger=createWriteLedger({getEpoch:()=>1});ledger.pause();
    const waiting=ledger.whenAccepting(controller.signal);
    assert.equal(getEventListeners(controller.signal,'abort').length,1);assert.equal(ledger.inspect().waiting,1);
    const done=outcome==='resume'?waiting:assert.rejects(waiting,{code:outcome==='close'?'core_write_owner_closed':'core_write_cancelled'});
    if(outcome==='abort')controller.abort();else ledger[outcome]();
    await done;assert.equal(getEventListeners(controller.signal,'abort').length,0);assert.equal(ledger.inspect().waiting,0);ledger.close();
  }
});
