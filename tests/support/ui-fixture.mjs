import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../../bundled/runtime/ui.js', import.meta.url), 'utf8');
export const appearance = {
    api: 1, available: true, themeToken: 'codex.ui.appearance@1',
    roles: {
        button: ['default', 'primary', 'danger', 'icon', 'close', 'menu'], switch: ['default'],
        section: ['default'], row: ['default'], copy: ['default'], label: ['default'], description: ['default'],
        actions: ['default'], dialog: ['settings', 'confirmation'], dialogHeader: ['default'],
        dialogBody: ['default'], dialogActions: ['default'], heading: ['default'], status: ['default', 'error', 'success']
    }
};
export function withUi(scope, context = { pluginId: 'test.ui', generation: 1 }) {
    const cleanups = new Set();
    context.onDeactivate = cleanup => { cleanups.add(cleanup); return () => cleanups.delete(cleanup); };
    const create = vm.runInNewContext(source, scope, { filename: 'ui.js' });
    context.ui = { api: 1, create: description => create(context, description) };
    return { context, cleanups, deactivate() { for (const cleanup of [...cleanups]) cleanup(); } };
}
