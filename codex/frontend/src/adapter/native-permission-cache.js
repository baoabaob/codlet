import {componentSource,currentElementAncestry} from '../host-discovery.js';
import {OWNED,workspaceError} from './workspace-dom.js';
import {parse,parseExpressionAt} from 'acorn';

const plans=new WeakMap();
const field=(node,key)=>node?.type==='ObjectExpression'||node?.type==='ObjectPattern'?node.properties.find(property=>property.type==='Property'&&!property.computed&&(property.key.name??property.key.value)===key)?.value:null;
const literal=node=>node?.type==='Literal'?node.value:node?.type==='TemplateLiteral'&&!node.expressions.length?node.quasis[0].value.cooked:undefined;
function cacheSource(source){
  const root=parseExpressionAt(source,0,{ecmaVersion:'latest'}),nodes=[],parents=new Map();
  const visit=(node,parent)=>{if(!node||typeof node!=='object'||!node.type)return;if(node!==root&&/Function/.test(node.type))return;nodes.push(node);parents.set(node,parent);for(const value of Object.values(node))if(Array.isArray(value)){for(const child of value)visit(child,node);}else if(value?.type)visit(value,node);};
  visit(root,null);
  const allocations=nodes.filter(node=>node.type==='VariableDeclarator'&&node.id.type==='Identifier'&&node.init?.type==='CallExpression'&&
    (node.init.callee.type==='SequenceExpression'?node.init.callee.expressions.at(-1):node.init.callee)?.property?.name==='c');
  if(allocations.length!==1)throw Error('Native permission memo allocation changed');
  const cache=allocations[0].id.name,definitions=new Map();
  for(const node of nodes){const name=node.type==='VariableDeclarator'&&node.id.type==='Identifier'?node.id.name:node.type==='AssignmentExpression'&&node.left.type==='Identifier'?node.left.name:null;
    if(name){const value=node.type==='VariableDeclarator'?node.init:node.right,values=definitions.get(name)??new Set();values.add(value?.type==='Identifier'?value.name:null);definitions.set(name,values);}}
  const identity=node=>{if(node?.type!=='Identifier')return null;let name=node.name;const seen=new Set();while(!seen.has(name)){seen.add(name);const values=definitions.get(name);if(values?.size!==1||values.has(null))break;name=[...values][0];}return name;};
  const writes=nodes.filter(node=>node.type==='AssignmentExpression'&&node.operator==='='&&node.left.type==='MemberExpression'&&node.left.object.name===cache&&
    Number.isSafeInteger(literal(node.left.property))&&literal(node.left.property)>=0).map(node=>({node,index:literal(node.left.property),value:node.right}));
  const slots=(value,before=Infinity)=>[...new Set(writes.filter(write=>write.node.start<before&&identity(write.value)!==null&&identity(write.value)===identity(value)).map(write=>write.index))];
  const one=values=>{if(values.length!==1)throw Error('Native permission memo role is ambiguous');return values[0];};
  const same=(a,b)=>identity(a)!==null&&identity(a)===identity(b);
  return{root,nodes,parents,identity,same,writes,slots,one,cache};
}
const agentConsumer=source=>source.one(source.nodes.filter(node=>node.type==='VariableDeclarator'&&node.init?.type==='CallExpression'&&field(node.id,'agentMode')&&
  field(node.id,'permissionProfileId')&&field(node.id,'setAgentMode')&&field(node.id,'setPermissionProfileId')&&field(node.id,'shouldSendPermissionOverrides')));
