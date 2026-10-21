import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

export function analyzeInstallTiming(text) {
  const events=text.split(/\r?\n/).filter(Boolean).map(line=>JSON.parse(line));
  let previous=-1;
  for(const event of events){
    if(event.schema!==1||!Number.isSafeInteger(event.elapsedMs)||event.elapsedMs<previous||typeof event.stage!=='string')throw Error('Invalid or non-monotonic installation timing');
    previous=event.elapsedMs;
  }
  const spans=[],pending=new Map();
  for(const event of events){
    if(event.event==='start') {const stack=pending.get(event.stage)??[];stack.push(event.elapsedMs);pending.set(event.stage,stack);}
    if(event.event==='end') {const start=pending.get(event.stage)?.pop();if(start!==undefined)spans.push({stage:event.stage,startMs:start,endMs:event.elapsedMs,durationMs:event.elapsedMs-start,code:event.code??null});}
  }
  const actions=events.filter(event=>event.event==='action');
  const transactionEnd=events.find(event=>event.event==='end'&&event.stage==='msi-transaction');
  const intervals=actions.map((event,index)=>({action:event.stage,startMs:event.elapsedMs,endMs:actions[index+1]?.elapsedMs??transactionEnd?.elapsedMs??event.elapsedMs})).map(row=>({...row,durationMs:row.endMs-row.startMs}));
  if(intervals.some(row=>row.durationMs<0))throw Error('MSI action outside transaction');
  const byAction={};for(const row of intervals)byAction[row.action]=(byAction[row.action]??0)+row.durationMs;
  return {schema:1,totalMs:events.findLast(event=>event.event==='end'&&event.stage==='setup')?.elapsedMs??null,
    completed:!!transactionEnd,exitCode:transactionEnd?.code??null,spans,actionIntervals:intervals,
    actionIntervalTotalsMs:byAction,note:'Intervals run until the next MSI action starts; nested uninstall actions are separate rows. They are not exclusive CPU time or a file-copy benchmark.'};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const [input,output]=process.argv.slice(2);if(!input||!output)throw Error('Usage: node scripts/analyze-install-timing.mjs TIMING.jsonl FRESH_REPORT.json');
  const report=analyzeInstallTiming(fs.readFileSync(input,'utf8'));
  fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({completed:report.completed,exitCode:report.exitCode,totalMs:report.totalMs}));
}
