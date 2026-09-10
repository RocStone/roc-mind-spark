// Async body executed by wk-app-eval.swift in the real app page.
// Only the temporary database created by app-e2e.mjs is used.
const results=[];
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function check(condition,message){ if(!condition) throw new Error(message); results.push(message); }
for(let i=0;i<150 && !(typeof map!=='undefined' && map && map.id==='eval-a');i++) await sleep(40);
check(map?.id==='eval-a','real app booted with the isolated SQLite map');
check(MODE==='server','production ServerStore is active');

// Exercise the same lifted text host used by the installed macOS shell.
document.documentElement.classList.add('rms-wk');
select('root',false);
window.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true,cancelable:true}));
check(sel==='a','arrow navigation selects a node before typing');
document.body.dispatchEvent(new KeyboardEvent('keydown',{key:'x',code:'KeyX',bubbles:true,cancelable:true}));
await sleep(180);
let liveHost=openEditorTextEl();
check(!!liveHost && liveHost.closest('.edit-float') && document.activeElement===liveHost,'first typed character keeps focus in the live WK editor');
check(liveHost.textContent==='x' && liveHost.contains(getSelection().anchorNode),'first character and caret stay in the editable host');
insertEditorText(liveHost,'yz',false); emitEditorInput(liveHost);
await sleep(180);
check(openEditorTextEl()===liveHost && liveHost.textContent==='xyz','continued Latin typing preserves the same editing session');
const caret=document.createRange(); caret.setStart(liveHost.firstChild,1); caret.collapse(true);
getSelection().removeAllRanges(); getSelection().addRange(caret);
window.rmsFlushForHide();
liveHost.blur();
await flushPendingSave();
check(openEditorTextEl()===liveHost && document.querySelector('.node.editing'),'hide saves without dismantling the editor');
check((await Store.get('eval-a')).nodes.a.text==='xyz','hidden editor draft reaches SQLite');
window.rmsRestoreAfterShow();
check(document.activeElement===liveHost && getSelection().anchorOffset===1,'show restores the editor and its exact caret');
insertEditorText(liveHost,'中',false); emitEditorInput(liveHost);
check(liveHost.textContent==='x中yz','typing after show continues at the preserved caret');
commitOpenEdit();
select('a',false);
document.body.dispatchEvent(new KeyboardEvent('keydown',{key:'Process',keyCode:229,isComposing:true,bubbles:true,cancelable:true}));
liveHost=openEditorTextEl();
check(!!liveHost && document.activeElement===liveHost,'initial IME key opens the selected node editor');
liveHost.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true,data:''}));
liveHost.textContent='中文';
window.rmsFlushForHide();
check(openEditorTextEl()===liveHost && liveHost._rmsComposing,'hide preserves an in-progress IME composition');
liveHost.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:'中文'}));
liveHost.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));
await sleep(180);
check(openEditorTextEl()===liveHost,'IME confirmation does not exit editing or create a node');
insertEditorText(liveHost,'输入',true); emitEditorInput(liveHost);
check(openEditorTextEl()===liveHost && liveHost.textContent==='输入','Chinese text remains editable after composition');
commitOpenEdit();
map.nodes.a.text='Alpha'; pushHistory(); render();

