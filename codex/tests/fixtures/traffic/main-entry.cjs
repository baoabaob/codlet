'use strict';
setImmediate(() => { fixtureElectron.app.ready = true; fixtureElectron.app.emit('ready'); });
setInterval(() => {}, 1000);
