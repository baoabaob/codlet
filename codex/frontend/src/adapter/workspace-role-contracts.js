// Semantic responsibilities shared by the offline source audit and live Core
// discovery. Neither bundle hashes nor minified binding/export names are ABI.
export const WORKSPACE_FUNCTION_ROLES = Object.freeze({
  scopeProvider: { label: 'scope provider', markers: ['Missing parent scope', 'providedValue'], capabilities: ['transcript', 'composer'] },
  scopeFacade: { label: 'scope facade hook', markers: ['useContext', 'getOwnValue', 'queryClient', 'Missing query client'], capabilities: ['composer', 'viewport'] },
  composerValue: { label: 'composer scope value', markers: ['routeKind', 'local-thread', 'client-local-thread', 'browserTabMentionConversationId'], capabilities: ['transcript', 'composer'] },
  routeDescription: { label: 'route description', arity: 1, markers: ['pathname', 'routeTemplate', 'local-thread', 'client-local-thread', 'routeKind', '/extension/panel/new', 'new URLSearchParams'], capabilities: ['transcript', 'composer', 'viewport'] },
  draftIdentity: { label: 'composer draft identity', arity: 1, markers: ['gpt-draft:', 'draftThreadLocationId', 'library-preview:', 'widget-overlay:', 'clientThreadId'], capabilities: ['navigationInput', 'composer'] },
  threadNavigation: { label: 'thread navigation action', arity: 7, markers: ['sidebarThreadLocationId', 'orbitPrewarmId', '`sidebar`', 'threadId:'], capabilities: ['navigation', 'navigationInput', 'locationRestore'] },
  transcriptContent: { label: 'transcript content', markers: ['trackReadState', 'retainActiveInterest', 'contentSearchOrchestrationId'],
    inputProperties: ['conversationId', 'hostId', 'isReadOnly', 'trackReadState', 'retainActiveInterest', 'contentSearchOrchestrationId'], capabilities: ['transcript'] },
  threadSubscription: { label: 'thread subscription', markers: ['threadKey', 'cancelRelease', 'useSyncExternalStore', 'hostId', 'threadId'], capabilities: ['transcript'] },
  composerComponent: { label: 'composer component', markers: ['useAsbDirect', 'runtime', 'account'], capabilities: ['composer'] },
  composerSurface: { label: 'composer surface', markers: ['isWorkHome', 'isCodexHome', 'cloneElement', 'surfacePlacement'], capabilities: ['composer'] },
  editorFactory: { label: 'native editor factory', arity: 2, markers: ['inlineMentionIconRegistry', 'setEnterBehavior', 'getLiteralMarkdownLinks', 'restoreMarkdownLinksAsTextLinks', 'restorePathLinksAsFileMentions'], capabilities: ['composer'] },
  composerFrame: { label: 'composer frame', markers: ['hideThreadContent', 'canInteract', 'shouldResume', 'threadAccess', 'hostMcpApps'], capabilities: ['composer'] },
  shortcutCapture: { label: 'shortcut capture control', markers: ['allowsBareModifiers', 'allowsSequences', 'captureAriaLabel', 'onStartCapture'],
    inputProperties: ['allowsBareModifiers', 'allowsSequences', 'captureAriaLabel', 'onStartCapture', 'onCapture', 'onCancelCapture'], capabilities: ['shortcuts'] },
  eventAccelerator: { label: 'keyboard event accelerator', arity: 1, maxBytes: 1024, markers: ['ctrlKey', 'metaKey', 'altKey', 'shiftKey', 'Command', '.join('], capabilities: ['shortcuts'] },
  settingsRow: { label: 'settings row', markers: ['labelSizing', 'controlSizing', 'description', 'control'], capabilities: ['shortcuts'] },
  commandHook: { label: 'command hook', markers: ['contextHandler', 'keyboardHandler', 'menuItem', 'useEffect'], capabilities: ['shortcuts'] },
  keyboardDispatch: { label: 'keyboard command dispatch', arity: 3, maxBytes: 256, markers: ['keyboard_shortcut'], capabilities: ['shortcuts'] },
  shortcutBindings: { label: 'effective shortcut bindings', maxBytes: 2048, markers: ['keymapState', 'accelerator:', 'label:', 'macOS', 'chatgpt'], capabilities: ['shortcuts'] },
  viewportSetOpen: { label: 'viewport open action', markers: ['window-resize', 'closeReason', '.stop()', 'animate'], capabilities: ['viewport'] },
  viewportPersistence: { label: 'viewport persistence action', arity: 1, maxBytes: 4096, markers: ['mainContentWidth', 'storageKey', 'widthMode', 'width'], capabilities: ['viewport'] },
});

export function matchesWorkspaceFunction(source, arity, contract, inputProperties = []) {
  return (!contract.arity && contract.arity !== 0 || arity === contract.arity) &&
    (!contract.maxBytes || source.length < contract.maxBytes) && contract.markers.every(marker => source.includes(marker)) &&
    (!contract.inputProperties || contract.inputProperties.every(name => inputProperties.includes(name)));
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