// Opt-in native input checks temporarily switch the keyboard input source.
if(nativeInputAcceptance){
const nativeEval=body=>window.webkit.messageHandlers.rmsEval.postMessage(body);
select('a',false);
check(await nativeEval({inputSource:'latin'}),'native keyboard test selected an installed Latin input source');
await sleep(200);
await nativeEval({key:'j',code:38}); await sleep(180);
await nativeEval({key:'k',code:40}); await sleep(180);
check(openEditorTextEl()?.textContent==='jk','real AppKit Latin keystrokes keep the node editor active');
commitOpenEdit();
const hasPinyin=await nativeEval({inputSource:'pinyin'});
if(hasPinyin){
  const probe=document.createElement('textarea'); document.body.appendChild(probe); probe.focus();
  await sleep(250);
  for(const [key,code] of [['n',45],['i',34],[' ',49]]){ await nativeEval({key,code}); await sleep(120); }
  if(!/[\u3400-\u9fff]/.test(probe.value)){
    await nativeEval({key:'Shift',code:56}); await sleep(150);
    probe.value='';
    for(const [key,code] of [['n',45],['i',34],[' ',49]]){ await nativeEval({key,code}); await sleep(120); }
  }
  check(/[\u3400-\u9fff]/.test(probe.value),'installed Pinyin source is in Chinese mode in a standard textarea: '+probe.value);
  probe.remove();
  await sleep(250);
  select('root',false);
  await nativeEval({key:'ArrowRight',code:124}); await sleep(180);
  check(sel==='a' && pendingNodeTyping(),'real arrow navigation prepares the selected node for IME input');
  await nativeEval({inputSource:'pinyin'}); await sleep(500);
  const actualInputSource=await nativeEval({currentInputSource:true});
  for(const [key,code] of [['n',45],['i',34],['h',4],['a',0],['o',31],[' ',49]]){
    await nativeEval({key,code}); await sleep(100);
  }
  await sleep(250);
  check(!!openEditorTextEl() && /^[\u3400-\u9fff]+$/.test(openEditorTextEl().textContent.trim()),'real installed Pinyin IME keeps the first letter in the Chinese composition ('+openEditorTextEl()?.textContent+' source='+actualInputSource+')');
  await nativeEval({key:'n',code:45}); await sleep(100);
  await nativeEval({key:'i',code:34}); await sleep(100);
  await nativeEval({key:' ',code:49}); await sleep(180);
  check(!!openEditorTextEl(),'real Pinyin IME remains editable for a second word');
  commitOpenEdit();
}
await nativeEval({inputSource:'latin'});
}
map.nodes.a.text='Alpha'; pushHistory(); render();

select('a',false);
check(pendingNodeTyping() && !document.querySelector('.node.editing'),'selection prepares input without entering visible editing mode');
check(!openClipboardTarget(),'prepared input leaves node clipboard ownership unchanged');
stage.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,cancelable:true,button:0,clientX:10,clientY:10}));
window.dispatchEvent(new MouseEvent('mouseup',{bubbles:true,button:0}));
check(!sel && !openEditorTextEl(),'clicking the canvas clears the prepared input host');
select('a',false); toggleMultiSelect('b');
check(!pendingNodeTyping(),'multi-selection releases the single-node input host');
clearMultiSelect();
check(pendingNodeTyping(),'leaving multi-selection prepares typing again');


const priorColors=Object.fromEntries(Object.entries(map.nodes).map(([id,node])=>[id,node.color]));
window.rmsOpenSettings();
const colorToggle=document.getElementById('rmsLevelColorsToggle');
check(!!colorToggle && !colorToggle.checked,'settings exposes the per-map color switch');
colorToggle.checked=true; colorToggle.dispatchEvent(new Event('change',{bubbles:true}));
check(map.sameLevelColors && map.nodes.a.color===map.nodes.b.color,'enabling the switch recolors siblings across branches');
document.querySelector('.rms-settings .vf-close').click();
const child=insertChildNode('a'); const cousin=insertChildNode('b'); pushHistory(); autoLayout();
check(map.nodes[child].color===map.nodes[cousin].color && map.nodes[child].color!==map.nodes.a.color,'new nodes follow their own depth color');
await flushPendingSave();
await loadMap('eval-b');
check(!window.rmsGetLevelColorsState().enabled,'another map retains its own default color mode');
await loadMap('eval-a');
check(map.sameLevelColors && map.nodes[child].color===map.nodes[cousin].color,'color mode and node colors survive a SQLite reload');
map.nodes[child].parent='root'; pushHistory(); autoLayout();
check(map.nodes[child].color===map.nodes.a.color,'moving a node updates its depth color');
window.rmsSetLevelColorsEnabled(false);
check(!map.sameLevelColors && map.nodes.a.color===priorColors.a && map.nodes.b.color===priorColors.b,'disabling restores the original independent node colors');
undo(); check(map.sameLevelColors,'undo restores the color mode');
redo(); check(!map.sameLevelColors,'redo restores default color mode');
delete map.nodes[child]; delete map.nodes[cousin]; pushHistory(); autoLayout();
await flushPendingSave();

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

pushHistory();
const baseSnapshot=mapHistorySnapshot();
map.layout='down'; map.vars={name:'value'}; map.links=[]; pushHistory();
undo();
const restoredState=JSON.parse(mapHistorySnapshot()), beforeState=JSON.parse(baseSnapshot);
check(['layout','vars','links'].every(key=>JSON.stringify(restoredState[key])===JSON.stringify(beforeState[key])) && restoredState.nodes.a.text===beforeState.nodes.a.text,'undo restores layout, variables and cross-links together');
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
