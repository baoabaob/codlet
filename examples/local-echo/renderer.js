module.exports = {
    async activate(context) {
        const ping = await context.rpc.request(
            { name: 'codlet.runtime.ping', api: 1, scope: 'target' },
            'ping',
            null
        );
        if (ping?.pong !== true || ping?.abi !== 1) {
            throw new Error('Codlet host ping did not confirm ABI 1');
        }
        context.rpc.provide(
            { name: 'example.echo', api: 1, scope: 'target' },
            'echo',
            (params) => {
                if (!params || typeof params.text !== 'string') {
                    throw new TypeError('echo expects a text string');
                }
                return { text: params.text, pluginId: context.pluginId };
            }
        );
    },
    // The bootstrap owns and retires registered endpoints. This example owns no DOM or timers.
    deactivate() {}
};
