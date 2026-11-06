import {workspaceModuleSyntax,workspaceSourceFunctions,workspaceLexicalReferences,visitWorkspaceSource} from '../adapter/workspace-source.js';
import {rspackReference,isRspackNamespace} from '../rspack-native.js';

const fail=message=>Object.assign(new Error(message),{code:'desktop_notification_stream_drift'});
const key=node=>node&&!node.computed?(node.key?.name??node.key?.value):null;
const method=(node,name)=>node.body.body.find(value=>value.type==='MethodDefinition'&&!value.static&&key(value)===name)?.value;
const own=(object,name)=>Object.getOwnPropertyDescriptor(object??{},name)?.value;

export function rspackPublishedNotifications(runtime,postbox,check){
  const candidates=[];
  for(const record of runtime.records().values()){
    if(!isRspackNamespace(record.namespace))continue;
    for(const [classKey,Class]of Object.entries(record.namespace)){
      if(typeof Class!=='function'||typeof Class.prototype?.dispatchMessage!=='function'||typeof Class.prototype?.subscribe!=='function')continue;
      const exported=record.info.exports.get(classKey);if(exported?.type!=='Identifier')continue;
      const declaration=record.info.fn.body.body.find(node=>node.type==='ClassDeclaration'&&node.id.name===exported.name);if(!declaration)continue;
      const dispatch=method(declaration,'dispatchMessage');if(!dispatch||dispatch.params.length!==2)continue;
      const postboxes=[];
      visitWorkspaceSource(dispatch,node=>{const member=node.callee,argument=node.arguments?.[0];
        if(node.type!=='CallExpression'||member?.type!=='MemberExpression'||member.computed||member.property.name!=='postMessage'||node.arguments.length!==1||argument?.type!=='ObjectExpression'||argument.properties.length!==2)return;
        const[spread,type]=argument.properties;
        if(spread.type==='SpreadElement'&&spread.argument.name===dispatch.params[1].name&&key(type)==='type'&&type.value.name===dispatch.params[0].name)postboxes.push(rspackReference(runtime,record,member.object));
      });
      if(postboxes.length!==1||postboxes[0]!==postbox)continue;
      const bus=own(Class,'instance'),busKeys=Object.keys(record.namespace).filter(key=>record.namespace[key]===bus);
      if(bus&&busKeys.length===1)candidates.push({record,classKey,Class,busKey:busKeys[0],bus});
    }
  }
  if(candidates.length!==1)throw fail('A unique Native Rspack notification stream is required');
  const {record,classKey,Class,busKey,bus}=candidates[0],namespace={Class,bus,postbox};
  runtime.pin(record);
  return nativePublishedNotifications({namespace,selection:{constructor:'Class',bus:'bus',postbox:'postbox'},postbox,check(){check();runtime.check();if(record.namespace[classKey]!==Class||record.namespace[busKey]!==bus)throw fail('Native notification exports were replaced');}});
}

// Identify Native's existing window dispatcher through its lexical postbox.
// The factory and getInstance method are never called by Core.
export function publishedNotificationExports(source){
  const syntax=workspaceModuleSyntax(source),matches=[];
  const exported=name=>[...new Set(syntax.exports.filter(value=>value.local===name&&!value.source).map(value=>value.exported))].sort()[0];
  for(const fn of workspaceSourceFunctions(source,'hostMessageInterceptors')){
    const resolve=workspaceLexicalReferences(fn),assignments=[];
    visitWorkspaceSource(fn,node=>{if(node.type==='AssignmentExpression'&&node.operator==='='&&node.left.type==='Identifier')assignments.push(node);});
    for(const assignment of assignments){
      const Class=assignment.right;
      if(Class.type!=='ClassExpression'||resolve(assignment.left)!==`global:${assignment.left.name}`)continue;
      const dispatch=method(Class,'dispatchMessage'),subscribe=method(Class,'subscribe'),deliver=method(Class,'deliverMessage');
      if(!dispatch||!subscribe||!deliver||dispatch.params.length!==2||dispatch.params.some(value=>value.type!=='Identifier'))continue;
      if(subscribe.body.body.at(-1)?.type!=='ReturnStatement'||subscribe.body.body.at(-1).argument?.type!=='ArrowFunctionExpression')continue;
      const postboxes=new Set();
      visitWorkspaceSource(dispatch,node=>{
        const member=node.callee,argument=node.arguments?.[0];
        if(node.type!=='CallExpression'||member?.type!=='MemberExpression'||member.computed||member.property.name!=='postMessage'||member.object.type!=='Identifier'||resolve(member.object)!==`global:${member.object.name}`||node.arguments.length!==1||argument?.type!=='ObjectExpression'||argument.properties.length!==2)return;
        const [spread,type]=argument.properties;
        if(spread.type==='SpreadElement'&&resolve(spread.argument)===resolve(dispatch.params[1])&&key(type)==='type'&&resolve(type.value)===resolve(dispatch.params[0]))postboxes.add(member.object.name);
      });
      if(postboxes.size!==1)continue;
      const constructor=exported(assignment.left.name),postbox=exported([...postboxes][0]);
      for(const singleton of assignments){
        const call=singleton.right,member=call?.callee;
        if(call.type!=='CallExpression'||call.arguments.length||member?.type!=='MemberExpression'||member.computed||member.property.name!=='getInstance'||resolve(member.object)!==resolve(assignment.left)||resolve(singleton.left)!==`global:${singleton.left.name}`)continue;
        const bus=exported(singleton.left.name);
        if(constructor&&postbox&&bus)matches.push({constructor,postbox,bus});
      }
    }
  }
  if(matches.length!==1)throw fail('A unique existing Native published notification stream is required');
  return matches[0];
}

export function nativePublishedNotifications({namespace,selection,postbox,check}){
  const Class=own(namespace,selection.constructor),bus=own(namespace,selection.bus),prototype=own(Class,'prototype');
  const subscribe=own(prototype,'subscribe'),deliver=own(prototype,'deliverMessage'),dispatch=own(prototype,'dispatchMessage'),windowListener=own(bus,'windowMessageListener');
  const live=()=>{
    check();
    if(typeof Class!=='function'||own(namespace,selection.constructor)!==Class||own(namespace,selection.bus)!==bus||own(namespace,selection.postbox)!==postbox||own(Class,'instance')!==bus||!bus||Object.getPrototypeOf(bus)!==prototype||own(bus,'initialized')!==true||own(bus,'isListeningToWindow')!==true||own(bus,'windowMessageListener')!==windowListener||typeof windowListener!=='function'||own(prototype,'subscribe')!==subscribe||typeof subscribe!=='function'||own(prototype,'deliverMessage')!==deliver||typeof deliver!=='function'||own(prototype,'dispatchMessage')!==dispatch||typeof dispatch!=='function')throw fail('The current Native published notification stream was replaced');
  };
  live();
  return{check:live,subscribe(methods,listener,onError=()=>{}){
    live();const selected=new Set(methods);let active=true,release;
    const stop=()=>{active=false;const remove=release;release=null;return remove?.();};
    const notify=error=>{try{onError(error);}catch{}};
    try{release=Reflect.apply(subscribe,bus,['mcp-notification',message=>{
      if(!active)return;
      try{live();if(message?.hostId==='local'&&selected.has(message.method))listener(message);}
      catch(error){notify(error);try{stop();}catch(cleanup){notify(cleanup);}}
    }]);}catch(error){active=false;throw error;}
    if(typeof release!=='function'){active=false;throw fail('Native notification subscription cleanup changed');}
    if(!active)stop();
    return()=>{if(!active)return;return stop();};
  }};
}
