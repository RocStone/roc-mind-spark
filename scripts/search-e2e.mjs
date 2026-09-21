#!/usr/bin/env node
// WKWebView acceptance for find: collapsed hits, Enter cycling, fold restore, ⌘F toggle.
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp,rm} from 'node:fs/promises';
import {createServer} from 'node:net';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';

const root=dirname(dirname(fileURLToPath(import.meta.url)));
const temp=await mkdtemp(join(tmpdir(),'rms-search-e2e-'));
const reserve=createServer(); reserve.listen(0,'127.0.0.1'); await once(reserve,'listening');
const port=reserve.address().port;
await new Promise(resolve=>reserve.close(resolve));
const url=`http://127.0.0.1:${port}`;
const server=spawn(process.execPath,['--disable-warning=ExperimentalWarning',join(root,'web/server.js')],{
  env:{...process.env,PORT:String(port),DB_PATH:join(temp,'maps.db'),OPS_LOG_PATH:join(temp,'ops.jsonl'),PUBLIC:join(root,'web/public')},
  stdio:['ignore','pipe','pipe']
});
let serverLog='';
server.stdout.on('data',chunk=>{serverLog+=chunk;});
server.stderr.on('data',chunk=>{serverLog+=chunk;});
try{
  let ready=false;
  for(let i=0;i<100;i++){
    try{ if((await fetch(url+'/healthz')).ok){ready=true;break;} }catch(_){}
    if(server.exitCode!=null) break;
    await new Promise(resolve=>setTimeout(resolve,40));
  }
  if(!ready) throw new Error('Isolated server did not start: '+serverLog);
  const map={
    id:'search-a',
    title:'search-a',
    color:'#e0613a',
    rootId:'root',
    nodes:{
      root:{id:'root',text:'Mind',parent:null,side:'root',x:0,y:0},
      tools:{id:'tools',text:'tools',parent:'root',side:'right',x:160,y:0,collapsed:true},
      kernel:{id:'kernel',text:'linux kernel',parent:'tools',side:'right',x:320,y:0},
      other:{id:'other',text:'other',parent:'tools',side:'right',x:320,y:40},
      os:{id:'os',text:'os',parent:'root',side:'right',x:160,y:80,collapsed:true},
      distro:{id:'distro',text:'linux distro',parent:'os',side:'right',x:320,y:80},
      mint:{id:'mint',text:'linux mint',parent:'root',side:'right',x:160,y:160}
    },
    links:[]
  };
  const response=await fetch(url+'/api/maps/search-a',{
    method:'PUT',
    headers:{'content-type':'application/json'},
    body:JSON.stringify(map)
  });
  if(!response.ok) throw new Error('Could not seed isolated map: '+response.status);
  const runner=spawn('swift',[
    join(root,'scripts/wk-app-eval.swift'),
    url+'/?map=search-a',
    join(root,'scripts/search-e2e.js')
  ],{stdio:'inherit'});
  const [code]=await once(runner,'exit');
  if(code!==0) throw new Error('WK search acceptance failed: '+code);
}finally{
  if(server.exitCode==null){server.kill('SIGTERM'); await once(server,'exit');}
  await rm(temp,{recursive:true,force:true});
}
