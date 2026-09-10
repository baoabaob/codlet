'use strict';

const fs = require('node:fs');
const path = require('node:path');
const capability = { name: 'example.os-broker.inspect', api: 1, scope: 'target' };

module.exports = {
  async activate(context) {
    const approved = path.join(context.root, 'approved-data');
    const messagePath = path.join(approved, 'message.txt');
    const reportPath = path.join(context.root, 'broker-report.json');
    try {
      const configuration = await context.fs.readText({ path: path.join(approved, 'settings.json'), maxBytes: 4096 });
      const settings = JSON.parse(configuration.text);
      const file = await context.fs.readText({ path: messagePath, maxBytes: 4096 });
      const directory = await context.fs.readDir({ path: approved, maxEntries: 16 });
      const metadata = await context.fs.stat({ path: messagePath });
      const network = await context.network.fetch({ url: settings.url, maxBytes: 4096 });
      const system = await context.system.info();
      context.rpc.provide(capability, 'readAgain', async () => context.fs.readText({ path: messagePath, maxBytes: 4096 }));
      // This observation file is ordinary Node code writing only its own package.
      // It is not an OS broker write API or a claim that Node is sandboxed.
      fs.writeFileSync(reportPath, JSON.stringify({ ready: true, generation: context.plugin.generation, file, directory, metadata, network, system }, null, 2));
    } catch (error) {
      fs.writeFileSync(reportPath, JSON.stringify({ ready: false, generation: context.plugin.generation, error: { code: error.code, message: error.message } }, null, 2));
      throw error;
    }
  },
  deactivate() {
    // Reads and fetches own no persistent application resources. Core cancels
    // any pending broker operations and retires its process Jobs before exit.
  },
};
