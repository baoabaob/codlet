import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
const root=resolve(import.meta.dirname,'..');
const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8'};
http.createServer(async(req,res)=>{
  try{const name=decodeURIComponent(new URL(req.url,'http://localhost').pathname);if(!/^\/(scripts|bundled)\//.test(name)||name.includes('..')||!types[extname(name)]){res.writeHead(404).end();return;}
    const body=await readFile(resolve(root,'.'+name));res.writeHead(200,{'Content-Type':types[extname(name)],'Cache-Control':'no-store'}).end(body);
  }catch{res.writeHead(404).end();}
}).listen(43190,'127.0.0.1',()=>console.log('http://127.0.0.1:43190/scripts/preview-codlet-gui.html'));
