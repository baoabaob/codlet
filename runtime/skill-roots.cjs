'use strict';
const {randomUUID} = require('node:crypto');
const {selectJsonLines} = require('./json-lines-fields.cjs');
const validId = value => typeof value === 'string' && value.length > 0 || Number.isSafeInteger(value);
const key = value => JSON.stringify(value);
const rootsValue = value => Array.isArray(value) && value.every(path => {
  if (typeof path !== 'string') return false;
  for (const character of path) {
    const code = character.charCodeAt(0);
    if (character.length === 1 && code >= 0xd800 && code <= 0xdfff) return false;
  }
  return true;
});

// Facts belong to actual Node ChildProcess/pipe identities, not renderer names.
// Only callers at the verified spawn entry can certify fresh observation.
function createSkillRootFacts() {
  const children = new WeakMap(), authorities = new Map(), bindings = new Map();
  function observe(child, {fresh = false, owner} = {}) {
    let record = children.get(child);
    if (record) { if (owner && !record.retired) record.addOwner(owner); return record; }
    if (!child?.stdin || typeof child.stdin.write !== 'function' || typeof child.stdout?.on !== 'function') return null;
    const input = child.stdin, output = child.stdout, original = input.write, originalEmit=output.emit;
    const inputDescriptor=Object.getOwnPropertyDescriptor(input,'write'),outputDescriptor=Object.getOwnPropertyDescriptor(output,'emit');
    record = {id:randomUUID(),child,input,output,original,owners:new Set(),listeners:new Set(),inflight:new Map(),rootWrites:new Set(),
      roots:[],fresh,known:fresh,uncertain:false,overlap:false,revision:randomUUID(),provenance:fresh?'fresh':null,retired:false};
    const seenOwners = new WeakSet();
    record.addOwner = owner => { if (!seenOwners.has(owner)) { seenOwners.add(owner); record.owners.add(new WeakRef(owner)); } };
    if (owner) record.addOwner(owner);
    const changed = () => { record.revision = randomUUID(); };
    const malformed = () => { record.uncertain = true; record.known = false; changed(); };
    const outgoing = selectJsonLines({id:true,method:true,params:{extraRoots:true}}, frame => {
      if (!validId(frame?.id) || typeof frame.method !== 'string') return;
      const id = key(frame.id);
      if (record.inflight.has(id)) { malformed(); return; }
      const request = {id:frame.id,method:frame.method,roots:null,overlap:false};
      record.inflight.set(id,request);
      if (frame.method !== 'skills/extraRoots/set') return;
      if (record.rootWrites.size) {
        record.overlap = true;
        for (const other of record.rootWrites) other.overlap = true;
        request.overlap = true;
      }
      request.roots = rootsValue(frame.params?.extraRoots) ? Object.freeze(frame.params.extraRoots) : null;
      record.rootWrites.add(request); changed();
    }, malformed);
    const incoming = selectJsonLines({id:true,method:true,params:{authMode:true},result:'present',error:'present'}, frame => {
      if (validId(frame?.id) && typeof frame.method !== 'string') {
        const id = key(frame.id), request = record.inflight.get(id);
        if (request) {
          record.inflight.delete(id);
          if (record.rootWrites.delete(request)) {
            if (frame.result === true && frame.error !== true && request.roots && !request.overlap && record.rootWrites.size === 0) {
              record.roots = request.roots; record.known = true; record.uncertain = false; record.overlap = false; record.provenance = 'confirmed';
            } else { record.uncertain = true; record.known = false; }
            changed();
          }
        }
      }
      for (const listener of record.listeners) try { listener(frame); } catch { /* Passive observers cannot interrupt Native. */ }
    }, malformed);
    // A data listener would put Native's pipe into flowing mode before Native
    // has attached its reader. Observe only bytes its original stream consumes.
    const emit=function(event,...args) {
      // Auth policy must already be queued when a synchronous Native notification
      // callback sends its next request. Bytes and Native event semantics remain
      // the original emitter's responsibility.
      if(!record.retired&&event==='data')try{incoming.write(args[0]);}catch{malformed();}
      return originalEmit.call(this,event,...args);
    };
    const wrapped = function(...args) {
      let result;
      try { result = original.apply(this,args); } catch (error) { malformed(); throw error; }
      if(!record.retired)try { outgoing.write(args[0]); } catch { malformed(); }
      return result;
    };
    record.live = () => !record.retired && record.observing && child.stdin === input && child.stdout === output && input.write === wrapped && output.emit===emit;
    const restore=(target,name,wrapper,descriptor)=>{
      try{if(target[name]!==wrapper)return;if(descriptor)Object.defineProperty(target,name,descriptor);else delete target[name];}catch{record.uncertain=true;}
    };
    const install=(target,name,value,descriptor)=>Object.defineProperty(target,name,descriptor?{...descriptor,value}:{value,writable:true,configurable:true,enumerable:false});
    record.current = () => {
      let current = false;
      for (const reference of record.owners) {
        const connection = reference.deref();
        if (!connection) record.owners.delete(reference);
        else if (!connection.disposed && connection.hostId==='local' && connection.isLocal===true && connection.connection?.proc === child) current = true;
      }
      return current;
    };
    record.subscribe = listener => { record.listeners.add(listener); return () => record.listeners.delete(listener); };
    record.close = () => {
      if (record.retired) return;
      record.retired = true; authorities.delete(record.id); record.listeners.clear(); record.inflight.clear(); record.rootWrites.clear(); record.owners.clear();
      record.roots=[];outgoing.reset();incoming.reset();
      for(const [client,binding] of bindings)if(binding.record===record)bindings.delete(client);
      restore(output,'emit',emit,outputDescriptor);child.off('exit',record.close);restore(input,'write',wrapped,inputDescriptor);
    };
    try{install(input,'write',wrapped,inputDescriptor);install(output,'emit',emit,outputDescriptor);record.observing=true;}
    catch{restore(input,'write',wrapped,inputDescriptor);restore(output,'emit',emit,outputDescriptor);record.observing=false;record.uncertain=true;record.known=false;}
    child.once('exit',record.close);
    children.set(child,record); authorities.set(record.id,record); return record;
  }
  function query(input) {
    let record;
    if(typeof input.clientId!=='string'||!input.clientId||!Number.isSafeInteger(input.clientEpoch)||input.clientEpoch<0)return {status:'unobserved',reason:'invalid_client'};
    const binding=bindings.get(input.clientId);
    if(binding&&input.clientEpoch<binding.epoch)return {status:'unobserved',reason:'retired_client_epoch'};
    const anchors = Array.isArray(input.anchors) ? input.anchors : [];
    const current=[...authorities.values()].filter(authority=>authority.current());
    if(current.length>1)return {status:'unobserved',reason:'ambiguous_owner'};
    if(input.authorityId&&binding?.epoch===input.clientEpoch&&binding.record.id===input.authorityId)record=binding.record;
    else if (anchors.length) {
      const found = new Set();
      for (const authority of authorities.values()) {
        if (!authority.live() || !authority.current()) continue;
        for (const anchor of anchors) {
          const request = authority.inflight.get(key(anchor.id));
          if (request && request.method === anchor.method) found.add(authority);
        }
      }
      if(found.size>1)return {status:'unobserved',reason:'ambiguous_owner'};
      [record]=found;
      if(!record&&current.length===1&&current[0].fresh)record=current[0];
      if(!record)return {status:'unobserved',reason:current.length?'late_attachment':'no_anchor'};
      if (input.authorityId && input.authorityId !== record.id) return {status:'unobserved',reason:'owner_changed'};
      bindings.set(input.clientId,{epoch:input.clientEpoch,record});
    } else if (typeof input.authorityId === 'string') {
      record = authorities.get(input.authorityId);
      if (!record) return {status:'retired',authorityId:input.authorityId};
      if(current.length!==1||current[0]!==record||!record.fresh)return {status:'unobserved',reason:'no_anchor'};
      bindings.set(input.clientId,{epoch:input.clientEpoch,record});
    } else if(current.length===1&&current[0].fresh){record=current[0];bindings.set(input.clientId,{epoch:input.clientEpoch,record});}
    else return {status:'unobserved',reason:current.length?'late_attachment':'no_anchor'};
    if (!record.current()) return {status:'unobserved',authorityId:record.id,reason:'owner_not_current'};
    if (!record.live()) return {status:'unknown',authorityId:record.id,reason:'observer_contract_changed'};
    const base = {authorityId:record.id,revision:record.revision};
    if (record.rootWrites.size) return {status:'unknown',...base,reason:'root_write_pending'};
    if (record.uncertain || record.overlap) return {status:'unknown',...base,reason:'root_write_unknown'};
    if (!record.known) return {status:'unobserved',...base,reason:'late_attachment'};
    let index = 0, offset = 0;
    if (input.cursor !== undefined && input.cursor !== null) {
      if (typeof input.cursor !== 'string') return {status:'unobserved',...base,reason:'invalid_cursor'};
      const [revision, position, character, extra] = input.cursor.split(':');
      if (revision !== record.revision) return {status:'unobserved',...base,reason:'revision_changed'};
      index = Number(position); offset = Number(character);
      if (extra !== undefined || !Number.isSafeInteger(index) || !Number.isSafeInteger(offset) || index < 0 || index > record.roots.length || offset < 0 || offset > (record.roots[index]?.length ?? 0)) return {status:'unobserved',...base,reason:'invalid_cursor'};
      const root = record.roots[index];
      if (root && offset > 0 && offset < root.length && root.charCodeAt(offset-1) >= 0xd800 && root.charCodeAt(offset-1) <= 0xdbff && root.charCodeAt(offset) >= 0xdc00 && root.charCodeAt(offset) <= 0xdfff) return {status:'unobserved',...base,reason:'invalid_cursor'};
    }
    const result = {status:'observed',...base,provenance:record.provenance,rootCount:record.roots.length,fragments:[],cursor:null};
    // This is one control page's wire budget, not a Native total/count quota.
    while (index < record.roots.length) {
      const root = record.roots[index];
      let end = Math.min(offset + 2048,root.length);
      if (end < root.length && root.charCodeAt(end-1) >= 0xd800 && root.charCodeAt(end-1) <= 0xdbff && root.charCodeAt(end) >= 0xdc00 && root.charCodeAt(end) <= 0xdfff) end--;
      const fragment = {index,text:root.slice(offset,end),complete:end===root.length};
      const prospective = {...result,fragments:[...result.fragments,fragment]};
      if (result.fragments.length && Buffer.byteLength(JSON.stringify(prospective)) > 32*1024) break;
      result.fragments.push(fragment); offset = end;
      if (fragment.complete) { index++; offset = 0; }
    }
    if (index < record.roots.length) result.cursor = `${record.revision}:${index}:${offset}`;
    return result;
  }
  return Object.freeze({observe,query,close() { for (const record of authorities.values()) record.close(); }});
}
module.exports = {createSkillRootFacts};
