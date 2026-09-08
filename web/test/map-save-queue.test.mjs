import { test, describe, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createMapSaveQueue } from '../public/map-save-queue.js';

const settle = async()=>{
  // The queue schedules save() through a microtask and each completion can
  // start the next revision through another microtask.
  for(let i=0;i<6;i++) await Promise.resolve();
};

beforeEach(()=>mock.timers.enable({apis:['setTimeout']}));
afterEach(()=>mock.timers.reset());

function controlledSave(){
  const calls=[];
  const waiting=[];
  const save=snapshot=>new Promise((resolve,reject)=>{
    calls.push(snapshot);
    waiting.push({resolve,reject});
  });
  return {calls, waiting, save};
}

describe('createMapSaveQueue',()=>{
  test('serializes one map and never reports the old request as saved',async()=>{
    const {calls,waiting,save}=controlledSave();
    const states=[];
    const queue=createMapSaveQueue({save,onState:(id,state,error)=>states.push({id,state,error,calls:calls.length})});

    queue.schedule({id:'a',text:'old'},0);
    mock.timers.tick(0);
    await settle();
    assert.equal(calls.length,1);

    queue.schedule({id:'a',text:'new'},0);
    mock.timers.tick(0);
    await settle();
    assert.equal(calls.length,1,'the newer revision waits for the in-flight request');

    waiting[0].resolve();
    await settle();
    assert.equal(calls.length,2,'the newer revision starts after the older one settles');
    assert.equal(calls[1].text,'new');

    waiting[1].resolve();
    await settle();
    assert.deepEqual(states.map(event=>event.state),['saving','saved']);
    assert.equal(states.at(-1).calls,2,'saved belongs to the newest request');
  });

  test('captures an immutable JSON snapshot when schedule is called',async()=>{
    let received;
    const queue=createMapSaveQueue({save:async snapshot=>{ received=JSON.parse(JSON.stringify(snapshot)); snapshot.text='mutated by save'; }});
    const map={id:'a',text:'before',nested:{value:1}};
    queue.schedule(map,0);
    map.text='after';
    map.nested.value=2;
    mock.timers.tick(0);
    await settle();
    assert.deepEqual(received,{id:'a',text:'before',nested:{value:1}});
    assert.equal(map.text,'after');
    assert.equal(map.nested.value,2);
  });

  test('flush starts a debounced save and waits for an in-flight request',async()=>{
    const {calls,waiting,save}=controlledSave();
    const queue=createMapSaveQueue({save});
    queue.schedule({id:'a',text:'queued'},1000);

    let finished=false;
    const pendingFlush=queue.flush('a').then(()=>{ finished=true; });
    await settle();
    assert.equal(calls.length,1,'flush bypasses the debounce timer');
    assert.equal(finished,false,'flush remains pending while save is in flight');

    waiting[0].resolve();
    await pendingFlush;
    assert.equal(finished,true);
    mock.timers.tick(1000);
    await settle();
    assert.equal(calls.length,1,'the canceled debounce does not save again');
  });

  test('flush does not swallow a save failure and leaves the retry queued',async()=>{
    const {waiting,save}=controlledSave();
    const queue=createMapSaveQueue({save});
    queue.schedule({id:'a',text:'draft'},0);
    mock.timers.tick(0);
    await settle();
    const error=new Error('offline');
    const pendingFlush=queue.flush('a');
    waiting[0].reject(error);
    await assert.rejects(pendingFlush,err=>err===error);
    mock.timers.tick(3999);
    await settle();
    assert.equal(waiting.length,1,'the failed snapshot waits for the retry delay');
    mock.timers.tick(1);
    await settle();
    assert.equal(waiting.length,2,'retry is scheduled once');
    waiting[1].resolve();
    await settle();
  });

  test('a new edit replaces the failed old snapshot before retry',async()=>{
    const {calls,waiting,save}=controlledSave();
    const states=[];
    const queue=createMapSaveQueue({save,onState:(id,state)=>states.push(state)});
    queue.schedule({id:'a',text:'old'},0);
    mock.timers.tick(0);
    await settle();

    queue.schedule({id:'a',text:'new'},0);
    const error=new Error('temporary');
    waiting[0].reject(error);
    await settle();
    mock.timers.tick(0);
    await settle();
    assert.equal(calls.length,2);
    assert.equal(calls[1].text,'new','the old failed snapshot is never retried');
    mock.timers.tick(4000);
    await settle();
    assert.equal(calls.length,2,'the newer save owns the only retry path');
    waiting[1].resolve();
    await settle();
    assert.equal(states.includes('saved'),true);
  });

  test('remove waits for the in-flight save, cancels pending work, and permits rescheduling after delete failure',async()=>{
    const {calls,waiting,save}=controlledSave();
    const queue=createMapSaveQueue({save});
    queue.schedule({id:'a',text:'first'},0);
    mock.timers.tick(0);
    await settle();
    queue.schedule({id:'a',text:'should-not-save'},100);

    let removed=false;
    const removePromise=queue.remove('a',async id=>{
      assert.equal(id,'a');
      removed=true;
    });
    await settle();
    assert.equal(removed,false,'delete waits for the request already sent');
    waiting[0].resolve();
    await removePromise;
    assert.equal(removed,true);
    mock.timers.tick(4100);
    await settle();
    assert.equal(calls.length,1,'neither pending nor retry work can arrive after delete');

    await assert.rejects(queue.remove('a',async()=>{ throw new Error('delete failed'); }),/delete failed/);
    queue.schedule({id:'a',text:'after-delete-failure'},0);
    mock.timers.tick(0);
    await settle();
    assert.equal(calls.length,2,'a failed deletion does not permanently poison scheduling');
    assert.equal(calls[1].text,'after-delete-failure');
    waiting[1].resolve();
    await settle();
  });

  test('remove reserves an idle id before awaiting removeFn',async()=>{
    const {calls,waiting,save}=controlledSave();
    const queue=createMapSaveQueue({save});
    let releaseDelete;
    const removePromise=queue.remove('b',()=>new Promise(resolve=>{ releaseDelete=resolve; }));
    queue.schedule({id:'b',text:'late'},0);
    releaseDelete();
    await removePromise;
    mock.timers.tick(0);
    await settle();
    assert.equal(calls.length,0,'a save cannot be issued while deletion is pending');
  });

  test('flush without an id waits for every map selected at call time',async()=>{
    const {calls,waiting,save}=controlledSave();
    const queue=createMapSaveQueue({save});
    queue.schedule({id:'a',text:'A'},500);
    queue.schedule({id:'b',text:'B'},500);
    const all=queue.flush();
    await settle();
    assert.equal(calls.length,2);
    waiting[0].resolve();
    waiting[1].resolve();
    await all;
    assert.deepEqual(calls.map(item=>item.id).sort(),['a','b']);
  });
});
