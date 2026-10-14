'use strict';
// Read-only diagnostic. No configurable paths, file contents, writes, process
// enumeration, CDP calls, module patching, or directory changes.
const fs=require('node:fs'),path=require('node:path'),{createHash}=require('node:crypto');
const errorInfo=error=>Object.fromEntries(['name','code','errno','syscall','path','dest','message','stack'].filter(k=>error?.[k]!==undefined).map(k=>[k,error[k]]));
const attempt=fn=>{try{return{ok:true,value:fn()};}catch(error){return{ok:false,error:errorInfo(error)};}};
const methodInfo=fn=>typeof fn==='function'?{available:true,name:fn.name,length:fn.length,sourceSha256:createHash('sha256').update(Function.prototype.toString.call(fn)).digest('hex')}:{available:false,type:typeof fn};
const statInfo=value=>({directory:value.isDirectory(),file:value.isFile(),symlink:value.isSymbolicLink(),dev:String(value.dev),ino:String(value.ino),nlink:String(value.nlink),mode:String(value.mode)});
const prefix='\\\\?\\';
const ordinaryRoot=value=>value.startsWith(prefix)&&/^[a-z]:\\$/i.test(value.slice(prefix.length))?value.slice(prefix.length):null;
const ambiguousRoot=value=>/^[a-z]:$/i.test(value)||(value.startsWith(prefix)&&/^[a-z]:$/i.test(value.slice(prefix.length)));

function probeOwnAncestors(context){
  const cwd=process.cwd();
  if(context?.root!==undefined&&context.root!==cwd)throw Error('Probe is restricted to this Host cwd and its ancestors');
  const builtin=name=>typeof process.getBuiltinModule==='function'?process.getBuiltinModule(name):null;
  const report={schema:1,readOnly:true,createdAt:new Date().toISOString(),platform:process.platform,node:process.versions.node,uv:process.versions.uv,execPath:process.execPath,pid:process.pid,
    cwd,contextRoot:context?.root??null,moduleFile:__filename,pathSeparator:path.sep,pathDelimiter:path.delimiter,
    bindings:{fsIsBareAlias:fs===require('fs'),pathIsBareAlias:path===require('path'),fsIsProcessBuiltin:builtin('fs')?fs===builtin('fs'):null,pathIsProcessBuiltin:builtin('path')?path===builtin('path'):null},
    methods:{lstatSync:methodInfo(fs.lstatSync),statSync:methodInfo(fs.statSync),realpathSync:methodInfo(fs.realpathSync),realpathNative:methodInfo(fs.realpathSync?.native),resolve:methodInfo(path.resolve),dirname:methodInfo(path.dirname),parse:methodInfo(path.parse),toNamespacedPath:methodInfo(path.toNamespacedPath)},steps:[]};
  const inspect=input=>{
    const result={input,inputCodeUnits:Array.from({length:input.length},(_,i)=>input.charCodeAt(i)),resolved:attempt(()=>path.resolve(input)),parent:attempt(()=>path.dirname(input)),parsed:attempt(()=>path.parse(input))};
    if(ambiguousRoot(input)){result.skipped='Drive-relative or incomplete namespaced root; no filesystem call';return result;}
    result.statOptions={bigint:true};result.lstat=attempt(()=>statInfo(fs.lstatSync(input,{bigint:true})));
    // Do not follow a link or an ancestor whose plain identity is unknown.
    if(result.lstat.ok&&!result.lstat.value.symlink){
      result.stat=attempt(()=>statInfo(fs.statSync(input,{bigint:true})));
      result.realpath=attempt(()=>fs.realpathSync(input));
      if(typeof fs.realpathSync?.native==='function')result.realpathNative=attempt(()=>fs.realpathSync.native(input));
    }else result.followingMethodsSkipped='lstat failed or link detected';
    return result;
  };
  let current=cwd;
  for(let i=0;i<64;i++){
    const variants=new Set([current]);
    for(const operation of [()=>path.resolve(current),()=>path.toNamespacedPath(current),()=>ordinaryRoot(current)]){const r=attempt(operation);if(r.ok&&typeof r.value==='string')variants.add(r.value);}
    const step={literal:current,variants:[...variants].map(inspect)};report.steps.push(step);
    const literal=step.variants[0];
    if(literal.lstat?.ok&&literal.lstat.value.symlink){report.stopped='link detected; no further ascent';break;}
    const parent=attempt(()=>path.dirname(current));step.parentOperation=parent;
    if(!parent.ok){report.stopped='dirname failed';break;}
    if(parent.value===current){report.stopped='root reached';break;}
    if(ambiguousRoot(parent.value)){
      step.ambiguousParent=inspect(parent.value);
      const drive=/^[a-z]:[\\/]/i.test(current)?current.slice(0,2):null;
      if(drive&&parent.value.toLowerCase()===drive.toLowerCase())step.absoluteParentRoot=inspect(drive+current[2]);
      report.stopped='ambiguous parent; no drive-relative lookup';break;
    }
    current=parent.value;
    if(i===63)report.stopped='ancestor count limit';
  }
  return report;
}
module.exports={probeOwnAncestors};
