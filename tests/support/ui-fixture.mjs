import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require=createRequire(new URL('../../frontend/package.json',import.meta.url));
const {JSDOM,VirtualConsole}=require('jsdom');
export const uiSource=readFileSync(new URL('../../bundled/runtime/ui.js',import.meta.url),'utf8');
const i18nSource=readFileSync(new URL('../../bundled/runtime/i18n.js',import.meta.url),'utf8');
export const tick=async()=>{for(let i=0;i<4;i++)await new Promise(resolve=>setTimeout(resolve,0));};
export const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
export function uiFixture({locale='en',request=async()=>({plugins:[]})}={}){
  const errors=[],vc=new VirtualConsole();vc.on('jsdomError',error=>{if(error.type!=='css parsing')errors.push(error);});
  const dom=new JSDOM('<!doctype html><html lang="'+locale+'"><head></head><body><nav></nav><main></main><input id="host-editor"></body></html>',{url:'http://localhost',runScripts:'outside-only',pretendToBeVisual:true,virtualConsole:vc});
  const {window}=dom,{document}=window;
  window.TextEncoder=TextEncoder;window.TextDecoder=TextDecoder;
  // jsdom does not implement the modern CSS cascade used by the official
  // package. Keep style contents for ownership assertions; visuals run in Chromium.
  const create=document.createElement.bind(document);document.createElement=(tag,...args)=>{const node=create(tag,...args);if(tag==='style')node.type='text/plain';return node;};
  const observers=new Set(),mediaListeners=new Set(),NativeObserver=window.MutationObserver;
  window.MutationObserver=class extends NativeObserver{observe(...args){super.observe(...args);observers.add(this);}disconnect(){super.disconnect();observers.delete(this);}};
  window.matchMedia=()=>({matches:false,addEventListener(_type,fn){mediaListeners.add(fn);},removeEventListener(_type,fn){mediaListeners.delete(fn);},addListener(){},removeListener(){}});
  window.ResizeObserver=class{observe(){}unobserve(){}disconnect(){}};
  window.HTMLElement.prototype.scrollIntoView=function(){};
  window.PointerEvent=window.MouseEvent;
  const cleanups=new Set(),calls=[],overrides=new Map();let entry,host,toolbar;
  const context={pluginId:'codlet-gui',generation:1,onDeactivate(fn){cleanups.add(fn);return()=>cleanups.delete(fn);},reportDiagnostic(error){errors.push(error);},rpc:{async request(capability,method,args){
    calls.push({capability,method,args:structuredClone(args)});
    if(overrides.has(method))return overrides.get(method)(args);
    if(capability.name==='codex.ui.navigation.page'&&method==='register'){
      entry=document.createElement('button');entry.setAttribute('aria-label',args.label);entry.dataset.codletNavigationEntry=context.pluginId;entry.textContent=args.label;document.querySelector('nav').append(entry);
      entry.onclick=()=>{host?.remove();toolbar?.remove();if(args.toolbar){toolbar=document.createElement('div');toolbar.dataset.codletPageToolbar=args.token;document.body.prepend(toolbar);}host=document.createElement('div');host.dataset.codletPageHost=args.token;document.querySelector('main').append(host);entry.setAttribute('aria-current','page');};
      return {api:1,token:args.token,path:'/codlet/'+context.pluginId};
    }
    return request(capability,method,args);
  }}};
  const factory=window.eval(uiSource);
  context.i18n=window.eval(i18nSource)(context);context.ui={api:2,create:()=>factory(context)};
  const load=path=>{window.module={exports:{}};window.exports=window.module.exports;window.eval(readFileSync(new URL('../../'+path,import.meta.url),'utf8'));return window.module.exports;};
  const control=label=>[...document.querySelectorAll('[aria-label]')].find(el=>el.getAttribute('aria-label')===label) ?? document.getElementById([...document.querySelectorAll('label[for]')].find(el=>el.textContent===label)?.htmlFor) ?? [...document.querySelectorAll('button:not([aria-label]),[role=menuitem]:not([aria-label])')].find(el=>el.textContent.trim()===label);
  return {dom,window,document,errors,context,calls,overrides,load,control,observers,mediaListeners,cleanups,
    async open(){entry.click();await tick();},async leave(){host?.remove();toolbar?.remove();entry?.removeAttribute('aria-current');await tick();},
    async click(label){const element=control(label);if(!element)throw Error('Missing control '+label);element.focus();element.click();await tick();},
    async input(label,value){const element=control(label);const prototype=element.tagName==='TEXTAREA'?window.HTMLTextAreaElement.prototype:window.HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(prototype,'value').set.call(element,value);element.dispatchEvent(new window.Event('input',{bubbles:true}));await tick();},
    async key(element,key,rest={}){element.dispatchEvent(new window.KeyboardEvent('keydown',{key,bubbles:true,cancelable:true,...rest}));await tick();},
    async locale(value){document.documentElement.lang=value;await tick();},
    dispose(){for(const fn of [...cleanups])fn();window.close();},
  };
}
