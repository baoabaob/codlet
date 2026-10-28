import {parseExpressionAt} from 'acorn';

// Semantic responsibilities shared by the offline source audit and live Core
// discovery. Neither bundle hashes nor minified binding/export names are ABI.
export const WORKSPACE_FUNCTION_ROLES = Object.freeze({
  scopeProvider: { label: 'scope provider', markers: ['Missing parent scope', 'providedValue'], capabilities: ['transcript', 'composer'] },
  scopeFacade: { label: 'scope facade hook', markers: ['useContext', 'getOwnValue', 'queryClient', 'Missing query client'], capabilities: ['composer', 'viewport'] },
  composerValue: { label: 'composer scope value', markers: ['routeKind', 'local-thread', 'client-local-thread', 'browserTabMentionConversationId'], capabilities: ['transcript', 'composer'] },
  routeDescription: { label: 'route description', arity: 1, markers: ['pathname', 'routeTemplate', 'local-thread', 'client-local-thread', 'routeKind', '/extension/panel/new', 'new URLSearchParams'], capabilities: ['transcript', 'composer', 'viewport'] },
  draftIdentity: { label: 'composer draft identity', arity: 1, markers: ['gpt-draft:', 'draftThreadLocationId', 'library-preview:', 'widget-overlay:', 'clientThreadId'], capabilities: ['navigationInput', 'composer'] },
  threadNavigation: { label: 'thread navigation action', markers: [], variants: [
    {arity:7,markers:['sidebarThreadLocationId','orbitPrewarmId','`sidebar`','threadId:']},
    {markers:['navigateToLocalConversation'],localNavigationDelegate:true},
  ], capabilities: ['navigation', 'navigationInput', 'locationRestore'] },
  transcriptContent: { label: 'transcript content', markers: ['trackReadState', 'retainActiveInterest', 'contentSearchOrchestrationId'],
    inputProperties: ['conversationId', 'hostId', 'isReadOnly', 'trackReadState', 'retainActiveInterest', 'contentSearchOrchestrationId'], capabilities: ['transcript'] },
  threadSubscription: { label: 'thread subscription', markers: ['threadKey', 'cancelRelease', 'useSyncExternalStore', 'hostId', 'threadId'], capabilities: ['transcript'] },
  composerComponent: { label: 'composer component', markers: ['useAsbDirect', 'runtime', 'account'], capabilities: ['composer'] },
  composerSurface: { label: 'composer surface', markers: ['isWorkHome', 'isCodexHome', 'cloneElement', 'surfacePlacement'], capabilities: ['composer'] },
  editorFactory: { label: 'native editor factory', arity: 2, markers: ['inlineMentionIconRegistry', 'setEnterBehavior', 'getLiteralMarkdownLinks', 'restoreMarkdownLinksAsTextLinks', 'restorePathLinksAsFileMentions'], capabilities: ['composer'] },
  composerFrame: { label: 'composer frame', markers: ['hideThreadContent', 'canInteract', 'shouldResume', 'threadAccess', 'hostMcpApps'], capabilities: ['composer'] },
  shortcutCapture: { label: 'shortcut capture control', markers: ['allowsBareModifiers', 'allowsSequences', 'captureAriaLabel', 'onStartCapture'],
    inputProperties: ['allowsBareModifiers', 'allowsSequences', 'captureAriaLabel', 'onStartCapture', 'onCapture', 'onCancelCapture'], capabilities: ['shortcuts'] },
  eventAccelerator: { label: 'keyboard event accelerator', arity: 1, markers: ['ctrlKey', 'metaKey', 'altKey', 'shiftKey', 'Command', '.join('], capabilities: ['shortcuts'] },
  settingsRow: { label: 'settings row', markers: ['labelSizing', 'controlSizing', 'description', 'control'], capabilities: ['shortcuts'] },
  commandHook: { label: 'command hook', markers: ['contextHandler', 'keyboardHandler', 'menuItem', 'useEffect'], capabilities: ['shortcuts'] },
  keyboardDispatch: { label: 'keyboard command dispatch', arity: 3, markers: ['keyboard_shortcut'], capabilities: ['shortcuts'] },
  shortcutBindings: { label: 'effective shortcut bindings', markers: ['keymapState', 'accelerator:', 'label:', 'macOS', 'chatgpt'], shortcutBindings: true, capabilities: ['shortcuts'] },
  viewportSetOpen: { label: 'viewport open action', markers: ['window-resize', 'closeReason', '.stop()', 'animate'], capabilities: ['viewport'] },
  viewportPersistence: { label: 'viewport persistence action', arity: 1, markers: ['mainContentWidth', 'storageKey', 'widthMode', 'width'], capabilities: ['viewport'] },
});

