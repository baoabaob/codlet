'use strict';
const { createInterface } = require('node:readline');
(async () => { for await (const line of createInterface({ input: process.stdin })) {
  let message; try { message = JSON.parse(line); } catch { continue; }
  if (message.id === 1) process.stdout.write(JSON.stringify({ id: 1, result: { userAgent: 'fixture' } }) + '\n');
  if (message.id === 2) process.stdout.write(JSON.stringify({ id: 2, result: { config: {
    model_provider: 'openai', openai_base_url: 'https://fixture.example/v1',
    model_providers: { custom: { wire_api: 'responses', base_url: 'https://custom.example/v1', http_headers: { authorization: 'never-project-this-secret' } } },
  } } }) + '\n');
  if (message.id === 3) process.stdout.write(JSON.stringify({ id: 3, result: { account: { type: 'apiKey', email: 'never-project-this-email' } } }) + '\n');
} })().catch(() => process.exit(1));
setInterval(() => {}, 1000);
