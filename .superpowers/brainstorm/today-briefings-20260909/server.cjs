// Static mockup server. Serves this directory only; no app or database access.
const http=require('node:http');
const fs=require('node:fs');
const path=require('node:path');
const types={'.html':'text/html','.css':'text/css','.js':'text/javascript','.ttf':'font/ttf','.png':'image/png'};
http.createServer((req,res)=>{
  if(!['GET','HEAD'].includes(req.method)){res.writeHead(405);res.end();return;}
  let pathname;try{pathname=decodeURIComponent(new URL(req.url,'http://localhost').pathname);}catch{res.writeHead(400);res.end();return;}
  const file=path.resolve(__dirname,'.'+(pathname==='/'?'/index.html':pathname));
  if(!file.startsWith(__dirname+path.sep)||!types[path.extname(file)]){res.writeHead(404);res.end();return;}
  fs.readFile(file,(error,data)=>{if(error){res.writeHead(404);res.end();return;}res.writeHead(200,{'Content-Type':types[path.extname(file)],'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(req.method==='HEAD'?undefined:data);});
}).listen(8767,'127.0.0.1',()=>console.log('Today briefing study ready on http://127.0.0.1:8767'));