// Resolve the consumer's lexical import to the already loaded hook object. A
// different hook returning the same field names is not a permission authority.
export function permissionPickerBindings(source,url,modules,agentState){
  const bindings=new Map(),module=parse(source,{ecmaVersion:'latest',sourceType:'module'});
  for(const declaration of module.body){
    if(declaration.type!=='FunctionDeclaration')continue;
    const text=source.slice(declaration.start,declaration.end);
    if(!['permissionProfilesOverride','setAgentMode','setPermissionProfileId'].every(marker=>text.includes(marker)))continue;
    try{
      const consumer=agentConsumer(cacheSource(text)),callee=consumer.init.callee;
      if(callee.type!=='Identifier')continue;
      const imports=module.body.filter(node=>node.type==='ImportDeclaration').flatMap(node=>node.specifiers.filter(specifier=>specifier.type==='ImportSpecifier'&&specifier.local.name===callee.name).map(specifier=>({url:new URL(node.source.value,url).href,name:specifier.imported.name??specifier.imported.value})));
      if(imports.length===1&&modules.get(imports[0].url)?.[imports[0].name]===agentState)bindings.set(text,{callee:callee.name,agentState});
    }catch{}
  }
  return bindings;
}
// Cache locations come from the loaded functions' actual assignments. Their
// numeric positions and the allocation size are not a Native ABI.
export function permissionCachePlan(pickerSource,agentSource,{callee}={}){
  let plan;
  try{
    const agent=cacheSource(agentSource),view=cacheSource(pickerSource),returns=agent.nodes.filter(node=>node.type==='ReturnStatement');
    const early=agent.one(returns.filter(node=>field(node.argument,'agentMode')&&field(node.argument,'permissionProfileId')&&field(node.argument,'shouldSendPermissionOverrides')));
    if(returns.length!==2||agent.parents.get(early)?.type!=='IfStatement'||agent.parents.get(early).alternate)throw Error('Native permission return branches changed');
    const review=field(early.argument,'isAutoReviewRequiredForSelectedModel');
    const tests=[];const conjunct=node=>{if(node?.type==='LogicalExpression'&&node.operator==='&&'){conjunct(node.left);conjunct(node.right);}else tests.push(node);};conjunct(agent.parents.get(early).test);
    if(!tests.some(node=>node?.type==='UnaryExpression'&&node.operator==='!'&&agent.same(node.argument,review)))throw Error('Native early-return model guard changed');
    const thread=agent.one(agent.nodes.filter(node=>node.type==='VariableDeclarator'&&field(node.id,'threadMode')&&field(node.id,'threadSandboxPolicy')&&field(node.id,'threadPermissionProfileId')));
    if(!agent.same(field(early.argument,'agentMode'),field(thread.id,'threadMode'))||
      !agent.same(field(early.argument,'permissionProfileId'),field(thread.id,'threadPermissionProfileId')))throw Error('Native early-return thread ownership changed');
    const argument=agent.one(agent.nodes.filter(node=>node.type==='VariableDeclarator'&&node.init?.type==='Identifier'&&node.init.name===agent.root.params[0]?.name&&
      field(node.id,'conversationId')&&field(node.id,'hostId')&&field(node.id,'cwdOverride')));
    const inputs=agent.nodes.filter(node=>node.type==='ObjectExpression'&&['conversationId','hostId','cwdOverride'].every(key=>agent.same(field(node,key),field(argument.id,key))));
    const inputSlots=inputs.flatMap(node=>{const parent=agent.parents.get(node);return parent?.type==='AssignmentExpression'?agent.slots(parent.left,early.start):[];});
    if(!inputSlots.length)throw Error('Native permission input cache is unavailable');
    const result=agent.one(agent.nodes.filter(node=>node!==early.argument&&node.type==='ObjectExpression'&&field(node,'agentMode')&&field(node,'permissionProfileId')&&field(node,'shouldSendPermissionOverrides')));
    const resultOwner=agent.parents.get(result);
    if(resultOwner?.type!=='AssignmentExpression'||resultOwner.left.type!=='Identifier'||result.start<early.end)throw Error('Native cached return ownership changed');
    const final=agent.one(returns.filter(node=>node!==early)),sequence=final.argument;
    const branch=sequence?.type==='SequenceExpression'&&sequence.expressions[0],last=sequence?.expressions.at(-1);
    const resultSlot=agent.one(agent.slots(resultOwner.left));
    if(sequence.expressions.length!==2||branch?.type!=='ConditionalExpression'||!agent.same(last,resultOwner.left)||
      branch.consequent.type!=='SequenceExpression'||branch.consequent.expressions[0]!==resultOwner||
      !branch.consequent.expressions.slice(1).every(node=>node.type==='AssignmentExpression'&&node.operator==='='&&node.left.type==='MemberExpression'&&node.left.object.name===agent.cache&&Number.isSafeInteger(literal(node.left.property)))||
      !branch.consequent.expressions.some(node=>node.type==='AssignmentExpression'&&node.left.type==='MemberExpression'&&node.left.object.name===agent.cache&&literal(node.left.property)===resultSlot&&agent.same(node.right,resultOwner.left))||
      branch.alternate.type!=='AssignmentExpression'||!agent.same(branch.alternate.left,resultOwner.left)||branch.alternate.right.type!=='MemberExpression'||
      branch.alternate.right.object.name!==agent.cache||literal(branch.alternate.right.property)!==resultSlot||
      agent.identity(field(early.argument,'shouldSendPermissionOverrides'))===null)throw Error('Native cached return flow changed');
    const consumer=agentConsumer(view);
    if(typeof callee!=='string'||consumer.init.callee.type!=='Identifier'||consumer.init.callee.name!==callee)throw Error('Native permission hook binding changed');
    const mode=view.one(view.nodes.filter(node=>node.type==='VariableDeclarator'&&node.init?.type==='ConditionalExpression'&&literal(node.init.consequent)==='guardian-approvals'&&
      view.same(node.init.alternate,field(consumer.id,'agentMode'))));
    const viewArgument=view.one(view.nodes.filter(node=>node.type==='VariableDeclarator'&&node.init?.type==='Identifier'&&node.init.name===view.root.params[0]?.name&&
      field(node.id,'conversationId')&&field(node.id,'hostId')&&field(node.id,'cwdOverride')&&field(node.id,'disableDefaultPermissions')&&field(node.id,'disableCustomPermissions')));
    const viewInputs=view.nodes.filter(node=>node.type==='ObjectExpression'&&['conversationId','hostId','cwdOverride'].every(key=>view.same(field(node,key),field(viewArgument.id,key))));
    const viewInputSlots=viewInputs.flatMap(node=>{const parent=view.parents.get(node);return parent?.type==='AssignmentExpression'?view.slots(parent.left):[];});
    const inputOwners=viewInputs.map(node=>view.parents.get(node)?.left);
    if(consumer.init.arguments.length!==1||!inputOwners.some(node=>view.same(node,consumer.init.arguments[0])))throw Error('Native picker hook input changed');
    // Preserve Native's guardian-only display mapping as well as its raw-mode
    // branch. Only these actual inputs may participate in the condition.
    const guardian=view.one(view.nodes.filter(node=>node.type==='VariableDeclarator'&&node.init?.type==='CallExpression'&&field(node.id,'canSelectGuardianMode')));
    const roles=[['disableDefaultPermissions',field(viewArgument.id,'disableDefaultPermissions')],['disableCustomPermissions',field(viewArgument.id,'disableCustomPermissions')],
      ['agentMode',field(consumer.id,'agentMode')],['canSelectGuardianMode',field(guardian.id,'canSelectGuardianMode')]];
    const reassigned=new Set(view.nodes.filter(node=>node.type==='AssignmentExpression'&&node.left.type==='Identifier').map(node=>node.left.name));
    if(roles.some(([,value])=>value?.type!=='Identifier'||reassigned.has(value.name)))throw Error('Native picker mode inputs changed');
    const definitions=new Map(),visiting=new Set();
    for(const node of view.nodes.filter(node=>node.type==='VariableDeclarator'&&node.id.type==='Identifier'&&node.init))definitions.set(node.id.name,definitions.has(node.id.name)?null:node.init);
    const condition=node=>{
      if(node?.type==='Literal'||node?.type==='TemplateLiteral'&&!node.expressions.length)return{value:literal(node)};
      if(node?.type==='Identifier'){
        const role=roles.find(([,value])=>view.same(node,value));if(role)return{role:role[0]};
        if(visiting.has(node.name)||reassigned.has(node.name)||!definitions.get(node.name))throw Error('Native picker mode dependency changed');
        visiting.add(node.name);const value=condition(definitions.get(node.name));visiting.delete(node.name);return value;
      }
      if(node?.type==='UnaryExpression'&&node.operator==='void')return{operator:'void'};
      if(node?.type==='LogicalExpression'&&node.operator==='&&'||node?.type==='BinaryExpression'&&['===','!=='].includes(node.operator))return{operator:node.operator,left:condition(node.left),right:condition(node.right)};
      throw Error('Native picker mode condition changed');
    };
    const modeCondition=condition(mode.init.test);
    const members=agent.writes.filter(write=>write.node.start<early.start&&write.value.type==='MemberExpression'&&!write.value.computed&&write.value.property.name==='resolvedConfig');
    plan={inputSlots:[...new Set(inputSlots)],configSlot:agent.one([...new Set(members.map(write=>write.index))]),
      sandboxSlot:agent.one(agent.slots(field(thread.id,'threadSandboxPolicy'),early.start)),
      modeSlot:agent.one(agent.slots(field(thread.id,'threadMode'),early.start)),profileSlot:agent.one(agent.slots(field(thread.id,'threadPermissionProfileId'),early.start)),
      overrideSlot:agent.one(agent.slots(field(early.argument,'shouldSendPermissionOverrides'),early.start)),resultSlot,viewInputSlots:[...new Set(viewInputSlots)],
      viewMode:view.slots(mode.id),viewProfile:view.slots(field(consumer.id,'permissionProfileId')),viewReview:view.slots(field(consumer.id,'isAutoReviewRequiredForSelectedModel')),modeCondition};
    if(!plan.viewInputSlots.length||!plan.viewMode.length||!plan.viewProfile.length||!plan.viewReview.length)throw Error('Native picker consumption cache changed');
  }catch{plan=null;}
  return plan;
}
function permissionPlan(picker,agentState,binding){
  let byPicker=plans.get(agentState);if(!byPicker){byPicker=new WeakMap();plans.set(agentState,byPicker);}if(byPicker.has(picker))return byPicker.get(picker);
  const plan=permissionCachePlan(componentSource(picker),componentSource(agentState),binding);byPicker.set(picker,plan);return plan;
}
function currentAgent(cache,agentState,bindings){
  const binding=bindings?.get(componentSource(cache.picker.type));
  if(binding?.agentState!==agentState)throw workspaceError('permissions_unsupported','Native permission hook import cannot be verified');
  const plan=permissionPlan(cache.picker.type,agentState,binding);
  if(!plan||![cache.props.disableDefaultPermissions,cache.props.disableCustomPermissions].every(value=>value===undefined||typeof value==='boolean'))throw workspaceError('permissions_unsupported','Native permission return ownership cannot be verified');
  const arrays=cache.picker.updateQueue.memoCache.data,thread=cache.threads.length===1?cache.threads[0]:null;
  if(!thread)throw workspaceError('permissions_unsupported','Native permission thread cache is ambiguous');
  const currentInput=(array,indices)=>indices.every(index=>{const value=array[index];return value&&['conversationId','hostId','cwdOverride'].every(key=>Object.is(value[key],cache.props[key]));});
  const frames=arrays.filter(array=>currentInput(array,plan.inputSlots)&&
    cache.configs.some(config=>array[plan.configSlot]===config.resolvedConfig)&&array[plan.sandboxSlot]===thread.threadSandboxPolicy&&
    array[plan.modeSlot]===thread.threadMode&&array[plan.profileSlot]===thread.threadPermissionProfileId&&typeof array[plan.overrideSlot]==='boolean');
  if(frames.length!==1)throw workspaceError('permissions_unsupported','A unique current Native permission state cache is required');
  const frame=frames[0],cached=frame[plan.resultSlot],isAgent=value=>value&&typeof value==='object'&&'agentMode'in value&&'permissionProfileId'in value&&
    typeof value.isAutoReviewRequiredForSelectedModel==='boolean'&&typeof value.shouldSendPermissionOverrides==='boolean';
  if(cached!==Symbol.for('react.memo_cache_sentinel')&&!isAgent(cached))throw workspaceError('permissions_unsupported','Native permission return cache changed');
  const views=arrays.filter(array=>currentInput(array,plan.viewInputSlots)&&plan.viewMode.every(index=>array[index]===array[plan.viewMode[0]])&&plan.viewProfile.every(index=>array[index]===array[plan.viewProfile[0]])&&
    plan.viewReview.every(index=>array[index]===array[plan.viewReview[0]])&&typeof array[plan.viewMode[0]]==='string'&&typeof array[plan.viewReview[0]]==='boolean'&&
    (array[plan.viewProfile[0]]===null||typeof array[plan.viewProfile[0]]==='string'));
  const evaluate=(node,values)=>{
    if('role'in node)return values[node.role];if('value'in node)return node.value;
    if(node.operator==='void')return undefined;
    const left=evaluate(node.left,values);
    if(node.operator==='&&')return left&&evaluate(node.right,values);
    const right=evaluate(node.right,values);return node.operator==='==='?left===right:left!==right;
  };
  const matches=value=>views.some(array=>[false,true].some(canSelectGuardianMode=>{
    const guardian=evaluate(plan.modeCondition,{...cache.props,agentMode:value.agentMode,canSelectGuardianMode}),displayMode=guardian?'guardian-approvals':value.agentMode;
    return array[plan.viewMode[0]]===displayMode&&array[plan.viewProfile[0]]===value.permissionProfileId&&array[plan.viewReview[0]]===value.isAutoReviewRequiredForSelectedModel;
  }));
  // There are exactly two proven return paths. The early path exposes these
  // four fields; every other guard only narrows its reachability. The final
  // path returns exactly resultSlot. Reject differing possible override values
  // rather than guessing which path ran from a stale memoized result.
  const early={agentMode:thread.threadMode,permissionProfileId:thread.threadPermissionProfileId,isAutoReviewRequiredForSelectedModel:false,shouldSendPermissionOverrides:frame[plan.overrideSlot]};
  const currentEarly=matches(early),currentCached=isAgent(cached)&&matches(cached);
  if(views.length!==1||!currentEarly&&!currentCached)throw workspaceError('permissions_unsupported','Native picker and permission state disagree');
  if(currentEarly&&currentCached&&['agentMode','permissionProfileId','isAutoReviewRequiredForSelectedModel','shouldSendPermissionOverrides'].some(key=>cached[key]!==early[key]))throw workspaceError('permissions_unsupported','Native permission return branch is ambiguous');
  return{agent:currentCached?cached:early,kind:currentCached?'memoized-return':'uncached-return'};
}

