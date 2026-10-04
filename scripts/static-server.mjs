import http from 'node:http';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
const root=path.resolve('dist');
http.createServer(async(req,res)=>{try{let url=decodeURIComponent(new URL(req.url,'http://localhost').pathname);if(url.startsWith('/repository-test/'))url=url.slice('/repository-test'.length);if(url==='/')url='/index.html';const file=path.resolve(root,'.'+url);if(!file.startsWith(root+path.sep))throw Error('Invalid path');const content=await readFile(file);const mime={'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json','.txt':'text/plain','.svg':'image/svg+xml'};res.setHeader('Content-Type',mime[path.extname(file)]??'application/octet-stream');res.end(content);}catch{res.writeHead(404);res.end('Not found');}}).listen(4180,'127.0.0.1',()=>console.log('Static root and repository-subpath test server: http://127.0.0.1:4180'));
