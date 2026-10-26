import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import test from 'node:test';
const host=createRequire(import.meta.url)('../examples/http-channel/host.js');
test('channel example does not copy incoming authentication through WebSocket subprotocols',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'codlet-channel-example-'));
  t.after(()=>fs.rmSync(root,{recursive:true}));
  fs.writeFileSync(path.join(root,'settings.json'),JSON.stringify({origin:'https://example.test',cwd:root}));
  let handlers,forwarded;
  await host.activate({root,plugin:{id:'example.http-channel'},rpc:{provide(){}},traffic:{async openChannel(_options,value){handlers=value;return{async close(){}};}}});
  try{
    await handlers.webSocket({path:'/v1/responses',protocols:['secret-token'],headers:[['Authorization','Bearer secret'],['Cookie','secret'],['Sec-WebSocket-Protocol','secret-token'],['X-Fixture','kept']]},{async forward(value){forwarded=value;}});
    assert.equal(forwarded.url,'wss://example.test/v1/responses');
    assert.equal(forwarded.protocols,undefined);
    assert.deepEqual(forwarded.headers,[['X-Fixture','kept']]);
  }finally{await host.deactivate();}
});