export function currentPermissionCache(document,input,{agentState,bindings}={}) {
  const root=document.getElementById('root');
  const triggers=[...input.input.querySelectorAll('[data-composer-navigation-target="permissions"]')].filter(node=>!node.closest(OWNED));
  if(triggers.length!==1)throw workspaceError('permissions_unsupported','A unique Native permission trigger is required');
  const trigger=triggers[0],base=currentElementAncestry(input.input,root),owner=base?.find(fiber=>fiber.stateNode===input.input);
  if(!owner)throw workspaceError('permissions_loading','Native input ownership is not committed');
  const queue=owner.child?[{fiber:owner.child,path:base}]:[],seen=new Set();let chain;
  while(queue.length){
    const {fiber,path}=queue.pop();if(!fiber||seen.has(fiber))continue;seen.add(fiber);
    if(fiber.stateNode===trigger){chain=[fiber,...path];break;}
    if(fiber.sibling)queue.push({fiber:fiber.sibling,path});
    if(fiber.child)queue.push({fiber:fiber.child,path:[fiber,...path]});
  }
  const pickers=chain?.filter(fiber=>{
    const source=componentSource(fiber.type);
    return source.includes('permissionProfilesOverride')&&source.includes('setAgentMode')&&source.includes('setPermissionProfileId');
  });
  if(pickers?.length!==1)throw workspaceError('permissions_unsupported','Native permission implementation is not supported');
  const picker=pickers[0],props=picker.memoizedProps;
  if(props.conversationId!==input.scope.value.conversationId||props.hostId!=='local')throw workspaceError('permissions_not_selected','Native permission control targets a different conversation');
  const arrays=picker.updateQueue?.memoCache?.data,values=[],unique=new Set();
  if(!Array.isArray(arrays))throw workspaceError('permissions_unsupported','Native permission cache shape is unsupported');
  for(const array of arrays){
    if(!Array.isArray(array))throw workspaceError('permissions_unsupported','Native permission cache shape is unsupported');
    for(const value of array)if(value&&typeof value==='object'&&!unique.has(value)){unique.add(value);values.push(value);}
  }
  const cache={picker,trigger,props,values,configs:values.filter(value=>'resolvedConfig'in value&&'requirements'in value&&typeof value.isConfigDataPending==='boolean'),
    agents:values.filter(value=>'agentMode'in value&&'permissionProfileId'in value&&typeof value.isAutoReviewRequiredForSelectedModel==='boolean'),
    threads:values.filter(value=>'threadMode'in value&&'threadSandboxPolicy'in value&&'threadPermissionProfileId'in value),
    models:values.filter(value=>typeof value.model==='string'&&typeof value.isLoading==='boolean'),
    cwds:values.filter(value=>value.hostId==='local'&&Object.keys(value).length===2&&'cwd'in value),
    intl:values.find(value=>typeof value.formatMessage==='function'&&typeof value.locale==='string')};
  if(agentState){const current=currentAgent(cache,agentState,bindings);cache.agents=[current.agent];cache.agentProvenance=current.kind;}
  return cache;
}

// Read only already-bound Native state; never initialize a query to discover it.
export function currentWindowsRequirement(input) {
  const seen=new Set(),matches=new Set();
  for(const node of input.scope.chain.values()){
    if(seen.has(node)||!(node.familyBindings instanceof Map))continue;seen.add(node);
    for(const [family,bindings] of node.familyBindings){
      if(family?.scope!==node.token||typeof family.read!=='function'||!(bindings instanceof Map)||!bindings.has('local'))continue;
      const value=family.read(node,input.scope.chain,'local');
      if(value&&Object.keys(value).length===4&&['hasError','isPending','isRequired'].every(key=>typeof value[key]==='boolean')&&
          ['setup','update',null].includes(value.requirement))matches.add(value);
    }
  }
  if(matches.size!==1)throw workspaceError('permissions_unsupported','A unique existing Native Windows requirement is required');
  const value=[...matches][0];
  if(value.isPending||value.hasError)throw workspaceError('permissions_loading','Native Windows permission requirement is pending');
  return value;
}
