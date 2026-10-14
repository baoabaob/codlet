// Test-driver bootstrap only. The packaged plugin uses public Core/adapter APIs.
import fs from 'node:fs';
import {createRequire} from 'node:module';
const output=process.argv[2];if(!output)throw Error('Supply probe output path');
const require=createRequire(new URL('../../../frontend/package.json',import.meta.url));
const bundled=await require('esbuild').build({stdin:{contents:`import {localConnection} from '../../../frontend/src/host-discovery.js';
globalThis[Symbol.for('codlet.functional.probe')]=localConnection;`,resolveDir:import.meta.dirname},bundle:true,write:false,format:'iife',platform:'browser'});
const probe=`(async()=>{
  const key=name=>Symbol.for('codlet.functional.'+name),test=globalThis[key('acceptance')],state=test?.inspect();
  if(!globalThis[key('connection')])try{globalThis[key('connection')]=globalThis[key('probe')]();}catch{}
  if(state&&globalThis[key('probeGeneration')]!==state.generation){globalThis[key('probeGeneration')]=state.generation;delete globalThis[key('thread')];delete globalThis[key('fixtureError')];}
  if(state?.phase==='waitingForFixtureThread'&&state.fixture?.autorun&&!globalThis[key('thread')]){
    globalThis[key('thread')]=true;
    try{
      await test.prepareFixture();
      const {manager}=globalThis[key('connection')]??globalThis[key('probe')]();
      const reply=await manager.sendRequest('thread/start',{cwd:state.fixture.root,approvalPolicy:'never',sandbox:'read-only',baseInstructions:'Synthetic local fixture. No tools.'});
      // A newly allocated empty task has no persisted rollout to cold-resume.
      // Seed exactly one local turn through the existing Native connection.
      const seeded=await manager.sendRequest('turn/start',{threadId:reply.thread.id,input:[{type:'text',text:'Seed the isolated fixture task',text_elements:[]}]});
      const end=Date.now()+8000;let complete=false;
      while(Date.now()<end){
        try{const read=await manager.sendRequest('thread/read',{threadId:reply.thread.id,includeTurns:true});
          const turn=read.thread.turns?.find(turn=>turn.id===seeded.turn.id);
          if(turn?.status==='completed'){complete=true;break;}
          if(turn?.status==='failed')throw Error('Local seed turn failed: '+turn.error?.message);
        }catch(error){if(!String(error).includes('is empty'))throw error;}
        await new Promise(resolve=>setTimeout(resolve,100));
      }
      if(!complete)throw Error('The local seed turn did not complete');
      test.supplyFixtureThread(reply.thread.id);
    }catch(error){globalThis[key('fixtureError')]=String(error);return {phase:'fixture_failed',error:String(error)};}
  }
  if(state&&['complete','failed'].includes(state.phase)){
    const entry=document.querySelector('[data-codlet-navigation-entry="compatibility.acceptance"]');if(entry?.getAttribute('aria-current')!=='page')entry?.click();
  }
  const skill=globalThis[Symbol.for('codlet.core.skills.v1')];
  return {phase:state?.phase,checks:state?.checks,host:state?.host,error:state?.error,fixtureError:globalThis[key('fixtureError')],
    panel:!!document.querySelector('[data-functional-test-panel]'),navigationEntries:document.querySelectorAll('[data-codlet-navigation-entry="compatibility.acceptance"]').length,
    reportNodes:document.querySelectorAll('[data-compatibility-acceptance]').length,composerLeases:document.querySelectorAll('[data-codlet-composer-action-owner="compatibility.acceptance"]').length,
    skill:skill&&{status:skill.status,error:skill.error}};
})()`;
fs.writeFileSync(output,bundled.outputFiles[0].text+'\n'+probe);
