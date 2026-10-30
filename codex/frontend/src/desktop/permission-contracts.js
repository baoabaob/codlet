import {parseExpressionAt} from 'acorn';

export const NATIVE_PERMISSION_FUNCTIONS = Object.freeze({
  reduce: { label: 'permission option reducer', markers: ['availableAgentModes','canShowCustom','configNonFullAccessMode','hasAuthoritativeGuardianApprovalDefault','showGuardianOption'] },
  convert: { label: 'permission converter', arities: [3,4], markers: ['read-only','full-access','guardian-approvals','runtimeWorkspaceRoots','sandbox_workspace_write'] },
  toSettings: { label: 'permission wire settings', arity: 1, markers: ['activePermissionProfile','sandboxPolicy','permissions:'], wireSettings: true },
  modeFromPolicy: { label: 'canonical permission mode', arity: 1, markers: ['approvalPolicy','sandboxPolicy','custom','??'], canonicalMode: true },
  profileMode: { label: 'built-in permission profile', arity: 2, markers: [':read-only',':workspace',':danger-full-access'] },
  defaultMode: { label: 'default workspace mode', arity: 1, markers: ['isProjectless','requirements','granular','auto'], workspaceDefault: true },
  windowsMode: { label: 'Windows default permission mode', arity: 1, markers: ['defaultWorkspaceWriteMode','isWindowsSandboxRequired','read-only'] },
  cyberModel: { label: 'model confirmation classification', arity: 1, markers: ['toLowerCase','cyber','daybreak'], modelClassification: true },
  agentState: { label: 'permission state hook', arity: 1, markers: ['shouldSendPermissionOverrides','setAgentModePreference','setPermissionProfileId','threadSandboxPolicy','getNonFullAccessFallbackMode'] },
});

const literal = node => node?.type === 'Literal' ? node.value : node?.type === 'TemplateLiteral' && !node.expressions.length ? node.quasis[0].value.cooked : undefined;

function permissionProjection(source, role) {
  try {
    const fn=parseExpressionAt(source,0,{ecmaVersion:'latest'}),parameter=fn.params?.[0];
    if(fn.async||fn.generator||fn.params.length!==1||parameter.type!=='Identifier')return false;
    const result=fn.body.type==='BlockStatement'&&fn.body.body.length===1&&fn.body.body[0].type==='ReturnStatement'?fn.body.body[0].argument:fn.body;
    const member=(node,...keys)=>{
      for(let index=keys.length-1;index>=0;index--){if(node?.type!=='MemberExpression'||node.computed||node.optional||node.property.name!==keys[index])return false;node=node.object;}
      return node?.type==='Identifier'&&node.name===parameter.name;
    };
    const nonNull=(node,key)=>node?.type==='BinaryExpression'&&node.operator==='!='&&member(node.left,key)&&literal(node.right)===null;
    const object=(node,key,...value)=>node?.type==='ObjectExpression'&&node.properties.length===1&&node.properties[0].type==='Property'&&
      !node.properties[0].computed&&!node.properties[0].method&&(node.properties[0].key.name??literal(node.properties[0].key))===key&&member(node.properties[0].value,...value);
    if(role==='wire')return result?.type==='ConditionalExpression'&&result.test?.type==='BinaryExpression'&&result.test.operator==='=='&&
      member(result.test.left,'activePermissionProfile')&&literal(result.test.right)===null&&
      object(result.consequent,'sandboxPolicy','sandboxPolicy')&&object(result.alternate,'permissions','activePermissionProfile','id');
    return result?.type==='LogicalExpression'&&result.operator==='??'&&result.left.type==='CallExpression'&&result.left.callee.type==='Identifier'&&
      result.left.arguments.length===1&&result.left.arguments[0].type==='Identifier'&&result.left.arguments[0].name===parameter.name&&
      result.right.type==='ConditionalExpression'&&result.right.test.type==='LogicalExpression'&&result.right.test.operator==='&&'&&
      nonNull(result.right.test.left,'approvalPolicy')&&nonNull(result.right.test.right,'sandboxPolicy')&&
      literal(result.right.consequent)==='custom'&&literal(result.right.alternate)===null;
  }catch{return false;}
}

function workspaceDefault(source) {
  try {
    const fn=parseExpressionAt(source,0,{ecmaVersion:'latest'}),parameter=fn.params?.[0];
    if(fn.async||fn.generator||fn.params.length!==1)return false;
    const input=(node,name)=>parameter.type==='ObjectPattern'
      ? parameter.properties.some(property=>property.type==='Property'&&!property.computed&&(property.key.name??literal(property.key))===name&&
        property.value.type==='Identifier'&&node?.type==='Identifier'&&node.name===property.value.name)
      : parameter.type==='Identifier'&&node?.type==='MemberExpression'&&!node.computed&&node.object.type==='Identifier'&&
        node.object.name===parameter.name&&node.property.name===name;
    const result=fn.body.type==='BlockStatement'&&fn.body.body.length===1&&fn.body.body[0].type==='ReturnStatement'?fn.body.body[0].argument:fn.body;
    const test=result?.test,check=test?.right;
    return result?.type==='ConditionalExpression'&&literal(result.consequent)==='granular'&&literal(result.alternate)==='auto'&&
      test?.type==='LogicalExpression'&&test.operator==='&&'&&input(test.left,'isProjectless')&&
      check?.type==='CallExpression'&&check.callee.type==='Identifier'&&check.arguments.length===2&&
      literal(check.arguments[0])==='granular'&&input(check.arguments[1],'requirements');
  }catch{return false;}
}

function modelClassification(source) {
  try {
    const fn=parseExpressionAt(source,0,{ecmaVersion:'latest'}),[declaration,result]=fn.body.body;
    const value=declaration?.declarations?.[0],init=value?.init,param=fn.params[0];
    if(fn.body.body.length!==2||declaration.type!=='VariableDeclaration'||declaration.declarations.length!==1||value.id.type!=='Identifier'||
      param?.type!=='Identifier'||init?.type!=='CallExpression'||init.arguments.length||init.callee.type!=='MemberExpression'||init.callee.computed||
      init.callee.object.name!==param.name||init.callee.property.name!=='toLowerCase'||result?.type!=='ReturnStatement'||
      result.argument?.type!=='LogicalExpression'||result.argument.operator!=='||')return false;
    const literals=[result.argument.left,result.argument.right].map(call=>{
      if(call.type!=='CallExpression'||call.arguments.length!==1||call.callee.type!=='MemberExpression'||call.callee.computed||
        call.callee.object.name!==value.id.name||call.callee.property.name!=='includes')return null;
      const literal=call.arguments[0];return literal.type==='Literal'?literal.value:literal.type==='TemplateLiteral'&&!literal.expressions.length?literal.quasis[0].value.cooked:null;
    });
    return literals.includes('cyber')&&literals.includes('daybreak');
  }catch{return false;}
}

export function matchesNativePermissionSource(source, arity, contract) {
  return (contract.arity == null || arity === contract.arity) &&
    (!contract.arities || contract.arities.includes(arity)) &&
    contract.markers.every(marker => source.includes(marker)) &&
    (!contract.wireSettings||permissionProjection(source,'wire')) &&
    (!contract.canonicalMode||permissionProjection(source,'mode')) &&
    (!contract.workspaceDefault||workspaceDefault(source)) &&
    (!contract.modelClassification||modelClassification(source));
}
