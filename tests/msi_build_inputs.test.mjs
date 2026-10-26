import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import test from 'node:test';

test('MSI builder refuses an existing delivery or build tree before compiling helpers',t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'codlet-msi-input-'));
  t.after(()=>fs.rmSync(directory,{recursive:true}));
  const builder=new URL('../scripts/build-msi.mjs',import.meta.url);
  for(const existing of ['delivery','receipt','build']){
    const output=path.join(directory,existing+'.msi'),marker=existing==='delivery'?output:existing==='receipt'?output+'.json':path.join(output+'.build','keep');
    if(existing==='build')fs.mkdirSync(output+'.build');
    fs.writeFileSync(marker,'preserve original');
    const result=spawnSync(process.execPath,[fileURLToPath(builder),path.join(directory,'missing-input'),path.join(directory,'missing-wix'),output],{encoding:'utf8',windowsHide:true});
    assert.notEqual(result.status,0);assert.match(result.stderr,/must be fresh/);
    assert.equal(fs.readFileSync(marker,'utf8'),'preserve original');
    assert.equal(fs.existsSync(path.join(output+'.build','Codlet-Installer-Preflight.exe')),false);
  }
});
