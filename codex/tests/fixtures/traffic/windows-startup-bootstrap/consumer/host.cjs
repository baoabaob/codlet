const fs=require('node:fs'),path=require('node:path');
let interceptor;
exports.activate=async context=>{
  const {baseUrl}=JSON.parse(fs.readFileSync(path.join(context.root,'fixture.json'),'utf8'));
  const counts={request:0,response:0,webSocket:0,clientFrames:0,serverFrames:0};
  interceptor=await context.traffic.registerInterceptor({id:'compat-fixture',origins:[new URL(baseUrl).origin]}, {
    async request(request){
      counts.request++;
      const headers=[...request.headers.filter(([name])=>name.toLowerCase()!=='content-length'),['x-codlet-acceptance','modified']];
      if(request.url.includes('/desktop/')||request.url.endsWith('/responses')){
        let body='';for await(const chunk of request.body)body+=Buffer.from(chunk).toString('utf8');
        if(request.url.endsWith('/responses')){const value=JSON.parse(body);value.model='codlet-intercepted-model';body=JSON.stringify(value);}
        return {request:{headers,body:body.replaceAll('codlet-original-request','codlet-modified-request')}};
      }
      return {request:{headers}};
    },
    async response(response){
      counts.response++;
      let body='';for await(const chunk of response.body??[])body+=typeof chunk==='string'?chunk:Buffer.from(chunk).toString('utf8');
      return {headers:(response.headers??[]).filter(([name])=>name.toLowerCase()!=='content-length'),body:body.replaceAll('codlet-original-response','codlet-modified-response')};
    },
    webSocket(request){counts.webSocket++;return {
      request:{headers:[...request.headers,['x-codlet-acceptance','modified']]},
      clientToServer(frame){counts.clientFrames++;const value=JSON.parse(typeof frame.data==='string'?frame.data:Buffer.from(frame.data).toString('utf8'));value.model='codlet-intercepted-model';return JSON.stringify(value);},
      serverToClient(frame){counts.serverFrames++;return (typeof frame.data==='string'?frame.data:Buffer.from(frame.data).toString('utf8')).replaceAll('codlet-original-response','codlet-modified-response');}
    };}
  });
  context.rpc.provide({name:'codlet.compat.fixture',api:1,scope:'runtime'},'status',async()=>({baseUrl,counts,traffic:await context.traffic.inspect()}));
};
exports.deactivate=async()=>{await interceptor?.close();};
