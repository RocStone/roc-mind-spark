// Async body executed by wk-app-eval.swift in the real app page.
// Only the temporary database created by app-e2e.mjs is used.
const results=[];
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function check(condition,message){ if(!condition) throw new Error(message); results.push(message); }
for(let i=0;i<150 && !(typeof map!=='undefined' && map && map.id==='eval-a');i++) await sleep(40);
check(map?.id==='eval-a','real app booted with the isolated SQLite map');
check(MODE==='server','production ServerStore is active');

toggleMdMode(true);
await sleep(280);
const ed=document.getElementById('mdEditor');
check(!!ed && !ed.readOnly,'Markdown editor opened');
const originalZoom=view.k;
ed.value=ed.value.replace('Alpha','Edited 中文🙂');
mdAfterEdit();
toggleMdMode(false); // intentionally before the 300ms debounce
check(map.nodes.a.text.includes('Edited 中文🙂'),'closing Markdown flushes the last edit');
check(map.nodes.a.marker==='⭐' && map.nodes.a.width===220,'Markdown preserves node marker and width');
check(map.links.length===1 && map.links[0].from==='a' && map.links[0].to==='b','Markdown preserves valid cross-links');
await flushPendingSave();
let stored=await Store.get('eval-a');
check(stored.nodes.a.text.includes('Edited 中文🙂'),'last Markdown edit reached SQLite');
check(view.k===originalZoom,'Markdown close preserved canvas zoom');

toggleMdMode(true);
await sleep(260);
// Whole-element selection is how Select All can be represented by WebKit.
const all=document.createRange(); all.selectNodeContents(ed);
getSelection().removeAllRanges(); getSelection().addRange(all);
check(ed.selectionStart===0 && ed.selectionEnd===ed.value.length,'Select All reports the entire Markdown range');
const oldText=ed.value;
ed.setSelectionRange(oldText.length,oldText.length);
ed.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',shiftKey:true,bubbles:true,cancelable:true}));
check(ed.value===oldText+'\n','Shift+Enter inserts a persistent text newline');

// Rebuild a read-only editor without changing its content.
const readonlyText=ed.value;
ed.readOnly=true;
check(ed.value===readonlyText,'read-only Markdown still exposes its text');
ed.dispatchEvent(new KeyboardEvent('keydown',{key:'Tab',bubbles:true,cancelable:true}));
check(ed.value===readonlyText,'read-only Markdown rejects custom Tab edits');
ed.readOnly=false;
toggleMdMode(false);
await flushPendingSave();

const baseSnapshot=mapHistorySnapshot();
map.layout='down'; map.vars={name:'value'}; map.links=[]; pushHistory();
undo();
check(mapHistorySnapshot()===baseSnapshot,'undo restores layout, variables and cross-links together');
await flushPendingSave();
stored=await Store.get('eval-a');
check(stored.links.length===1,'undo is persisted to SQLite');

// A later load wins even if the earlier response arrives after it.
const realGet=Store.get;
let releaseOld;
Store.get=function(id){
  if(id==='eval-b') return new Promise(resolve=>{ releaseOld=()=>realGet.call(this,id).then(resolve); });
  return realGet.call(this,id);
};
const oldLoad=loadMap('eval-b');
while(!releaseOld) await sleep(5);
await loadMap('eval-a');
releaseOld(); await oldLoad;
Store.get=realGet;
check(map.id==='eval-a','late map response cannot replace the latest selection');

// Server failures must not be reported as empty successful reads.
const realFetch=window.fetch;
window.fetch=async function(url,options){
  if(String(url).endsWith('/api/maps')) throw new Error('intentional offline acceptance case');
  return realFetch(url,options);
};
let failed=false;
try{ await Store.list(); }catch(_){ failed=true; }
check(failed,'storage failure is distinguishable from an empty map list');
window.fetch=realFetch;

// Failed saves remain pending, with no false claim of a durable local backup.
const realSave=Store.save;
Store.save=async()=>{ throw new Error('intentional failed save'); };
map.nodes.a.text='Pending before quit'; pushHistory();
failed=false;
try{ await window.rmsFlushPendingEdits(); }catch(_){ failed=true; }
check(failed && document.getElementById('saveText').textContent!=='Saved','quit handshake rejects failed saves');
Store.save=realSave;
await window.rmsFlushPendingEdits();
stored=await Store.get('eval-a');
check(stored.nodes.a.text==='Pending before quit','retry flushes the newest draft without reloading the page');

// Preview must be read-only and switching away must end preview ownership.
const versions=await Store.history('eval-a');
await previewVersion('eval-a',versions[0].ts,null);
check(READONLY && !!_historyPreview,'version preview is read-only');
await loadMap('eval-b');
cancelHistoryPreview();
check(map.id==='eval-b' && !READONLY && !_historyPreview,'switching maps cancels the historical preview');

// A late history read cannot replace another map.
await loadMap('eval-a');
const realVersion=Store.version;
let releaseVersion;
Store.version=function(id,ref){return new Promise(resolve=>{releaseVersion=()=>realVersion.call(this,id,ref).then(resolve);});};
const preview=previewVersion('eval-a',versions[0].ts,null);
while(!releaseVersion) await sleep(5);
await loadMap('eval-b');
releaseVersion(); await preview;
Store.version=realVersion;
check(map.id==='eval-b' && !_historyPreview,'late history response cannot replace the active map');

await window.rmsFlushPendingEdits();
return JSON.stringify({environment:'WKWebView + production app + isolated Node/SQLite',passed:results.length,checks:results},null,2);
