import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { digest } from './native-source-snapshot.mjs';
const require = createRequire(new URL('../../frontend/package.json', import.meta.url)), { tokenizer } = require('acorn');

// The maintained public operation tables are TypeScript declarations. Tokenize
// their member boundaries; comments and string contents cannot invent members.
// This is a declaration inventory, not an implementation/availability assertion.
export function interfaceEntries(source, name, methodsOnly = false) {
  const stream = tokenizer(source, { ecmaVersion: 'latest' }), tokens = [];
  for (;;) { const token = stream.getToken(); tokens.push(token); if (token.type.label === 'eof') break; }
  const start = tokens.findIndex((token, index) => token.type.label === 'name' && token.value === 'interface' &&
    tokens[index + 1]?.type.label === 'name' && tokens[index + 1].value === name);
  if (start < 0) throw Error(`Public interface ${name} was not found`);
  let index = start + 2;
  while (tokens[index]?.type.label !== '{') { if (!tokens[index] || tokens[index++].type.label === 'eof') throw Error('Interface has no body'); }
  let braces = 1, parens = 0, brackets = 0;
  const members = new Map();
  for (index++; index < tokens.length && braces; index++) {
    const token = tokens[index], label = token.type.label;
    if (braces === 1 && !parens && !brackets && ['name', 'string'].includes(label)) {
      const next = tokens[index + 1]?.type.label === '?' ? tokens[index + 2] : tokens[index + 1];
      const method = next?.type.label === '(';
      if (method || !methodsOnly && next?.type.label === ':') {
        const value = String(token.value);
        if (members.has(value)) throw Error(`Duplicate public member ${name}.${value}`);
        members.set(value, { name: value, kind: method ? 'method' : 'operation',
          line: source.slice(0, token.start).split('\n').length, offset: token.start });
      }
    }
    if (label === '{' || label === '${') braces++;
    if (label === '}') braces--;
    if (label === '(') parens++;
    if (label === ')') parens--;
    if (label === '[') brackets++;
    if (label === ']') brackets--;
  }
  if (braces) throw Error('Unclosed public interface');
  return [...members.values()];
}

export function createCoverageCatalog(root) {
  const specifications = [
    ['types/core-services.d.ts', 'CoreServiceMethods', 'core', false],
    ['types/core-services.d.ts', 'CoreFileMethods', 'core', false],
    ['types/plugin-storage.d.ts', 'PluginCoreServiceMethods', 'core', false],
    ['types/core-resources.d.ts', 'CoreResourceMethods', 'core', false],
    ['types/codex-desktop.d.ts', 'ReadMethods', 'codex.read', false],
    ['types/codex-desktop.d.ts', 'WriteMethods', 'codex.write', false],
    ['types/runtime-manage.d.ts', 'RuntimeManageMethods', 'management', false],
    ['types/codex-workspace.d.ts', 'WorkspaceSession', 'workspace', true],
    ['types/codex-workspace.d.ts', 'NavigationSession', 'workspace.navigation', true],
    ['types/codex-workspace.d.ts', 'TranscriptHandle', 'workspace.transcript', true],
    ['types/codex-workspace.d.ts', 'ComposerHandle', 'workspace.composer', true],
    ['types/codex-workspace.d.ts', 'ShortcutHandle', 'workspace.shortcut', true],
    ['types/codex-workspace.d.ts', 'NativeActionHandle', 'workspace.action', true],
    ['types/codex-workspace.d.ts', 'WorkspaceLocationHandle', 'workspace.location', true],
    ['types/codex-workspace.d.ts', 'SelectionPresentationHandle', 'workspace.selection', true],
    ['types/codex-workspace.d.ts', 'ComposerControlHandle', 'workspace.permissions', true],
    ['types/codex-workspace.d.ts', 'IndependentViewportHandle', 'workspace.viewport', true],
    ['types/codex.d.ts', 'CodexComposerActionHandle', 'codex.composerAction', true],
  ];
  const files = new Map(), entries = [];
  for (const [file, declaration, prefix, methodsOnly] of specifications) {
    if (!files.has(file)) {
      const source = fs.readFileSync(path.join(root, file), 'utf8'); files.set(file, { source, sha256: digest(source) });
    }
    const { source } = files.get(file);
    for (const member of interfaceEntries(source, declaration, methodsOnly)) {
      const id = `${prefix}.${member.name}`;
      // CoreServiceMethods deliberately replaces the inherited resources.list.
      if (declaration === 'CoreResourceMethods' && member.name === 'resources.list') continue;
      entries.push({ id, group: prefix, declaration, source: file, line: member.line });
    }
  }
  const additional = {
    'codex.navigation': ['page', 'newTaskDraft'],
    'codex.composer': ['registerAction'],
    'codex.workspace': ['connect'],
    'codex.compatibility': ['probe', 'waitReady'],
    'codex.events': ['read', 'onEvent'],
    'codex.submissions': ['register', 'list'],
    'codex.configuration': ['register', 'list'],
    'codex.permissions': ['register'],
    rpc: ['request', 'provide'],
    'host.system': ['info'],
    'host.fs': ['readText'],
    ui: ['create', 'page-controls'],
    traffic: ['inspect', 'openChannel', 'openSource', 'registerInterceptor'],
    'native.traffic': ['desktop-main-http', 'owned-backend-provider', 'model-transform'],
    'native.workspace': ['surface', 'navigation-interface', 'transcript-interface', 'composer-interface', 'shortcuts-interface', 'viewport-interface', 'action-interface',
      'input-ownership', 'full-lifecycle', 'drafts-and-attachments', 'physical-ime', 'permission-binding', 'shortcut-dispatch', 'viewport-restoration'],
    native: ['authentication-refresh', 'external-provider', 'startup', 'online-update-continuity', 'macos', 'linux'],
    plugin: ['reload', 'disable-enable', 'resource-cleanup'],
    installer: ['upgrade'],
  };
  for (const [group, names] of Object.entries(additional)) for (const name of names) entries.push({ id: `${group}.${name}`, group });
  if (new Set(entries.map(entry => entry.id)).size !== entries.length) throw Error('Coverage catalog has duplicate operation IDs');
  entries.sort((a, b) => a.id.localeCompare(b.id, 'en'));
  const version = /^\s*version = "([^"]+)"/m.exec(fs.readFileSync(path.join(root, 'Cargo.toml'), 'utf8'))?.[1];
  return { schema: 1, kind: 'codlet-compatibility-coverage', coreVersion: version,
    scope: 'Published Core service, Codex operation, runtime management and workspace handle contracts, plus explicit Native lifecycle scenarios',
    files: [...files].map(([file, value]) => ({ path: file, sha256: value.sha256 })),
    levels: ['source', 'simulated', 'interface', 'read', 'operation'], defaultStatus: 'not-verified', entries };
}
