module.exports = {
    activate(context) {
        const badge = document.createElement('div');
        badge.setAttribute('data-codlet-github-release-check', '');
        badge.textContent = 'M5 GitHub test — v1';
        Object.assign(badge.style, { position: 'fixed', top: '96px', right: '18px', zIndex: '10000', padding: '8px 12px', border: '1px solid GrayText', borderRadius: '8px', background: 'Canvas', color: 'CanvasText', font: '14px/1.4 system-ui', pointerEvents: 'none' });
        document.body.appendChild(badge);
        context.onDeactivate(() => badge.remove());
    },
    deactivate() {}
};
