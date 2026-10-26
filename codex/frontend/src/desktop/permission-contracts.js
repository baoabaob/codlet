import {parseExpressionAt} from 'acorn';

export const NATIVE_PERMISSION_FUNCTIONS = Object.freeze({
  reduce: { label: 'permission option reducer', markers: ['availableAgentModes','canShowCustom','configNonFullAccessMode','hasAuthoritativeGuardianApprovalDefault','showGuardianOption'] },
  convert: { label: 'permission converter', arities: [3,4], markers: ['read-only','full-access','guardian-approvals','runtimeWorkspaceRoots','sandbox_workspace_write'] },
  toSettings: { label: 'permission wire settings', arity: 1, markers: ['activePermissionProfile','sandboxPolicy','permissions:'] },
  modeFromPolicy: { label: 'canonical permission mode', arity: 1, markers: ['approvalPolicy','sandboxPolicy','custom','??'] },
  profileMode: { label: 'built-in permission profile', arity: 2, markers: [':read-only',':workspace',':danger-full-access'] },
  defaultMode: { label: 'default workspace mode', arity: 1, markers: ['isProjectless','requirements','granular','auto'] },
  windowsMode: { label: 'Windows default permission mode', arity: 1, markers: ['defaultWorkspaceWriteMode','isWindowsSandboxRequired','read-only'] },
  cyberModel: { label: 'model confirmation classification', arity: 1, markers: ['toLowerCase','cyber','daybreak'], modelClassification: true },
});

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
    (!contract.modelClassification||modelClassification(source));
}
