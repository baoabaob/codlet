'use strict';
const {parentPort}=require('node:worker_threads');
if(parentPort)parentPort.postMessage({execArgv:process.execArgv});
else{process.send({execArgv:process.execArgv});process.disconnect();}
