#!/usr/bin/env node
// --native-input additionally checks the installed IME and temporarily switches input sources.
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp,rm} from 'node:fs/promises';
import {createServer} from 'node:net';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';

const root=dirname(dirname(fileURLToPath(import.meta.url)));
const temp=await mkdtemp(join(tmpdir(),'rms-app-e2e-'));
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
  for(const id of ['eval-a','eval-b']){
    const map={id,title:id,color:'#e0613a',rootId:'root',nodes:{
      root:{id:'root',text:'Root',parent:null,side:'root',x:0,y:0},
      a:{id:'a',text:'Alpha',parent:'root',side:'right',x:160,y:0,marker:'⭐',width:220},
      b:{id:'b',text:'Beta',parent:'root',side:'left',x:-160,y:0}
    },links:[{from:'a',to:'b'}]};
    const response=await fetch(url+'/api/maps/'+id,{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify(map)});
    if(!response.ok) throw new Error('Could not seed isolated map: '+response.status);
  }
  const runner=spawn('swift',[join(root,'scripts/wk-app-eval.swift'),url+'/?map=eval-a',join(root,'scripts/app-e2e.js'),...(process.argv.includes('--native-input') ? ['--native-input'] : [])],{stdio:'inherit'});
  const [code]=await once(runner,'exit');
  if(code!==0) throw new Error('WK acceptance runner failed: '+code);
}finally{
  if(server.exitCode==null){server.kill('SIGTERM'); await once(server,'exit');}
  await rm(temp,{recursive:true,force:true});
}
