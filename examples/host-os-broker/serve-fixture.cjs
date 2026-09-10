'use strict';

const http = require('node:http');
const port = Number(process.argv[2] || 8765);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Choose a local TCP port between 1 and 65535');
http.createServer((_request, response) => {
  const body = JSON.stringify({ fixture: 'local OS broker example' });
  response.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'Connection': 'close' });
  response.end(body);
}).listen(port, '127.0.0.1', () => {
  console.log(`Local fixture: http://127.0.0.1:${port}/message`);
});
