/*
 * Serialize map saves without coupling persistence to the editor UI.
 *
 * This file is loaded as a plain browser script, so the factory is exposed on
 * globalThis.  The CommonJS export keeps the same small module testable from
 * the Node test suite without adding a bundler or another dependency.
 */
function createMapSaveQueue(options){
  options = options || {};
  const save = options.save;
  const onState = typeof options.onState === 'function' ? options.onState : null;
  if(typeof save !== 'function') throw new TypeError('createMapSaveQueue requires a save function');

  // There is one entry per map id.  `pending` is always the newest snapshot
  // that has not started yet; `inflight` is the only request allowed to call
  // save for that id.  `generation` invalidates all callbacks after remove().
  const entries = new Map();

  function emit(entry, state, error){
    if(entry.lastState === state) return;
    entry.lastState = state;
    if(!onState) return;
    try{ onState(entry.id, state, error); }catch(_){
      // A status renderer must not break persistence.  The save result is
      // tracked independently and is still observable through flush().
    }
  }

  function cancelTimer(entry, name){
    const timer = entry[name];
    if(timer != null){ clearTimeout(timer); entry[name] = null; }
  }

  function cleanIfIdle(entry){
    if(entry.removing || entry.inflight || entry.pending || entry.timer != null || entry.retryTimer != null) return;
    // Keep the entry only while it has work or a remove operation.  A later
    // schedule creates a fresh status stream and correctly reports `saving`.
    if(entries.get(entry.id) === entry) entries.delete(entry.id);
  }

  function startPending(entry, generation){
    if(entries.get(entry.id) !== entry || entry.removing || entry.generation !== generation) return null;
    if(entry.inflight) return entry.inflight;
    if(!entry.pending){ cleanIfIdle(entry); return null; }

    // A prior in-flight request may have completed while a newer edit's
    // debounce timer was still waiting.  Starting that newer snapshot now
    // supersedes the timer; leave only one path to the save attempt.
    cancelTimer(entry, 'timer');

    const item = entry.pending;
    entry.pending = null;
    const op = { generation, revision:item.revision, snapshot:item.snapshot, settled:null };
    entry.inflight = op;
    emit(entry, 'saving');

    // Promise.resolve().then also captures a synchronous exception from save.
    // The internal promise always fulfills, preventing an ignored background
    // save from becoming an unhandled rejection.  flush() rethrows the stored
    // error after it has waited for this operation to settle.
    op.settled = Promise.resolve().then(()=>save(op.snapshot)).then(
      value=>{
        op.ok = true;
        op.value = value;
        finishSuccess(entry, op);
        return op;
      },
      error=>{
        op.ok = false;
        op.error = error;
        finishFailure(entry, op);
        return op;
      }
    );
    return op;
  }

  function finishSuccess(entry, op){
    if(entry.inflight === op) entry.inflight = null;
    // A remove invalidates this callback.  It still waits on op.settled, but
    // must never start a new save or publish a status for a deleted map.
    if(entries.get(entry.id) !== entry || entry.removing || entry.generation !== op.generation) return;

    // A newer edit is already queued.  The old completion cannot report
    // `saved`; start the newest immutable snapshot immediately instead.
    if(entry.pending){
      startPending(entry, entry.generation);
      return;
    }
    emit(entry, 'saved');
    cleanIfIdle(entry);
  }

  function scheduleRetry(entry, generation){
    if(entries.get(entry.id) !== entry || entry.removing || entry.generation !== generation) return;
    // A normal schedule timer for a newer edit already owns the next attempt.
    // Keeping it avoids a second timer and prevents retry storms.
    if(entry.timer != null || entry.retryTimer != null) return;
    entry.retryTimer = setTimeout(()=>{
      entry.retryTimer = null;
      if(entries.get(entry.id) !== entry || entry.removing || entry.generation !== generation) return;
      if(!entry.pending) return;
      emit(entry, 'retrying', entry.lastError);
      startPending(entry, generation);
    }, 4000);
  }

  function finishFailure(entry, op){
    if(entry.inflight === op) entry.inflight = null;
    if(entries.get(entry.id) !== entry || entry.removing || entry.generation !== op.generation) return;

    // Do not replace a newer edit with the failed older snapshot.  If no newer
    // edit exists, retaining this exact snapshot is what makes retry reliable.
    if(!entry.pending || entry.pending.revision < op.revision){
      entry.pending = { revision:op.revision, snapshot:op.snapshot };
    }
    entry.lastError = op.error;
    if(entry.pending.revision === op.revision) emit(entry, 'failed', op.error);
    else emit(entry, 'retrying', op.error);
    scheduleRetry(entry, op.generation);
  }

  function schedule(map, delay=600){
    if(!map || map.id == null) throw new TypeError('schedule requires a map with an id');
    const id = map.id;
    // Serialize at the API boundary.  Store.save is allowed to mutate the
    // snapshot (for example by adding `updated`) without touching the editor's
    // live map or a later pending edit.
    const snapshot = JSON.parse(JSON.stringify(map));
    let entry = entries.get(id);
    if(!entry){
      entry = { id, generation:0, revision:0, timer:null, retryTimer:null,
        pending:null, inflight:null, removing:false, removePromise:null,
        lastState:null, lastError:null };
      entries.set(id, entry);
    }
    // UI events can arrive while a delete request is awaiting the server.  A
    // save during that interval belongs to a map that is being removed, so
    // drop it quietly; after a failed delete, removing is cleared and the next
    // schedule() is accepted normally.
    if(entry.removing) return;
    entry.revision += 1;
    entry.pending = { revision:entry.revision, snapshot };
    entry.lastError = null;
    cancelTimer(entry, 'retryTimer');
    cancelTimer(entry, 'timer');

    const generation = entry.generation;
    const wait = Number(delay);
    const ms = Number.isFinite(wait) ? Math.max(0, wait) : 0;
    emit(entry, 'saving');
    entry.timer = setTimeout(()=>{
      entry.timer = null;
      startPending(entry, generation);
    }, ms);
  }

  async function flushEntry(entry){
    while(entries.get(entry.id) === entry && !entry.removing){
      // A flush bypasses both debounce and the four-second retry delay.
      cancelTimer(entry, 'timer');
      cancelTimer(entry, 'retryTimer');
      if(!entry.inflight && entry.pending) startPending(entry, entry.generation);
      const op = entry.inflight;
      if(op){
        await op.settled;
        if(!op.ok) throw op.error;
        continue;
      }
      if(entry.pending) continue;
      cleanIfIdle(entry);
      return;
    }
  }

  async function flush(id){
    const selected = id == null ? [...entries.values()] : (entries.has(id) ? [entries.get(id)] : []);
    const results = await Promise.allSettled(selected.map(entry=>flushEntry(entry)));
    const failure = results.find(result=>result.status==='rejected');
    if(failure) throw failure.reason;
  }

  function remove(id, removeFn){
    if(typeof removeFn !== 'function') return Promise.reject(new TypeError('remove requires a remove function'));
    let entry = entries.get(id);
    if(!entry){
      // The tombstone must exist before the first await.  Otherwise a caller
      // can schedule the same id while removeFn is pending and issue a late
      // save that recreates the map being deleted.
      entry = { id, generation:0, revision:0, timer:null, retryTimer:null,
        pending:null, inflight:null, removing:false, removePromise:null,
        lastState:null, lastError:null };
      entries.set(id, entry);
    }
    if(entry.removePromise) return entry.removePromise;

    // Invalidate callbacks before waiting.  This prevents an in-flight save's
    // completion from starting a queued save while deletion is in progress.
    entry.removing = true;
    entry.generation += 1;
    cancelTimer(entry, 'timer');
    cancelTimer(entry, 'retryTimer');
    entry.pending = null;
    const inflight = entry.inflight;

    entry.removePromise = (async()=>{
      // Wait for the request that was already sent.  Its error does not stop
      // deletion: after it has settled, no callback can issue a late write.
      if(inflight) await inflight.settled;
      cancelTimer(entry, 'timer');
      cancelTimer(entry, 'retryTimer');
      entry.pending = null;
      try{
        await removeFn(id);
      }catch(error){
        // The map was not deleted remotely.  Leave a usable entry so a later
        // schedule() can persist a fresh snapshot after the delete failure.
        entry.removing = false;
        entry.removePromise = null;
        entry.generation += 1;
        throw error;
      }
      if(entries.get(id) === entry) entries.delete(id);
    })();
    return entry.removePromise;
  }

  return { schedule, flush, remove };
}

if(typeof module === 'object' && module.exports){
  module.exports.createMapSaveQueue = createMapSaveQueue;
}else if(typeof globalThis !== 'undefined'){
  globalThis.createMapSaveQueue = createMapSaveQueue;
}
