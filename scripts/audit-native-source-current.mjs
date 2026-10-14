// Read exact package bytes and exercise only extracted boundary methods against
// local fakes. No Native module import, client, backend, account or CDP is used.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
const [directory,output]=process.argv.slice(2);
if(!directory)throw Error('Pass the extracted 26.1007.9446.0 package source directory');
const roles={
 'bootstrap-iULMfRBf.js':{hash:'385e3885eda6a2852d8e0b75d1d0b579ac06e27eb9b9300fa7e92d9b5216c869',kind:'bootstrap',symbol:'tr',methods:['assertAllowed','fetch','request']},
 'main-Bgi5Xaw-.js':{hash:'e8923725ad6357380ac7bb25818f78eb4d97e522ebbde2ddf6ff5a2a93032e54',kind:'main',symbol:'ple',methods:['performDesktopFetch','performProgressRequest']},
 'application-network-startup-YSC7OAs0.js':{hash:'52f0be375fb08281e88ad41be64220fb73f85210523e53e7d7acf094fda6344e',kind:'stdio',symbol:'Gs',methods:['send']},
 'src-DCNiwad_.js':{hash:'86fb2066bbc2f7428864b76b46ef570b09eb1e92e81e9d6f089f5b048a66df25',kind:'connection',symbol:'mB',methods:['routeIncomingMessage','getPendingRequestCount','restart']},
};
const require=createRequire(new URL('../frontend/package.json',import.meta.url)),{parse}=require('acorn');
const methods=new Map(),checks={};
for(const [name,role]of Object.entries(roles)){
 const bytes=fs.readFileSync(path.join(directory,name));assert.equal(createHash('sha256').update(bytes).digest('hex'),role.hash,name);
 const source=bytes.toString(),ast=parse(source,{ecmaVersion:'latest',sourceType:'script'});
 const classes=ast.body.filter(node=>node.type==='VariableDeclaration').flatMap(node=>node.declarations).filter(node=>node.id.name===role.symbol&&node.init?.type==='ClassExpression');
 assert.equal(classes.length,1,name+' exact top-level live class');
 const selected=Object.fromEntries(classes[0].init.body.body.map(node=>[node.key?.name??node.key?.value,source.slice(node.start,node.end)]));
 for(const name of role.methods)assert.equal(typeof selected[name],'string',role.symbol+'.'+name);
 methods.set(role.kind,selected);checks[role.kind+'LiveClass']=true;
}
const fetchMethod=methods.get('main').performDesktopFetch,progress=methods.get('main').performProgressRequest,connection=methods.get('connection').routeIncomingMessage;
checks.finalFetchAuthenticationBeforeNetwork=fetchMethod.indexOf('Refusing to attach authentication to non-OpenAI URL')<fetchMethod.indexOf('this.options.applicationNetwork.fetch(')&&fetchMethod.includes('p.throwIfAborted()');
checks.finalFetchPolicyAndProgress=fetchMethod.includes('applicationNetwork.assertAllowed(')&&fetchMethod.includes('this.performProgressRequest(')&&progress.includes('this.options.applicationNetwork.request(');
checks.accountUpdateBeforeNativeNotification=connection.includes('e.method===`account/updated`')&&connection.includes('e.params?.authMode')&&connection.includes('this.clearAuthTokenCache()');
for(const [name,value]of Object.entries(checks))assert.equal(value,true,name);
const dispatched=[],scope=vm.createContext({URL,Buffer,Ja:Error,Q:{Open:1},f:{net:{fetch:(...args)=>{dispatched.push(['fetch',...args]);return Promise.resolve('local')},request:(...args)=>{dispatched.push(['request',...args]);return 'local'}}}});
const network=vm.runInContext('({'+['assertAllowed','fetch','request'].map(key=>methods.get('bootstrap')[key]).join(',')+'})',scope);
const owner={...network,allows:url=>String(url)==='http://127.0.0.1/owned'};const init={signal:'kept',credentials:'same-origin'};
assert.equal(await network.fetch.call(owner,new URL('http://127.0.0.1/owned'),init),'local');assert.equal(dispatched[0][2],init);
await assert.rejects(network.fetch.call(owner,'https://blocked.invalid/',init),/policy/);assert.equal(dispatched.length,1);
const options={url:'http://127.0.0.1/owned',method:'POST'};assert.equal(network.request.call(owner,options),'local');assert.equal(dispatched[1][1],options);
assert.throws(()=>network.request.call(owner,{url:'https://blocked.invalid/'}),/policy/);assert.equal(dispatched.length,2);
checks.extractedNetworkMethodsPreservePolicyAndIdentity=true;
const send=vm.runInContext('({'+methods.get('stdio').send+'}).send',scope),written=[],sizes=[];
const stdio={readyState:1,proc:{stdin:{destroyed:false,write:line=>written.push(line)}},ioStatsTracker:{trackWritten:bytes=>sizes.push(bytes)}};
send.call(stdio,'{"id":1,"method":"owned"}');assert.deepEqual(written,['{"id":1,"method":"owned"}\n']);assert.equal(sizes[0],Buffer.byteLength(written[0]));
stdio.readyState=0;assert.throws(()=>send.call(stdio,'blocked'),/not available/);assert.equal(written.length,1);checks.extractedStdioMethodPreservesReadyCheckAndSingleJsonlWrite=true;
const report={schema:1,packageVersion:'26.1007.9446.0',frontendVersion:'26.1007.71326',buildNumber:'20398',kind:'exact-source-review-with-extracted-method-probes',roles,checks,
 limitations:['Only reviewed source hashes and extracted local-fake methods are verified here.','Actual Native source attachment, traffic transformation and running stream handoff require independent owned process evidence.','No macOS acceptance is established.']};
if(output)fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({packageVersion:report.packageVersion,checks:Object.keys(checks).length,passed:true}));
