'use strict';
const readline=require('node:readline');
const held=new Map();
readline.createInterface({input:process.stdin}).on('line',line=>{
  const value=JSON.parse(line);
  if(value.method==='skills/extraRoots/set')held.set(value.id,value);
  else if(value.method==='fixture/reply'&&held.delete(value.params.id))process.stdout.write(JSON.stringify({id:value.params.id,result:{}})+'\n');
});
