'use strict';
let dispose;
module.exports = {
    async activate(context) {
        if (context.ui?.api !== 1) throw Error('Update the managed renderer runtime for UI helpers');
        const appearance = await context.rpc.request({ name: 'codex.ui.appearance', api: 1, scope: 'target' }, 'describe');
        const mount = await context.rpc.request({ name: 'codex.ui.titlebar.afterMenu', api: 1, scope: 'target' }, 'getMount');
        const ui = context.ui.create(appearance);
        let count = 0, trigger, observer;
        const panel = ui.dialog({ title: 'UI controls', onClose() { trigger?.setAttribute('aria-expanded', 'false'); } });
        const back = ui.backButton({ text: 'Back', onClick() { panel.close('back'); } });
        panel.body.insertBefore(back, panel.actions);
        const intro = ui.element('p', { text: 'Shared controls, local events and owned cleanup. This example has no runtime-management grant.' });
        const group = ui.element('section', { role: 'section' });
        panel.body.insertBefore(intro, panel.actions); panel.body.insertBefore(group, panel.actions);
        const info = ui.status({ text: 'Ready' }); panel.body.insertBefore(info, panel.actions);
        const failure = ui.status({ text: 'Example error state. Try the action again.', tone: 'error' }); failure.hidden = true; panel.body.insertBefore(failure, panel.actions);
        const enabled = ui.row({ label: 'Enable sample actions', description: 'This switch changes only local example state. It does not enable or disable a plugin.' });
        const counter = ui.row({ label: 'Counter', description: '0 clicks' });
        const loading = ui.row({ label: 'Loading state', description: 'A short local timer demonstrates the busy state and is cancelled on unload.' });
        const errors = ui.row({ label: 'Error state', description: 'A status message remains readable at narrow widths and larger font sizes.' });
        const confirmation = ui.row({ label: 'Confirmation', description: 'Opens a second modal, focuses Cancel and returns focus to its trigger.' });
        for (const row of [enabled, counter, loading, errors, confirmation]) group.appendChild(row.element);
        const increment = ui.button({ text: 'Increment', onClick() { counter.description.textContent = `${++count} clicks`; } }); counter.controls.appendChild(increment);
        enabled.controls.appendChild(ui.switch({ label: 'Enable sample actions', checked: true, onChange(checked) { increment.disabled = !checked; } }));
        const load = ui.button({ text: 'Run', onClick() { ui.busy(load, true); info.textContent = 'Loading…'; ui.after(600, () => { ui.busy(load, false); info.textContent = 'Complete'; }); } }); loading.controls.appendChild(load);
        errors.controls.appendChild(ui.button({ text: 'Show error', onClick() { failure.hidden = !failure.hidden; } }));
        const confirm = ui.dialog({ title: 'Reset the counter?', variant: 'confirmation' });
        const explanation = ui.element('p', { text: 'The counter returns to zero. No files or plugin settings are changed.' }); confirm.body.insertBefore(explanation, confirm.actions);
        const cancel = ui.button({ text: 'Cancel', onClick() { confirm.close('cancel'); } });
        confirm.actions.appendChild(cancel);
        confirm.actions.appendChild(ui.button({ text: 'Reset', variant: 'danger', onClick() { count = 0; counter.description.textContent = '0 clicks'; confirm.close('confirmed'); } }));
        const reset = ui.button({ text: 'Reset…', onClick() { confirm.show({ trigger: reset, initialFocus: cancel }); } }); confirmation.controls.appendChild(reset);
        trigger = ui.button({ text: 'UI', label: 'Open UI controls example', variant: 'menu', onClick() { if (panel.element.open) panel.close(); else { panel.show({ trigger }); trigger.setAttribute('aria-expanded', 'true'); } } });
        trigger.setAttribute('aria-haspopup', 'dialog'); trigger.setAttribute('aria-expanded', 'false');
        const reconcile = () => {
            const target = [...document.querySelectorAll('[data-codlet-capability]')].find(node => node.getAttribute('data-codlet-capability') === mount.token);
            if (target && trigger.parentElement !== target) target.appendChild(trigger);
            else if (!target) { confirm.close('mount-lost'); panel.close('mount-lost'); trigger.remove(); }
        };
        observer = new MutationObserver(reconcile); observer.observe(document.documentElement, { childList: true, subtree: true }); reconcile();
        dispose = () => { observer.disconnect(); ui.dispose(); };
        context.onDeactivate(dispose);
    },
    deactivate() { const cleanup = dispose; dispose = undefined; cleanup?.(); }
};