export function matchesWorkspaceFunction(source, arity, contract, inputProperties = []) {
  if(contract.variants)return contract.variants.some(value=>matchesWorkspaceFunction(source,arity,value,inputProperties));
  return (!contract.arity && contract.arity !== 0 || arity === contract.arity) &&
    contract.markers.every(marker => source.includes(marker)) &&
    (!contract.localNavigationDelegate || isNativeLocalNavigationDelegate(source)) &&
    (!contract.shortcutBindings || isNativeShortcutBindings(source)) &&
    (!contract.inputProperties || contract.inputProperties.every(name => inputProperties.includes(name)));
}

// The binding helper consumes command/keymap/platform arguments and maps each
// accelerator to a label. Settings rows consume a props object and call it;
// their nested shortcut callbacks must not be mistaken for this responsibility.
function isNativeShortcutBindings(source){
  try{
    const fn=parseExpressionAt(source,0,{ecmaVersion:'latest'}),parameters=fn.params??[];
    if(fn.async||fn.generator||parameters.length<3||parameters.length>4||parameters.slice(0,3).some(value=>value.type!=='Identifier'))return false;
    if(parameters.length===4&&parameters[3].type!=='AssignmentPattern')return false;
    const body=fn.body?.body,call=body?.length===1&&body[0].type==='ReturnStatement'?body[0].argument:fn.body;
    if(call?.type!=='CallExpression'||call.callee.type!=='MemberExpression'||call.callee.computed||call.callee.property.name!=='map'||call.arguments.length!==1)return false;
    const mapper=call.arguments[0],parameter=mapper.params?.[0],value=mapper.body;
    if(mapper.type!=='ArrowFunctionExpression'||mapper.async||mapper.params.length!==1||parameter.type!=='Identifier'||value?.type!=='ObjectExpression')return false;
    const properties=new Map(value.properties.filter(property=>property.type==='Property'&&!property.computed).map(property=>[property.key.name??property.key.value,property.value]));
    const accelerator=properties.get('accelerator'),label=properties.get('label');
    return accelerator?.type==='Identifier'&&accelerator.name===parameter.name&&label?.type==='CallExpression'&&
      label.arguments[0]?.type==='Identifier'&&label.arguments[0].name===parameter.name;
  }catch{return false;}
}

// The current action forwards its remaining arguments to the mounted bridge.
// Reject delegates that add work, rewrite arguments or call another method.
export function isNativeLocalNavigationDelegate(source){
  try{
    if(typeof source!=='string')return false;
    const fn=parseExpressionAt(source,0,{ecmaVersion:'latest'}),[scope,rest]=fn.params??[],body=fn.body?.body;
    if(fn.async||fn.generator||fn.params.length!==2||scope?.type!=='Identifier'||rest?.type!=='RestElement'||rest.argument.type!=='Identifier'||body?.length!==1||body[0].type!=='ReturnStatement')return false;
    const call=body[0].argument,member=call?.callee,get=member?.object,getter=get?.callee;
    return call?.type==='CallExpression'&&member?.type==='MemberExpression'&&!member.computed&&member.property.name==='navigateToLocalConversation'&&
      call.arguments.length===1&&call.arguments[0].type==='SpreadElement'&&call.arguments[0].argument.type==='Identifier'&&call.arguments[0].argument.name===rest.argument.name&&
      get?.type==='CallExpression'&&get.arguments.length===1&&get.arguments[0].type==='Identifier'&&
      getter?.type==='MemberExpression'&&!getter.computed&&getter.object.type==='Identifier'&&getter.object.name===scope.name&&getter.property.name==='get';
  }catch{return false;}
}

// Only the function's own parameter and direct destructuring declarations count.
// A wrapper forwarding those properties to another component is a consumer,
// not the component implementing the input contract.
export function workspaceInputProperties(node) {
  const parameter = node?.params?.[0], patterns = [];
  if (parameter?.type === 'ObjectPattern') patterns.push(parameter);
  if (parameter?.type === 'Identifier') for (const statement of node.body?.body ?? []) {
    if (statement.type !== 'VariableDeclaration') continue;
    for (const declaration of statement.declarations) if (declaration.id.type === 'ObjectPattern' &&
      declaration.init?.type === 'Identifier' && declaration.init.name === parameter.name) patterns.push(declaration.id);
  }
  return [...new Set(patterns.flatMap(pattern => pattern.properties.filter(property => !property.computed)
    .map(property => property.key?.name ?? property.key?.value).filter(value => typeof value === 'string')))];
}
