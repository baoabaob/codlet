import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const {selectJsonLines}=createRequire(import.meta.url)('../runtime/json-lines-fields.cjs');
const fields={id:true,method:true,params:{extraRoots:true,authMode:true},result:'present',error:'present'};

test('Native fields survive every byte boundary, Unicode and unselected message trees',()=>{
  const found=[],source=selectJsonLines(fields,value=>found.push(value));
  const value={params:{body:{method:'ignored',text:'large\n"\\body'},extraRoots:['C:/原生/😀','C:/a"b\\c']},method:'skills/extraRoots/set',id:'native'};
  const bytes=Buffer.from(JSON.stringify(value)+'\n');
  for(const byte of bytes)source.write(Buffer.from([byte]));
  assert.deepEqual(found,[{params:{extraRoots:value.params.extraRoots},method:value.method,id:'native'}]);
  source.write('\n{"id":2,"result":{"body":"ignored"}}\n{"id":3,"error":null}\n');
  assert.deepEqual(found.slice(1),[{id:2,result:true},{id:3,error:true}]);
});

test('large finite Native payloads and deep unrelated structures do not become an observer buffer',()=>{
  const found=[],source=selectJsonLines(fields,value=>found.push(value));
  source.write('{"id":"large","params":{"body":"');
  const chunk='x'.repeat(32*1024);
  for(let index=0;index<2049;index++)source.write(chunk);
  source.write('","tree":'+'['.repeat(12000)+'0'+']'.repeat(12000)+'},"method":"ordinary"}\n');
  source.write('{"method":"account/updated","params":{"authMode":"chatgpt"}}\n');
  assert.deepEqual(found,[{id:'large',params:{},method:'ordinary'},{method:'account/updated',params:{authMode:'chatgpt'}}]);
});

test('matching escaped keys work and malformed lines retire only their own observation',()=>{
  const found=[];let invalid=0;const source=selectJsonLines(fields,value=>found.push(value),()=>invalid++);
  source.write('{"'+ 'unrelated'.repeat(50000)+'":"skip","\\u0069d":4,"method":"native"}\n');
  source.write('{"id":5,}\n{"id":6,"params":{"extraRoots":["valid"]}}\n');
  assert.deepEqual(found,[{id:4,method:'native'},{id:6,params:{extraRoots:['valid']}}]);
  assert.equal(invalid,1);
  source.write('{"id":7,"skip":"bad\\q"}\n{"id":8,"skip":truegarbage}\n');assert.equal(invalid,3);
});
