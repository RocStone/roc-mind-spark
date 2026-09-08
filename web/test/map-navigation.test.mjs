import {test} from 'node:test';
import assert from 'node:assert/strict';
import {extractFunction} from './helpers/load-app-fns.mjs';

function deferred(){let resolve; const promise=new Promise(r=>{resolve=r;}); return {promise,resolve};}

function historyReader(Store){
  return new Function('Store',`
    let map={id:'a'},_mapLoadGeneration=0,_historyRequestGeneration=0;
    const messages=[];
    const toast=message=>messages.push(message);
    const flushPendingSave=()=>Promise.resolve();
    ${extractFunction('loadHistoryVersion')}
    return {read:loadHistoryVersion,messages,switchMap(id){map={id};_mapLoadGeneration++;},cancel(){_historyRequestGeneration++;}};
  `)(Store);
}

test('late history version cannot apply after a map switch',async()=>{
  const pending=deferred(),h=historyReader({version:()=>pending.promise});
  const read=h.read('a',1);
  await Promise.resolve();
  h.switchMap('b'); pending.resolve({id:'a'});
  assert.equal(await read,null);
  assert.deepEqual(h.messages,[]);
});

test('the most recently selected history version wins',async()=>{
  const old=deferred(),latest=deferred();
  const h=historyReader({version:(_id,ref)=>ref===1 ? old.promise : latest.promise});
  const first=h.read('a',1),second=h.read('a',2);
  latest.resolve({id:'a',version:2});
  assert.equal((await second).version,2);
  old.resolve({id:'a',version:1});
  assert.equal(await first,null);
});

test('closing the history panel invalidates an in-flight version read',async()=>{
  const pending=deferred(),h=historyReader({version:()=>pending.promise});
  const read=h.read('a',1); h.cancel(); pending.resolve({id:'a'});
  assert.equal(await read,null);
});

test('restoring undo snapshot clears fields absent from that snapshot and schedules persistence',()=>{
  const h=new Function(`
    let map={nodes:{},rootId:'r',title:'now',color:'red',layout:'down',vars:{x:'1'},links:[{from:'r',to:'b'}],style:'classic'};
    let saves=0,mdMode=false;
    const $=()=>({value:''}); const autoLayout=()=>{};
    const scheduleSave=()=>saves++;
    ${extractFunction('restore')}
    return {restore,get map(){return map;},get saves(){return saves;}};
  `)();
  h.restore(JSON.stringify({nodes:{r:{id:'r',text:'old'}},rootId:'r',title:'old',color:'blue',links:[],vars:{}}));
  assert.equal(h.map.layout,undefined);
  assert.equal(h.map.style,undefined);
  assert.deepEqual(h.map.links,[]);
  assert.deepEqual(h.map.vars,{});
  assert.equal(h.saves,1);
});
