'use strict';

const { setImmediate: pause } = require('node:timers/promises');
const { parentPort, workerData } = require('node:worker_threads');

const { PipeServer } = require('./pipe.cjs');

if (parentPort === null) throw new Error('Windows pipe test worker requires a parent port');

const server = new PipeServer(workerData.endpoint, workerData.sddl, workerData.maxFrameBytes);
let closing = false;
parentPort.on('message', (message) => {
  if (message?.type === 'close') closing = true;
});
parentPort.postMessage({ type: 'ready', securityDescriptor: server.securityDescriptor() });

void (async () => {
  try {
    while (!closing) {
      try {
        const request = server.read(25, 500);
        if (request === null) {
          await pause();
          continue;
        }
        parentPort.postMessage({ type: 'request', payload: request });
        server.write(request, 500);
      } catch (error) {
        server.disconnect();
        if (error?.win32Code !== 109 && error?.win32Code !== 232 && error?.win32Code !== 233) {
          parentPort.postMessage({ type: 'read-error', code: error?.code ?? 'unknown' });
        }
      }
      await pause();
    }
  } finally {
    server.close();
    parentPort.postMessage({ type: 'closed' });
  }
})().catch((error) => {
  parentPort.postMessage({ type: 'fatal', message: error instanceof Error ? error.message : String(error) });
});
