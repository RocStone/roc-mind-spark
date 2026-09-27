/* ============================================================
   Roc Mind Spark — storage.
   ServerStore talks to the local Node server (`web/server.js`, SQLite)
   that the Mac app supervises on 127.0.0.1:3034.
   ============================================================ */

/* ------------------------------------------------------------
   On `catch(e){}` in this file.

   Empty catches here are deliberate, not oversights — but only for
   operations where failing is genuinely a non-event:

     - best-effort localStorage/sessionStorage writes (view state, UI
       scale, theme, backup caches). Storage can be full or blocked by
       privacy settings; every read path already copes with the value
       being absent, so there is nothing useful to say.
     - DOM teardown (`el.remove()`, closing popups) where the element
       may already be gone.
     - cosmetic niceties (caret placement, history.replaceState URL
       tidying) that no behaviour depends on.

   Anything that can lose the user's work, leave local and remote state
   disagreeing, or make a click the user just made do nothing MUST NOT
   be swallowed. Those log via console.warn, and additionally toast()
   when the user initiated the action and would otherwise see no
   response at all. A silent failure there is how a real bug once
   presented as "the button just does nothing".

   If you are adding a new catch, decide which of those two groups it
   is in. When in doubt, warn — noise in the console is cheaper than an
   invisible failure.
   ------------------------------------------------------------ */
// Overlay loads index.html from disk. API still lives on the local Node
// server. HTTP pages keep relative URLs.
const API_BASE=(typeof location!=='undefined' && location.protocol==='file:')
  ? 'http://127.0.0.1:3034' : '';
function apiUrl(path){
  if(!path) return path;
  if(API_BASE && path.charAt(0)==='/') return API_BASE+path;
  return path;
}

const ServerStore = {
  async _j(url,opt){
    const controller=new AbortController();
    const timeout=setTimeout(()=>controller.abort(),4000);
    try{
      const r=await fetch(apiUrl(url),{...opt,signal:controller.signal});
      if(!r.ok){ const error=new Error('HTTP '+r.status); error.status=r.status; throw error; }
      return r.status===204 ? null : await r.json();
    }finally{ clearTimeout(timeout); }
  },
  async list(){ return this._j('/api/maps'); },
  async get(id){
    try{ return await this._j('/api/maps/'+encodeURIComponent(id)); }
    catch(e){ if(e.status===404) return null; throw e; }
  },
  async save(map){
    map.updated=Date.now();
    // PUT is already an upsert on the local server. Repeating a failed PUT as
    // POST hides the original failure and can write a second, stale snapshot.
    await this._j('/api/maps/'+encodeURIComponent(map.id),{
      method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(map)
    });
  },
  async remove(id){ await this._j('/api/maps/'+encodeURIComponent(id),{method:'DELETE'}); },
  async history(id){ return this._j('/api/maps/'+encodeURIComponent(id)+'/versions'); },
  async version(id,ref){ return this._j('/api/maps/'+encodeURIComponent(id)+'/versions/'+encodeURIComponent(ref)); },
  // Close the current version window so the next save is its own version.
  async sealVersion(id){ await this._j('/api/maps/'+encodeURIComponent(id)+'/versions/seal',{method:'POST'}); }

};

let Store;
// True only while a version-history preview is open (previewVersion sets it,
// cancelHistoryPreview restores it). Editing paths check it and bail out.
let READONLY = false;
// Wrap document.execCommand so missing-method environments (older Safari without
// the legacy API, jsdom-based tests, etc.) silently no-op instead of throwing.
// All inline-formatting toolbar buttons funnel through here.
function execCmd(cmd, value){
  if(typeof document.execCommand !== 'function') return false;
  try { return document.execCommand(cmd, false, value); }
  catch(e){ console.warn('execCommand failed:', cmd, e); return false; }
}

async function initStore(){
  // The Mac product always talks to its own local server. The native
  // supervisor owns server startup/recovery.
  Store=ServerStore;
}

/* ---------- helpers ---------- */
const $=s=>document.querySelector(s);
// Letter prefix: an all-digit id is an "array index" key, and JS objects
// enumerate those first in numeric order — that would reorder siblings.
const uid=()=>'n'+Math.random().toString(36).slice(2,9);
// Per-node marker badges (issue #13). A deliberately small, curated set
// rather than a full emoji keyboard: these are meant to be scannable at a
// glance across a whole map, which stops working once there are hundreds of
// near-identical glyphs. Stored as the literal character in n.marker, so no
// mapping table has to stay in sync with saved maps.
// NOTE the \u{...} form for anything above U+FFFF: plain \uXXXX takes exactly
// four hex digits, so '\u1F6A9' silently parses as '\u1F6A' followed by a
// literal '9' and renders as garbage rather than a flag.
// labelKey → i18n.js; label is the English fallback. Nodes store only `c`.
const MARKERS=[
  {c:'\u2B50',    label:'Star',     labelKey:'mkStar'},     {c:'\u2757',    label:'Important', labelKey:'mkImportant'},
  {c:'\u2753',    label:'Question', labelKey:'mkQuestion'}, {c:'\u{1F6A9}', label:'Flag',      labelKey:'mkFlag'},
  {c:'\u{1F525}', label:'Hot',      labelKey:'mkHot'},      {c:'\u{1F4A1}', label:'Idea',      labelKey:'mkIdea'},
  {c:'\u{1F440}', label:'Review',   labelKey:'mkReview'},   {c:'\u{1F512}', label:'Blocked',   labelKey:'mkBlocked'},
  {c:'\u2705',    label:'Approved', labelKey:'mkApproved'}, {c:'\u274C',    label:'Rejected',  labelKey:'mkRejected'},
  {c:'\u26A0',    label:'Risk',     labelKey:'mkRisk'},     {c:'\u{1F3AF}', label:'Goal',      labelKey:'mkGoal'},
  {c:'\u{1F4CC}', label:'Pinned',   labelKey:'mkPinned'},   {c:'\u23F3',    label:'In progress', labelKey:'mkInProgress'},
  {c:'\u{1F48E}', label:'Finding',  labelKey:'mkFinding'},
];
function markerLabel(m){ return m ? rmsTr(m.labelKey, m.label) : ''; }
const NODE_COLORS=['#ffffff','#ffe2d6','#ffedc2','#dcefce','#cfe9e6','#d8e0fb','#efd9f2','#e9e2d6'];
const PALETTE=['#e0613a','#2f6f6a','#c98a1a','#5a7d3a','#3a6ea5','#9b4f96','#8a8175'];

// Positions an already-appended `position:fixed` popup against an anchor element
// or rect, fully clamped to the CURRENT viewport on every side — recomputed fresh
// from live geometry each call, never a size/side baked in when the popup happened
// to first get built. Prefers opening below (or right-aligned, if `align:'right'`),
// but flips to whichever side actually has room, and caps its own max-height rather
// than running off a short window instead of just clamping X like most ad-hoc call
// sites used to. Same shape works for a toolbar dropdown, a nodebar picker, or a
// bottom-pinned bulk-bar picker (which naturally flips upward since there's more
// room above it than below).
function positionPopup(pop, anchor, opts){
  opts = opts || {};
  const margin = opts.margin!=null ? opts.margin : 8;
  const gap = opts.gap!=null ? opts.gap : 6;
  const align = opts.align || 'left';   // 'left': left edge under the anchor's left edge; 'right': right edge under the anchor's right edge
  pop.style.position='fixed';
  const prevVis=pop.style.visibility;
  pop.style.visibility='hidden'; pop.style.maxHeight='';
  // Self-calibrate the CSS-px <-> getBoundingClientRect-px factor using the popup
  // itself — set a KNOWN CSS left and measure where it actually renders — instead
  // of trusting a separate, always-off-screen probe element (_uiZ()) to behave
  // identically. getBoundingClientRect() can disagree with the CSS px that
  // style.left/top use (zoom, browser/version quirks, OS display scaling).
  const REF = 1000;
  pop.style.left = REF+'px'; pop.style.top = '0px';
  const probe = pop.getBoundingClientRect();
  const z = probe.left>1 ? probe.left/REF : 1;
  // From here on, EVERYTHING stays in raw getBoundingClientRect() space — the
  // anchor, the popup, and the viewport bounds are all measured via the exact
  // same API, so they're internally consistent with each other regardless of
  // what that space actually is relative to CSS px. Converting each measurement
  // to "logical" px individually (dividing every single one by z) risked mixing
  // a converted value with an unconverted one in the same comparison somewhere,
  // which is exactly as wrong as never converting, just by a different amount —
  // only visible once two values disagree enough to flip a clamp decision. The
  // one and only conversion happens at the very end, turning the final raw
  // left/top back into the CSS px that style.left/top actually expects.
  const rr = (anchor && anchor.nodeType===1) ? anchor.getBoundingClientRect() : anchor;
  const pw = probe.width, ph = probe.height;
  const vp = document.documentElement.getBoundingClientRect();
  const viewW = vp.width>1 ? vp.width : window.innerWidth*z;
  const viewH = vp.height>1 ? vp.height : window.innerHeight*z;
  let left = align==='right' ? (rr.right-pw) : rr.left;
  if(left+pw > viewW-margin) left = viewW-pw-margin;
  if(left < margin) left = margin;
  const spaceBelow = viewH-(rr.bottom+gap)-margin;
  const spaceAbove = rr.top-gap-margin;
  let top;
  if(ph<=spaceBelow || spaceBelow>=spaceAbove){
    top = rr.bottom+gap;
    pop.style.maxHeight = Math.max(120, (viewH-top-margin)/z)+'px';
  } else {
    pop.style.maxHeight = Math.max(120, spaceAbove/z)+'px';
    top = Math.max(margin, rr.top-gap-Math.min(ph,spaceAbove));
  }
  pop.style.left=(left/z)+'px'; pop.style.top=(top/z)+'px';
  pop.style.visibility=prevVis;
  return {left:left/z, top:top/z};
}

/* ---------- app state ---------- */
let map=null;                 // current map {id,title,color,rootId,nodes:{}}
let view={x:80,y:0,k:1};      // pan/zoom
// Operation log: short lines the App writes to a background file so a later
// bug report can be replayed. Pointer-move / pan / hover are not recorded.
let _opLogQ=[], _opLogT=0;
function opLog(op, extra){
  const rec={t:Date.now(), op:String(op||'?').slice(0,32)};
  try{ if(map && map.id) rec.map=map.id; }catch(e){}
  if(extra && typeof extra==='object'){
    for(const k of ['id','parent','sel','from','to','key','layout','look','theme','zoom','dir','mode','text']){
      if(extra[k]==null || extra[k]==='') continue;
      rec[k]=typeof extra[k]==='string' ? String(extra[k]).replace(/\s+/g,' ').trim().slice(0,40) : extra[k];
    }
  }
  _opLogQ.push(rec);
  if(_opLogQ.length>40) _opLogQ.splice(0, _opLogQ.length-40);
  if(_opLogT) return;
  _opLogT=setTimeout(flushOpLog, 200);
}
function flushOpLog(){
  _opLogT=0;
  if(!_opLogQ.length) return;
  const batch=_opLogQ.splice(0,40);
  try{
    fetch(apiUrl('/api/ops-log'),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({events:batch}),keepalive:true}).catch(()=>{});
  }catch(e){}
}
if(typeof window!=='undefined' && window.addEventListener){
  window.addEventListener('pagehide', ()=>{ try{ flushOpLog(); }catch(e){} });
}
let userZoom=null;            // user-chosen camera zoom, preserved across map switches
// Display size (--ui-zoom) is chrome density only. It does not scale .app,
// so clientX and getBoundingClientRect already live in the same CSS-pixel
// space as #stage / #viewport. Call sites that still divide by _uiZ() keep
// working because this is always 1.
function _uiZ(){ return 1; }
function _evtXY(e){
  return {x:e.clientX, y:e.clientY, rawX:e.clientX, rawY:e.clientY};
}
function _stageSize(){
  if(stage && stage.offsetWidth>1) return {w:stage.offsetWidth, h:stage.offsetHeight};
  const r=stage.getBoundingClientRect();
  return {w:r.width, h:r.height};
}
function _stagePoint(cx,cy){
  const r=stage.getBoundingClientRect();
  return {x:cx-r.left, y:cy-r.top};
}
// Per-map camera (zoom + pan), saved in localStorage so each map reopens exactly
// where the user left it. Kept out of the map object so it never bumps the map's
// "updated" time or reshuffles the sidebar.
let _svTimer=null;
function saveMapView(){ clearTimeout(_svTimer); _svTimer=setTimeout(_saveMapViewNow, 150); }
window.addEventListener('pagehide', ()=>{ clearTimeout(_svTimer); try{ _saveMapViewNow(); }catch(e){} });
function _saveMapViewNow(){
  if(!map || !map.id || READONLY) return;
  // Store the map-space point at the viewport CENTRE (plus zoom), not the raw pan
  // offset, so the same framing reproduces on any screen size — a map reopened on
  // a different browser/device/window lands consistently instead of shifted.
  const {w:SW,h:SH}=_stageSize();
  const cx=(SW/2 - view.x)/view.k, cy=(SH/2 - view.y)/view.k;
  if(!isFinite(cx)||!isFinite(cy)) return;
  try{ localStorage.setItem('mindspark:view:'+map.id, JSON.stringify({k:view.k, cx, cy})); }catch(e){}
}
function loadMapView(id){
  try{ const v=JSON.parse(localStorage.getItem('mindspark:view:'+id)||'null');
    if(v && isFinite(v.k) && ((isFinite(v.cx)&&isFinite(v.cy)) || (isFinite(v.x)&&isFinite(v.y)))) return v; }catch(e){}
  return null;
}
// Stage size when the camera was last framed — lets a live window resize keep the
// same map-point centred instead of letting the map drift sideways.
let _prevStage=null, _prevStageRect=null;
function _markStage(){
  const z=_stageSize(); if(z.w>1&&z.h>1) _prevStage=z;
  try{
    const r=stage.getBoundingClientRect();
    if(r.width>1 && r.height>1) _prevStageRect={left:r.left, top:r.top, right:r.right, bottom:r.bottom, width:r.width, height:r.height};
  }catch(e){}
  // The cache just changed — anything that read it earlier in this same gesture (e.g.
  // applyView()'s last frame, which runs BEFORE this) may have drawn against the old
  // value. Re-apply the two things that depend on it, once, now that it's fresh —
  // cheap since this only fires at gesture-settle, not per frame.
  if(typeof updateMinimapViewport==='function') updateMinimapViewport();
  if(typeof repositionNodeBar==='function' && typeof sel!=='undefined' && sel) repositionNodeBar();
}
// Keeps whatever map point is currently centred still centred after the stage's
// effective CSS-pixel size changes for any reason — a window resize, a UI-scale
// change, a sidebar toggle, ... Relies on _prevStage already holding the size from
// just before the change (kept fresh by _markStage(), called after every camera
// move) to know what point to preserve; updates it to the new size afterward so
// the next call has a correct baseline too.
function _recenterForStageChange(){
  if(!map) return;
  const {w:SW,h:SH}=_stageSize();
  if(!(SW>1&&SH>1)) return;
  if(_prevStage && _prevStage.w>1 && _prevStage.h>1){
    const cx=(_prevStage.w/2 - view.x)/view.k, cy=(_prevStage.h/2 - view.y)/view.k;
    view.x = SW/2 - cx*view.k;
    view.y = SH/2 - cy*view.k;
    applyView(); saveMapView();
  }
  _markStage();   // refreshes _prevStage AND _prevStageRect together — setting _prevStage alone here would leave _prevStageRect stale after every resize/UI-scale-change that goes through this path
}
// Apply a saved camera viewport-INDEPENDENTLY: recompute the pan from the CURRENT
// stage size so the stored centre point + zoom reproduce at any viewsize. Legacy
// {x,y} entries are honoured once, then migrated to {cx,cy} on the next save.
// While the stage width animates (sidebar collapse/expand), keep the given
// map-space point centred each frame so the map holds its position on screen.
// Smoothly keep the centred map-point in place while the sidebar animates, WITHOUT
// any per-frame JS or forced layout (which is what makes the old loop stutter on
// low-end / battery). We know the stage's final width, so we set the viewport's
// final transform and let the compositor animate it in lockstep with the sidebar
// (identical easing + duration). Because view.x is linear in stage width, the
// centred point stays put for the whole animation — GPU-only, no jank.
function _reframeSmooth(cx, cy, W1, H1){
  const tx = W1/2 - cx*view.k, ty = H1/2 - cy*view.k;
  view.x = tx; view.y = ty;
  const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if(reduce){ applyView(); _markStage(); saveMapView(); updateMinimap(); return; }
  let done=false;
  const settle=()=>{ if(done) return; done=true; viewport.style.transition=''; _markStage(); saveMapView(); updateMinimap(); };
  viewport.style.transition = 'transform .22s cubic-bezier(.4,0,.2,1)';
  applyView();                                  // sets transform to target -> compositor animates it
  viewport.addEventListener('transitionend', function te(e){
    if(e.target===viewport && e.propertyName==='transform'){ viewport.removeEventListener('transitionend', te); settle(); }
  });
  setTimeout(settle, 280);                       // safety net if transitionend doesn't fire
}
function applyMapView(saved){
  view.k = isFinite(saved.k) ? saved.k : 1;
  if(isFinite(saved.cx) && isFinite(saved.cy)){
    const {w:SW,h:SH}=_stageSize();
    view.x = SW/2 - saved.cx*view.k;
    view.y = SH/2 - saved.cy*view.k;
  } else {
    view.x = isFinite(saved.x) ? saved.x : 0;
    view.y = isFinite(saved.y) ? saved.y : 0;
  }
  applyView(); _markStage();
}
let sel=null;                 // selected node id
let history=[],hpos=-1;       // undo stack


const viewport=$('#viewport'), edges=$('#edges'), stage=$('#stage'), zoomVal=$('#zoomVal');
if(viewport){
  viewport.addEventListener('pointerover', e=>{
    if(typeof _liveEditing!=='undefined' && _liveEditing) return;
    if(document.body && document.body.classList.contains('rms-node-edit')) return;
    const node=e.target && e.target.closest && e.target.closest('.node');
    if(node) ensureNodeChrome(node);
  });
}

/* ============================================================
   RENDER
   ============================================================ */
function applyViewTransform(){
  viewport.style.transform=`translate(${view.x}px,${view.y}px) scale(${view.k})`;
}
function applyViewChrome(){
  if(zoomVal) zoomVal.textContent=Math.round(view.k*100)+'%';
  // Keep the (in-viewport) node toolbar at a constant on-screen size AND a
  // constant ~12px gap below the node as zoom changes (so it never overlaps).
  const bar=$('#nodebar');
  if(bar){
    if(sel && map && map.nodes[sel]){
      positionAndClampNodeBar(bar, map.nodes[sel]);
    }else{
      bar.style.transform=`translateX(-50%) scale(${1/view.k})`;
    }
  }
  // The WK editor lives on #stage, outside #viewport's transform. Pan/zoom
  // would otherwise leave a selected-looking clone glued to the old screen
  // point — the "floating New topic" ghost.
  if(typeof syncEditFloat==='function') syncEditFloat();
  updateMinimapViewport();
}
function applyView(){
  applyViewTransform();
  applyViewChrome();
  cullOffscreenNodes();
}

// Camera pan/zoom used to call applyView() on every wheel/mousemove. Trackpads
// fire far above 60Hz, and chrome (nodebar GBR, minimap SVG, zoom label) forced
// layout on the full node tree. Coalesce to one compositor transform per frame
// and defer chrome until the gesture settles.
let _viewRAF=0, _camLive=false, _camChromeTimer=0, _wheelIdle=0, _stageRectCam=null;
function beginCamGesture(){
  if(_camLive) return;
  _camLive=true;
  if(viewport && viewport.classList) viewport.classList.add('cam-live');
}
function endCamGesture(){
  if(_wheelIdle){ clearTimeout(_wheelIdle); _wheelIdle=0; }
  if(_camChromeTimer){ clearTimeout(_camChromeTimer); _camChromeTimer=0; }
  _camLive=false;
  _stageRectCam=null;
  if(viewport && viewport.classList) viewport.classList.remove('cam-live');
  if(_viewRAF){ cancelAnimationFrame(_viewRAF); _viewRAF=0; }
  applyView();
  saveMapView();
}
function scheduleCamChrome(){
  if(_camChromeTimer) return;
  _camChromeTimer=setTimeout(()=>{
    _camChromeTimer=0;
    if(!_camLive) return;
    applyViewChrome();
  }, 80);
}
function scheduleView(){
  if(_viewRAF) return;
  _viewRAF=requestAnimationFrame(()=>{
    _viewRAF=0;
    applyViewTransform();
    if(_camLive){ scheduleCamChrome(); cullOffscreenNodes(); }
    else { applyViewChrome(); cullOffscreenNodes(); }
  });
}
function _stagePointCam(cx,cy){
  const r=_stageRectCam || (_stageRectCam=stage.getBoundingClientRect());
  return {x:cx-r.left, y:cy-r.top};
}
function mapViewRect(v, stageW, stageH, pad){
  const k=v.k||1;
  const p=pad||0;
  return {
    x0:(-v.x)/k - p,
    y0:(-v.y)/k - p,
    x1:(stageW-v.x)/k + p,
    y1:(stageH-v.y)/k + p
  };
}
function nodeOutsideRect(n, r){
  if(!n||!r) return true;
  const w=n.w||120, h=n.h||40;
  return n.x+w<r.x0 || n.x>r.x1 || n.y+h<r.y0 || n.y>r.y1;
}
// [{el,id}] for every rendered .node, rebuilt at the end of render() so the
// per-frame cull does not query the DOM. null = rebuild lazily from the DOM.
let _cullPairs=null;
function cullOffscreenNodes(){
  if(!viewport || !map || !map.nodes) return;
  if(!_cullPairs) _cullPairs=Array.from(viewport.querySelectorAll('.node'), el=>({el, id:el.dataset.id}));
  const pairs=_cullPairs;
  const nEls=pairs.length;
  if(nEls<80){
    for(let i=0;i<nEls;i++) pairs[i].el.classList.remove('offscreen');
    return;
  }
  const {w:SW,h:SH}=(_prevStage && _prevStage.w>1 && _prevStage.h>1) ? _prevStage : _stageSize();
  const pad=Math.max(120, 280/(view.k||1));
  const r=mapViewRect(view, SW, SH, pad);
  for(let i=0;i<nEls;i++){
    const {el, id}=pairs[i];
    if(!el.isConnected){ _cullPairs=null; continue; }   // DOM changed outside render()
    if(el.classList.contains('editing') || id===sel){
      if(el.classList.contains('offscreen')) el.classList.remove('offscreen');
      continue;
    }
    const n=map.nodes[id];
    const off=n ? nodeOutsideRect(n, r) : false;
    if(el.classList.contains('offscreen')!==off) el.classList.toggle('offscreen', off);
  }
}
function mkNodeHandle(cls,label,title,onClick){
  const h=document.createElement('span');
  h.className='handle '+cls; h.textContent=label; h.title=title;
  h.addEventListener('mousedown',ev=>ev.stopPropagation());
  h.addEventListener('click',ev=>{ ev.stopPropagation(); onClick(); });
  return h;
}
function ensureNodeChrome(el){
  if(!el || !map || el.dataset.chrome==='1') return;
  const id=el.dataset.id;
  const n=map.nodes[id];
  if(!n) return;
  el.dataset.chrome='1';
  if(!n.hr && (n.created || n.updated) && !el.querySelector('.node-watermark')){
    const wm=document.createElement('span');
    wm.className='node-watermark'; wm.setAttribute('aria-hidden','true');
    wm.textContent=formatNodeTimestamp(n.updated||n.created);
    el.appendChild(wm);
  }
  if(!el.querySelector('.h-child')){
    el.appendChild(mkNodeHandle('h-child','+',chordTitle('handleChild','addChild','Add child'),()=>addNode(id,false)));
  }
  if(id!==map.rootId && !el.querySelector('.h-sibling')){
    el.appendChild(mkNodeHandle('h-sibling','+',chordTitle('handleSibling','addSibling','Add sibling'),()=>addNode(id,true)));
  }
  if(!el.querySelector('.resize-grip')){
    const grip=document.createElement('span');
    grip.className='resize-grip'; grip.title=rmsTr('dragResize','Drag to resize');
    grip.addEventListener('mousedown',ev=>{ ev.stopPropagation(); ev.preventDefault(); startResize(id,ev); });
    el.appendChild(grip);
  }
}
function clearNodes(){
  document.querySelectorAll('.node').forEach(n=>n.remove());
  if(typeof discardEditOverlay==='function') discardEditOverlay();
}

// Pending coalesced relayout after node images finish loading (see render()).
let _imgRelayoutT=null;
function render(){
  if(typeof applyLevelColors==='function') applyLevelColors();
  // Rebuild destroys .node elements. If a WK .edit-float is still mounted,
  // drop it here — never write it back. Callers that care about the draft
  // (pushHistory, cycleTask, setMarker) flush first.
  if(typeof discardEditOverlay==='function') discardEditOverlay();
  clearNodes(); edges.innerHTML='';
  _cullPairs=null;
  clearFormulaCache();
  if(!map){
    $('#empty').style.display='grid';
    $('#nodebar')?.remove();              // no node toolbar on a blank canvas
    if(activePicker){ activePicker.remove(); activePicker=null; }
    $('#mapTitle').value='';              // reset title field
    viewport.removeAttribute('data-style');
    viewport.removeAttribute('data-layout');   // reset style/background
    sel=null;
    updateBreadcrumb();                   // hides (no map)
    updateMinimap();                      // clears + hides the overview box
    return;
  }
  $('#empty').style.display='none';
  viewport.dataset.style = map.style || 'modern';
  viewport.dataset.layout = map.layout || 'balanced';
  const _prevCI=_ci; _ci=buildChildIndex();   // O(1) childrenOf for this whole pass
  try{
  const roll=computeRollups();                // O(n) descendant + task totals
  const hidden=hiddenSet();
  const toMeasure=[];
  // nodes
  for(const id in map.nodes){
    if(hidden.has(id)) continue;
    const n=map.nodes[id];
    const hasKids=childrenOf(id).length>0;
    const el=document.createElement('div');
    el.className='node'+(id===map.rootId?' root':'')+(id===sel?' sel':'')+(hasKids&&n.collapsed?' collapsed':'')+(n.side==='left'?' left':'');
    el.dataset.id=id;
    el.style.left=n.x+'px'; el.style.top=n.y+'px';
    if(id===map.rootId){
      el.style.background = colorFor(map.color||'#e0613a');
      el.style.color = '#fff';
    } else if(n.color && n.color!=='#fff' && n.color!=='#ffffff'){
      // User-picked card colour — always pair with dark text for legibility
      el.style.background = n.color;
      el.style.color = '#23201b';
    } else {
      // No explicit colour — let CSS theme variables handle it
      el.style.background = '';
      el.style.color = '';
    }
    // Manual width/height (when the user has resized the node). Height is a
    // floor (min-height), not a hard cap — .node has no overflow:hidden, so a
    // fixed height smaller than what the current font-size actually needs
    // (e.g. Back to School's 1.2em) would let text visually spill past the
    // card's own border rather than the box growing to fit it.
    if(n.width){ el.style.width=n.width+'px'; el.style.maxWidth='none'; }
    if(n.height){
      if(isTableNode(n)){ el.style.height=n.height+'px'; el.style.maxHeight='none'; }
      else el.style.minHeight=n.height+'px';
    }
    // Reference/citation nodes get a distinct class
    if(n.ref) el.classList.add('ref-node');
    if(n.url) el.classList.add('href-node');
    // Attached image renders as a thumbnail above the text (node goes column)
    if(n.image || n.imagePending){
      el.classList.add('has-image');
      const pend=document.createElement('span');
      pend.className='image-pending-label';
      pend.textContent=imagePastingLabel();
      if(n.image){
        const img=document.createElement('img');
        const src=nodeImageSrc(n);
        img.className='node-image'; img.alt=n.imageAlt||'attachment';
        let waiting=true;
        const reveal=()=>{
          if(!waiting) return;
          waiting=false;
          pend.remove();
          el.classList.remove('image-pending');
          img.style.display='';
          // Relayout only when the revealed image actually changed the card's
          // size, and coalesce a burst of image loads into one non-persisting
          // pass: each autoLayout re-renders, and saving here would bump
          // map.updated just because pictures finished loading.
          if(typeof autoLayout!=='function' || !el.isConnected) return;
          const sz=(view.k||1)*_uiZ();
          const r=el.getBoundingClientRect();
          if(Math.abs(r.width/sz-(n.w||0))<=1 && Math.abs(r.height/sz-(n.h||0))<=1) return;
          clearTimeout(_imgRelayoutT);
          _imgRelayoutT=setTimeout(()=>{ _imgRelayoutT=null; autoLayout(false,{persist:false}); },50);
        };
        img.addEventListener('load', reveal);
        img.addEventListener('dblclick',ev=>{
          ev.stopPropagation();
          ev.preventDefault();
          openImageLightbox(src);
        });
        img.addEventListener('error',()=>{
          waiting=false;
          img.remove(); pend.remove(); el.classList.remove('has-image','image-pending'); el.classList.add('img-missing');
          const cap=document.createElement('span'); cap.className='img-alt';
          cap.textContent = n.imageAlt || 'image not found';
          el.insertBefore(cap, el.firstChild);
        });
        img.src=src;
        if(img.complete && img.naturalWidth){
          waiting=false;
          el.appendChild(img);
        } else {
          el.classList.add('image-pending');
          img.style.display='none';
          el.appendChild(pend);
          el.appendChild(img);
        }
      } else {
        el.classList.add('image-pending');
        el.appendChild(pend);
      }
    }
    // Marker badge — click to change, same interaction shape as the task
    // checkbox below it.
    if(n.marker){
      const mk=document.createElement('span');
      mk.className='node-marker';
      mk.textContent=n.marker;
      const mkLabel=markerLabel(MARKERS.find(m=>m.c===n.marker));
      mk.title=(mkLabel?mkLabel+' — ':'')+rmsTr('markerClick','click to change');
      mk.addEventListener('mousedown',ev=>ev.stopPropagation());
      mk.addEventListener('click',ev=>{ ev.stopPropagation(); showMarkerPicker(mk, id); });
      el.appendChild(mk);
    }
    // Task checkbox — click to advance todo → doing → done
    if(n.task){
      el.classList.add('task-node','task-'+n.task);
      const cb=document.createElement('span');
      cb.className='task-check task-'+n.task;
      cb.title=rmsTr('taskClick','Todo state (click to change)');
      cb.textContent = n.task==='done' ? '✓' : (n.task==='doing' ? '◐' : '');
      cb.addEventListener('mousedown',ev=>ev.stopPropagation());
      cb.addEventListener('click',ev=>{ ev.stopPropagation(); cycleTask(id); });
      el.appendChild(cb);
    }
    // Text lives in its own span so contentEditable doesn't tangle with the handles
    const t=document.createElement('span'); t.className='node-text';
    if(n.hr){ el.classList.add('hr-node'); t.classList.add('node-hr'); t.textContent=''; }
    else if(n.html){
      el.classList.add('block-node');
      if(n.frontmatter) el.classList.add('frontmatter-node');
      if(isTableNode(n)) el.classList.add('table-node');
      t.classList.add('node-block');
      t.innerHTML = sanitizeNotes(n.html);
    }
    else {
      const plainCheck = nodeTextPlain(n.text||'').trim();
      if(plainCheck.startsWith('=')){
        // Formula node: show the computed result (Excel-style), not the literal "=...".
        // n.text itself is never touched here, so editing/markdown export still see the
        // raw formula.
        el.classList.add('formula-node');
        const val = computeNodeValue(id);
        if(val && typeof val==='object' && val.error){
          el.classList.add('formula-error');
          t.textContent = '#ERROR';
          t.title = plainCheck+' \u2014 '+val.error;
        } else {
          t.textContent = formatFormulaResult(val);
          t.title = plainCheck;
        }
      } else {
        renderNodeText(t, n.text||'', n.listType);
        if(t.classList.contains('has-md-table')) el.classList.add('has-md-table');
      }
    }
    // Per-node styling
    if(n.fontSize) t.style.fontSize=n.fontSize+'px';
    if(n.bold) t.style.fontWeight='700';
    if(n.italic) t.style.fontStyle='italic';
    const decos=[]; if(n.underline) decos.push('underline'); if(n.strike) decos.push('line-through');
    if(decos.length) t.style.textDecoration=decos.join(' ');
    if(n.textColor) t.style.color=n.textColor;
    // Highlights are light pastels: on a dark theme the default ink would be
    // light-on-light, so highlighted text falls back to dark ink.
    if(n.highlight){ t.style.color=n.textColor || '#23201b'; t.style.background=n.highlight; t.style.padding='0 4px'; t.style.borderRadius='3px'; t.style.boxDecorationBreak='clone'; t.style.webkitBoxDecorationBreak='clone'; }
    // Text alignment
    if(n.align && n.align!=='center'){
      t.style.textAlign=n.align;
      el.style.justifyContent = (n.align==='left') ? 'flex-start' : (n.align==='right') ? 'flex-end' : 'center';
    }
    if(n.listType) t.classList.add('node-text-list','list-'+n.listType);
    el.appendChild(t);

    // Collapse stays in the tree: it is visible without hover. Child / sibling
    // plus, resize grip, and watermark wait for hover or selection.
    if(hasKids){
      el.appendChild(mkNodeHandle(
        'h-collapse'+(n.collapsed?' collapsed':''),
        n.collapsed?'+':'−',
        n.collapsed?rmsTf('nodeExpandHidden','Expand (%s hidden)', roll.desc[id]):rmsTr('ctxCollapse','Collapse'),
        ()=>{ n.collapsed=!n.collapsed; opLog(n.collapsed?'collapse':'expand', {id}); pushHistory(); autoLayout(); }
      ));
    }
    if(id===sel) ensureNodeChrome(el);
    // Notes indicator — visible only if a non-empty note exists
    const noteText = (n.notes||'').replace(/<[^>]*>/g,'').trim();
    if(noteText){
      const nm=document.createElement('span');
      nm.className='notes-mark';
      nm.textContent='📝';
      nm.addEventListener('mousedown',ev=>ev.stopPropagation());
      const openNotePreview=ev=>{ ev.stopPropagation(); showNotesEditor(id, { sticky:false }); };
      const closeNotePreview=ev=>{ ev.stopPropagation(); scheduleCloseNotesPreview(); };
      nm.addEventListener('mouseenter', openNotePreview);
      nm.addEventListener('mouseleave', closeNotePreview);
      nm.addEventListener('pointerenter', openNotePreview);
      nm.addEventListener('pointerleave', closeNotePreview);
      nm.addEventListener('click',ev=>{ ev.stopPropagation(); showNotesEditor(id, { sticky:true }); });
      el.appendChild(nm);
    }
    // Citation/reference indicator
    if(n.ref){
      const cb=document.createElement('span');
      cb.className='ref-mark'; cb.textContent='📖';
      cb.title=rmsTr('refClick','Reference — click to edit citation');
      cb.addEventListener('mousedown',ev=>ev.stopPropagation());
      cb.addEventListener('click',ev=>{ ev.stopPropagation(); showCitationForm(id); });
      el.appendChild(cb);
    }
    // Hyperlink — a bar on the card, glanceable without underlining the
    // text. Opening lives on the right-click menu, not a badge.
    if(n.url){
      const bar=document.createElement('span');
      bar.className='href-bar';
      bar.setAttribute('aria-hidden','true');
      el.appendChild(bar);
    }
    // Task progress roll-up — shown on nodes that have task-bearing descendants
    const prog = {done:roll.tdone[id], total:roll.ttot[id]};
    if(prog.total > 0 && !n.task){
      const pb=document.createElement('span');
      pb.className='task-progress'+(prog.done===prog.total?' complete':'');
      pb.textContent=`✓ ${prog.done}/${prog.total}`;
      pb.title=rmsTr('tasksDone','%s of %s tasks done in this branch').replace('%s', prog.done).replace('%s', prog.total);
      pb.addEventListener('mousedown',ev=>ev.stopPropagation());
      pb.addEventListener('click',ev=>ev.stopPropagation());
      el.appendChild(pb);
    }
    viewport.appendChild(el);
    toMeasure.push({el, n});
  }
  // Measure ALL nodes in one pass AFTER appending — reading getBoundingClientRect
  // interleaved with appends forces a layout reflow per node (O(n) thrash). One
  // batched read loop triggers a single reflow. getBoundingClientRect returns
  // VISUAL px, scaled by BOTH the canvas zoom (view.k) and the UI display zoom,
  // so divide by both to recover true layout dimensions.
  const sz=view.k*_uiZ();
  for(const {el, n} of toMeasure){
    const r=el.getBoundingClientRect();
    n.w=r.width/sz; n.h=r.height/sz;
  }
  // Live sizes can exceed the ones layout used (wrap, font, zoom). If two
  // cards now collide, push them apart here — before edges are drawn — so a
  // stale n.h cannot ship an overlapping frame. Skip while a node is being
  // dragged; the drop path re-tidies.
  // Only tree layouts stack siblings along one axis. Grid, timeline, matrix
  // and fishbone deliberately put siblings side by side on the same row, so a
  // one-axis push there would staircase them on every render.
  const _sibAxis=siblingOverlapAxis(resolveLayout(map.layout||'balanced', map.layoutParams));
  if(_sibAxis && !(typeof document!=='undefined' && document.body && document.body.classList.contains('node-dragging'))
     && resolveSiblingOverlaps(map.nodes, {
       gap:16,
       vertical:_sibAxis==='vertical',
       hidden,
       kidsOf:childrenOf
     })){
    for(const {el, n} of toMeasure){
      el.style.left=n.x+'px'; el.style.top=n.y+'px';
    }
  }
  drawEdges(hidden);
  positionNodeBar();
  scheduleTokenTotal();
  updateMinimap();
  updateBreadcrumb();
  // Re-apply multi-selection outlines (render rebuilds node elements)
  if(typeof multiSel !== 'undefined' && multiSel.size){
    multiSel.forEach(id=>document.querySelector(`.node[data-id="${id}"]`)?.classList.add('multi-sel'));
  }
  // Same for the presentation spotlight and the open search's hit classes.
  if(typeof _pres!=='undefined' && _pres){
    document.querySelector(`.node[data-id="${_pres.order[_pres.idx]}"]`)?.classList.add('pres-current');
  }
  if(typeof paintSearchHits==='function' && $('#searchWrap')?.classList.contains('open')) paintSearchHits();
  _cullPairs=toMeasure.map(({el})=>({el, id:el.dataset.id}));
  cullOffscreenNodes();
  } finally { _ci=_prevCI; }
}

// Sum estimated tokens across every node (text + notes) and show in the topbar.
let _tokTimer=null;
// The token total scans every node's text, which is wasteful to do synchronously
// inside render() (it dominated render time even when only a few nodes were
// visible). Schedule it off the hot path and coalesce bursts of renders into one
// recompute — the badge is a non-critical stat, so a ~300ms delay is invisible.
function scheduleTokenTotal(){
  if(_tokTimer) return;
  _tokTimer=setTimeout(()=>{ _tokTimer=null; try{ updateTokenTotal(); }catch(e){} }, 300);
}
function updateTokenTotal(){
  const el = $('#tokenTotal');
  if(!el || !map || !map.nodes){ if(el) el.textContent=''; return; }
  let total = 0;
  Object.values(map.nodes).forEach(n => { total += estimateTokens(n.text, n.notes); });
  el.textContent = total > 0 ? `~${total.toLocaleString()} tokens` : '';
  el.style.display = total > 0 ? '' : 'none';
}

// Render text inside a node, turning http(s)://… URLs into clickable links.
const URL_RE = /(https?:\/\/[^\s<>"'`)]+)/g;
// A short, readable label for a URL (host + trimmed path) used as the link text.
function prettyUrl(u){
  try{
    const x=new URL(u);
    let label=x.hostname.replace(/^www\./,'');
    let path=(x.pathname && x.pathname!=='/') ? x.pathname.replace(/\/$/,'') : '';
    label+=path;
    if(label.length>44) label=label.slice(0,42)+'\u2026';
    return label;
  }catch(_){ return u; }
}
function appendTextWithLinks(container, text){
  let last=0, m;
  URL_RE.lastIndex=0;
  while((m=URL_RE.exec(text))!==null){
    if(m.index>last) container.appendChild(document.createTextNode(text.slice(last,m.index)));
    const a=document.createElement('a');
    a.href=m[0]; a.target='_blank'; a.rel='noopener noreferrer';
    a.className='node-link';
    // Favicon (best-effort; removed if it fails to load — e.g. offline).
    let _host=''; try{ _host=new URL(m[0]).hostname.replace(/^www\./,''); }catch(_){}
    if(_host){
      const fav=document.createElement('img');
      fav.className='node-link-fav'; fav.alt=''; fav.loading='lazy'; fav.decoding='async';
      fav.src='https://icons.duckduckgo.com/ip3/'+_host+'.ico';
      fav.addEventListener('error',()=>{ try{ fav.remove(); }catch(_){} });
      a.appendChild(fav);
    }
    // Readable label instead of the raw (often long) URL. Display-only: editing
    // starts from the stored raw text, so this never changes what gets saved.
    const _lab=document.createElement('span'); _lab.className='node-link-label';
    _lab.textContent=prettyUrl(m[0]); a.appendChild(_lab);
    a.addEventListener('mousedown',e=>e.stopPropagation());
    a.addEventListener('click',e=>{
      e.stopPropagation();
      if(container.isContentEditable || container.closest('.node.editing')) e.preventDefault();
    });
    container.appendChild(a);
    last=m.index+m[0].length;
  }
  if(last<text.length) container.appendChild(document.createTextNode(text.slice(last)));
}
// Wrap the current selection in a <ul>/<ol> where each <br>-separated line
// becomes its own <li>. Falls back to native execCommand when no selection.
function applyListToSelection(kind){
  const wsel = window.getSelection();
  if(!wsel || wsel.rangeCount === 0){
    return execCmd(kind==='ul' ? 'insertUnorderedList' : 'insertOrderedList');
  }
  const range = wsel.getRangeAt(0);
  if(range.collapsed){
    return execCmd(kind==='ul' ? 'insertUnorderedList' : 'insertOrderedList');
  }
  // Extract the selected contents into a fragment, then walk it to build lines.
  const frag = range.extractContents();
  const lines = fragmentToLines(frag);
  // Build a <ul>/<ol> with one <li> per line
  const listTag = (kind==='ul') ? 'ul' : 'ol';
  const listEl = document.createElement(listTag);
  lines.forEach(lineHTML => {
    const li = document.createElement('li');
    // Empty lines get a <br> so the <li> has visible height
    li.innerHTML = lineHTML.trim() || '<br>';
    listEl.appendChild(li);
  });
  // Insert the list back where the selection was
  range.insertNode(listEl);
  // Place the cursor at the end of the last list item
  const lastLi = listEl.lastElementChild;
  if(lastLi){
    const after = document.createRange();
    after.selectNodeContents(lastLi);
    after.collapse(false);
    wsel.removeAllRanges();
    wsel.addRange(after);
  }
  return true;
}
// Walk a DocumentFragment, splitting into lines on <br>/<div>/<p>/<li> boundaries,
// preserving any inline formatting (b/i/u/s/a/span) inside each line.
function fragmentToLines(frag){
  const lines = [];
  let current = '';
  const flush = () => { lines.push(current); current = ''; };
  const serialize = (el) => {
    const tmp = document.createElement('div');
    tmp.appendChild(el.cloneNode(true));
    return tmp.innerHTML;
  };
  const walk = (node) => {
    node.childNodes.forEach(child => {
      if(child.nodeType === 3){
        // Text node — split on any literal \n
        const parts = (child.nodeValue || '').split('\n');
        parts.forEach((part, i) => {
          if(i>0) flush();
          current += escapeHtml(part);
        });
      } else if(child.nodeType === 1){
        const tag = child.tagName.toLowerCase();
        if(tag === 'br'){ flush(); }
        else if(tag === 'div' || tag === 'p' || tag === 'li'){
          if(current) flush();
          walk(child);
          if(current) flush();
        } else {
          // Inline element — keep its formatting intact within the line
          current += serialize(child);
        }
      }
    });
  };
  walk(frag);
  if(current) flush();
  return lines.filter(l => l !== undefined);
}
const INLINE_HTML_RE = /<(b|i|u|s|strong|em|br|a|span|font|div|ul|ol|li|p|sub|sup|code|kbd|mark|ins|del|small|abbr)\b/i;
const HTML_ENTITY_RE = /&(#\d+|#x[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/;  // &rarr; &#8594; &amp; ...
// HTML entities (named like &nbsp;/&amp;, decimal &#160;, or hex &#xA0;). Text that
// contains these but no tags still needs to go through the HTML path so the entity
// is decoded for display instead of showing the literal "&nbsp;".
const ENTITY_RE = /&(#\d+|#x[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]+);/;
const hasInlineMarkup = t => INLINE_HTML_RE.test(t||'') || ENTITY_RE.test(t||'');
// Sanitize HTML: keep only a small inline-formatting whitelist; strip everything else
const SAFE_TAGS = new Set(['b','i','u','s','strong','em','br','a','span','font','div','ul','ol','li','p','sub','sup','code','kbd','mark','ins','del','small','abbr']);
// Colors from the map model end up inside style="" / fill="" attributes and canvas
// fillStyle, so only well-formed color literals pass. Returns '' for anything else.
const SAFE_COLOR_NAMES = new Set(['transparent','currentcolor','black','white','red','green','blue','yellow',
  'orange','purple','pink','gray','grey','brown','cyan','magenta','navy','teal','olive','maroon','lime',
  'aqua','fuchsia','silver','gold','indigo','violet','coral','salmon','tomato','crimson','khaki','beige']);
function safeColor(c){
  if(typeof c!=='string') return '';
  const v=c.trim();
  if(/^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(v)) return v;
  const num='\\s*[+-]?(?:\\d+\\.?\\d*|\\.\\d+)(?:%|deg)?\\s*';
  const fn=new RegExp('^(?:rgba?|hsla?)\\(('+num+')(?:,('+num+')){2,3}\\)$','i');
  const fnSpace=new RegExp('^(?:rgba?|hsla?)\\((?:'+num+'){3}(?:/'+num+')?\\)$','i');
  if(fn.test(v) || fnSpace.test(v)) return v;
  if(SAFE_COLOR_NAMES.has(v.toLowerCase())) return v;
  return '';
}
// Only these link schemes may become clickable (<a href>) or be handed to the
// native opener: javascript:/file:/custom app schemes render as plain text.
function isSafeLinkUrl(url, allowMailto){
  const u=String(url==null?'':url).trim();
  if(/^https?:\/\/[^\s]/i.test(u)) return true;
  return allowMailto!==false && /^mailto:[^\s]/i.test(u);
}
// opts (all optional): { img:true } keeps <img> src/alt when the src is http(s),
// data:image/ or a same-origin /api/ path; { mailto:true } also accepts mailto: links;
// { classes:RegExp } keeps class names matching it; { style:RegExp } narrows the
// allowed inline-style properties (default: the formatting set below).
function sanitizeInlineHTML(html, extraTags, opts){
  // Parse INERTLY via <template>: its contents live in a document with no
  // browsing context, so smuggled resource-loaders like <img src=x onerror=…>
  // never fetch/fire during parsing. (A detached <div>.innerHTML still would.)
  const tpl = document.createElement('template');
  tpl.innerHTML = html || '';
  const o = opts || {};
  const allow = extraTags ? new Set([...SAFE_TAGS, ...extraTags]) : SAFE_TAGS;
  const styleRe = o.style || /^(color|background-color|font-weight|font-style|text-decoration|font-size|text-align)$/i;
  const hrefOk = v => isSafeLinkUrl(v, !!o.mailto);
  const srcOk = v => /^(https?:\/\/|data:image\/|\/api\/)/i.test(String(v||'').trim());
  const walk = (node) => {
    [...node.childNodes].forEach(child => {
      if(child.nodeType === 1){
        const tag = child.tagName.toLowerCase();
        if(DROP_TAGS.has(tag)){ node.removeChild(child); return; }  // remove element AND its contents
        if(!allow.has(tag)){
          // Clean the subtree FIRST (so nothing dangerous survives), then unwrap —
          // keep only its (now-sanitized) text/inline children inline.
          walk(child);
          while(child.firstChild) node.insertBefore(child.firstChild, child);
          node.removeChild(child);
          return;
        }
        [...child.attributes].forEach(attr => {
          const n = attr.name.toLowerCase();
          if(n.startsWith('on')) child.removeAttribute(attr.name);
          else if(n==='href'){
            if(tag!=='a' || !hrefOk(attr.value)) child.removeAttribute(attr.name);
          }
          else if(tag==='img' && o.img && (n==='src' || n==='alt')){
            if(n==='src' && !srcOk(attr.value)) child.removeAttribute(attr.name);
          }
          else if(n==='class' && o.classes){
            const keep = attr.value.split(/\s+/).filter(c => c && o.classes.test(c)).join(' ');
            if(keep) child.setAttribute('class', keep); else child.removeAttribute('class');
          }
          else if(n==='style'){
            // Allow only color / background-color / font-weight / font-style / text-decoration / font-size / text-align
            // (or the narrower opts.style set); url()/expression() values are never kept.
            const safe = attr.value
              .split(';').map(s=>s.trim()).filter(Boolean)
              .filter(s=>{ const i=s.indexOf(':'); return i>0 && styleRe.test(s.slice(0,i).trim()) && !/url\s*\(|expression\s*\(|[\\<>]/i.test(s.slice(i+1)); })
              .join('; ');
            if(safe) child.setAttribute('style', safe); else child.removeAttribute('style');
          }
          else if(!['target','rel','color','face','size','title','colspan','rowspan'].includes(n)) child.removeAttribute(attr.name);   // note: class removed — pasted HTML must not claim app CSS classes
        });
        if(tag==='img' && !(o.img && child.getAttribute('src'))){ node.removeChild(child); return; }
        if(tag==='a'){ child.setAttribute('target','_blank'); child.setAttribute('rel','noopener noreferrer'); }
        walk(child);
      } else if(child.nodeType === 8){
        node.removeChild(child);  // comments
      }
    });
  };
  walk(tpl.content);
  // Serialize the now-sanitized fragment (no re-parse of untrusted input).
  const out = document.createElement('div');
  out.appendChild(tpl.content);
  return out.innerHTML;
}
// Notes allow a few block tags on top of the inline set (headings, quotes).
const NOTES_TAGS = ['h1','h2','h3','blockquote','pre','code','table','thead','tbody','tr','th','td'];
// Elements removed WITH their contents (never unwrapped) — unwrapping these can
// promote a hidden <script> to the top level where a snapshotted loop misses it.
const DROP_TAGS = new Set(['script','style','iframe','object','embed','noscript','svg','math','template','link','meta','base','frame','frameset','title','xmp']);
function sanitizeNotes(html){ return sanitizeInlineHTML(html, NOTES_TAGS); }

// ---- Map-level sanitizing: every map that enters from outside (import, store,
// share link, live peer) passes through here before anything renders it.
const SAFE_NODE_ID_RE = /^[\w-]+$/;
// Block nodes (n.html) legitimately hold tables, code blocks, frontmatter tables and
// raw Markdown HTML blocks; keep those tags so Markdown export still round-trips.
const NODE_HTML_TAGS = ['h1','h2','h3','h4','h5','h6','blockquote','pre','code','hr','img','table','thead','tbody','tr','th','td','details','summary','figure','figcaption'];
// Only rewrite stored HTML when sanitizing actually removed something: harmless
// content keeps its exact bytes (entities, spacing) so nothing drifts on load.
function _sanitizeStoredHtml(html, clean){
  if(typeof html!=='string' || !html) return html;
  const tpl=document.createElement('template'); tpl.innerHTML=html;
  const holder=document.createElement('div'); holder.appendChild(tpl.content);
  return clean===holder.innerHTML ? html : clean;
}
function sanitizeMapNode(n){
  if(!n || typeof n!=='object') return null;
  for(const f of ['color','textColor','highlight']){
    if(n[f]==null || n[f]==='') continue;
    const c=safeColor(n[f]);
    if(c) n[f]=c; else delete n[f];
  }
  // n.text is plain text unless hasInlineMarkup() says HTML (see renderNodeText);
  // plain text is always rendered as text, so only the HTML form needs cleaning.
  if(typeof n.text==='string' && /</.test(n.text) && hasInlineMarkup(n.text)) n.text=_sanitizeStoredHtml(n.text, sanitizeInlineHTML(n.text));
  else if(n.text!=null && typeof n.text!=='string') n.text=String(n.text);
  if(typeof n.notes==='string' && /</.test(n.notes)) n.notes=_sanitizeStoredHtml(n.notes, sanitizeNotes(n.notes));
  else if(n.notes!=null && typeof n.notes!=='string') delete n.notes;
  if(typeof n.html==='string' && n.html) n.html=_sanitizeStoredHtml(n.html, sanitizeInlineHTML(n.html, NODE_HTML_TAGS, { img:true, mailto:true, classes:/^[\w-]+$/ }));
  else if(n.html!=null && typeof n.html!=='string') delete n.html;
  return n;
}
function sanitizeMap(m){
  if(!m || typeof m!=='object') return m;
  if(m.color!=null) m.color=safeColor(m.color)||'#e0613a';
  const src=(m.nodes && typeof m.nodes==='object') ? m.nodes : {};
  // Node ids end up in data-id attributes and CSS selectors, so they must be plain
  // word characters; anything else gets a fresh id with its references updated.
  const keys=Object.keys(src);
  const used=new Set(keys.filter(k=>SAFE_NODE_ID_RE.test(k)));
  const remap={};
  keys.forEach(k=>{
    if(SAFE_NODE_ID_RE.test(k)) return;
    let id; do{ id=uid(); }while(used.has(id));
    used.add(id); remap[k]=id;
  });
  const fix=ref=>{
    if(ref==null) return ref;
    const r=String(ref);
    if(Object.prototype.hasOwnProperty.call(remap, r)) return remap[r];
    return SAFE_NODE_ID_RE.test(r) ? ref : null;
  };
  const nodes={};
  keys.forEach(k=>{
    const n=sanitizeMapNode(src[k]); if(!n) return;
    const id=remap[k]||k;
    n.id=id;
    if(n.parent!=null) n.parent=fix(n.parent);
    nodes[id]=n;
  });
  m.nodes=nodes;
  if(m.rootId!=null) m.rootId=fix(m.rootId);
  if(Array.isArray(m.links)){
    m.links=m.links.filter(l=>l && typeof l==='object').map(l=>({ ...l, from:fix(l.from), to:fix(l.to) })).filter(l=>l.from!=null && l.to!=null);
  }
  return m;
}

function isTableNode(n){
  if(!n || n.frontmatter) return false;
  if(n.table) return true;
  return !!(n.html && /<table[\s>]/i.test(n.html));
}
// Split a GFM row on UNESCAPED pipes. htmlTableToMarkdown writes a literal
// pipe inside a cell as \|, so honour that here and unescape it in the cell.
function splitPipeRow(line){
  let s=String(line||'').replace(/^\s*\|/, '').replace(/\s+$/, '');
  if(s.endsWith('|') && !s.endsWith('\\|')) s=s.slice(0, -1);
  const cells=[];
  let cur='';
  for(let i=0;i<s.length;i++){
    const ch=s[i];
    if(ch==='\\' && s[i+1]==='|'){ cur+='|'; i++; continue; }
    if(ch==='|'){ cells.push(cur.trim()); cur=''; continue; }
    cur+=ch;
  }
  cells.push(cur.trim());
  return cells;
}
function isGfmSepLine(line){
  if(!line || line.indexOf('-')<0) return false;
  const cells=splitPipeRow(line);
  return cells.length>=1 && cells.every(c => {
    const t=String(c).replace(/\s/g,'');
    return /^:?-+:?$/.test(t) && t.indexOf('-')>=0;
  });
}
function normalizeTableGrid(headers, rows, aligns){
  const cols=headers.length;
  if(cols<2) return null;
  const body=(rows||[]).map(r => {
    const row=r.slice();
    while(row.length<cols) row.push('');
    return row.slice(0, cols);
  });
  const out={ headers, rows: body };
  if(aligns && aligns.length){
    const a=aligns.slice();
    while(a.length<cols) a.push('');
    out.aligns=a.slice(0, cols);
  }
  return out;
}
function parseGfmAligns(sepLine){
  return splitPipeRow(sepLine).map(c => {
    const t=String(c).replace(/\s/g,'');
    const left=t.charAt(0)===':';
    const right=t.charAt(t.length-1)===':';
    if(left && right) return 'center';
    if(right) return 'right';
    if(left) return 'left';
    return '';
  });
}
function nodeTextForTableScan(text){
  return String(text==null?'':text)
    .replace(/\r\n/g,'\n').replace(/\r/g,'\n')
    .replace(/<br\s*\/?>/gi,'\n')
    .replace(/<\/(?:div|p)\s*>\s*<(?:div|p)\b[^>]*>/gi,'\n');
}
function splitTextWithGfmTables(text){
  const raw=nodeTextForTableScan(text);
  if(raw.indexOf('|')<0) return [{type:'text', value:raw}];
  const lines=raw.split('\n');
  const parts=[];
  let i=0, buf=[];
  const flush=()=>{
    if(!buf.length) return;
    parts.push({type:'text', value:buf.join('\n')});
    buf=[];
  };
  while(i<lines.length){
    const line=lines[i];
    if(line.indexOf('|')>=0 && i+1<lines.length && isGfmSepLine(lines[i+1])){
      const headers=splitPipeRow(line);
      if(headers.length>=2){
        const aligns=parseGfmAligns(lines[i+1]);
        const body=[];
        let j=i+2;
        while(j<lines.length && lines[j].indexOf('|')>=0 && String(lines[j]).trim()!==''){
          body.push(splitPipeRow(lines[j]));
          j++;
        }
        const grid=normalizeTableGrid(headers, body, aligns);
        if(grid){
          flush();
          parts.push({type:'table', grid});
          i=j;
          continue;
        }
      }
    }
    buf.push(line);
    i++;
  }
  flush();
  return parts.length ? parts : [{type:'text', value:raw}];
}
function nodeTextHasGfmTable(text){
  if(!text || String(text).indexOf('|')<0) return false;
  return splitTextWithGfmTables(text).some(p => p.type==='table');
}
function parseGfmMarkdownTable(text){
  const lines=String(text||'').split('\n').map(l => l.trim()).filter(l => l);
  if(lines.length<2) return null;
  if(lines[0].indexOf('|')<0) return null;
  const sepAt=lines.findIndex((l,i) => i>0 && isGfmSepLine(l));
  if(sepAt<0){
    const rows=lines.map(splitPipeRow);
    if(!rows.every(r => r.length===rows[0].length)) return null;
    return normalizeTableGrid(rows[0], rows.slice(1));
  }
  const headers=splitPipeRow(lines[0]);
  const aligns=parseGfmAligns(lines[sepAt]);
  const body=lines.slice(sepAt+1).filter(l => l.indexOf('|')>=0).map(splitPipeRow);
  return normalizeTableGrid(headers, body, aligns);
}
function parseDelimitedTable(lines, delim){
  const rows=lines.filter(l => String(l).trim()!=='').map(l => String(l).split(delim).map(c => c.trim()));
  if(rows.length<2) return null;
  const n=rows[0].length;
  if(n<2) return null;
  if(!rows.every(r => r.length===n)) return null;
  return normalizeTableGrid(rows[0], rows.slice(1));
}
function parseFlatCopiedTable(lines){
  const nonempty=lines.map(l => String(l).replace(/\s+$/,'')).filter(l => l!=='');
  const headAt=nonempty.findIndex(l => l.indexOf('\t')>=0 && l.split('\t').length>=2);
  if(headAt<0) return null;
  const headers=nonempty[headAt].split('\t').map(c => c.trim());
  const n=headers.length;
  if(n<2) return null;
  const rest=nonempty.slice(headAt+1);
  if(!rest.length) return null;
  if(rest.every(l => l.split('\t').length===n)){
    return normalizeTableGrid(headers, rest.map(l => l.split('\t').map(c => c.trim())));
  }
  if(rest.some(l => l.indexOf('\t')>=0)) return null;
  if(rest.length<n) return null;
  const rows=[];
  for(let i=0;i<rest.length;i+=n){
    const row=rest.slice(i, i+n).map(c => c.trim());
    while(row.length<n) row.push('');
    rows.push(row);
  }
  return normalizeTableGrid(headers, rows);
}
function parseMarkdownTable(raw){
  const text=String(raw==null?'':raw).replace(/^\uFEFF/, '').replace(/\r\n/g,'\n').replace(/\r/g,'\n').trim();
  if(!text) return null;
  const gfm=parseGfmMarkdownTable(text);
  if(gfm) return gfm;
  const lines=text.split('\n');
  const tsv=parseDelimitedTable(lines, '\t');
  if(tsv) return tsv;
  return parseFlatCopiedTable(lines);
}
function markdownTableToHtml(grid, cellHtml){
  if(!grid || !grid.headers || grid.headers.length<2) return '';
  const esc=s => String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const cell=typeof cellHtml==='function' ? cellHtml : esc;
  const align=i=>{
    const a=grid.aligns && grid.aligns[i];
    return a ? ' style="text-align:'+a+'"' : '';
  };
  const head='<thead><tr>'+grid.headers.map((h,i) => '<th'+align(i)+'>'+cell(h)+'</th>').join('')+'</tr></thead>';
  const body='<tbody>'+(grid.rows||[]).map(r => '<tr>'+grid.headers.map((_,i) => '<td'+align(i)+'>'+cell(r[i]||'')+'</td>').join('')+'</tr>').join('')+'</tbody>';
  return '<table>'+head+body+'</table>';
}
function formatNodeTableCell(raw){
  const escaped=String(raw==null?'':raw).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const html=typeof mdInlineToHtml==='function' ? mdInlineToHtml(escaped) : escaped;
  return typeof sanitizeInlineHTML==='function' ? sanitizeInlineHTML(html) : html;
}
function appendNodeMarkdownTable(container, grid){
  const wrap=document.createElement('div');
  wrap.className='node-md-table';
  wrap.innerHTML=markdownTableToHtml(grid, formatNodeTableCell);
  container.appendChild(wrap);
}
function htmlTableToGrid(html){
  if(!html || typeof document==='undefined') return null;
  const tpl=document.createElement('template');
  tpl.innerHTML=html;
  const table=tpl.content.querySelector('table');
  if(!table) return null;
  const rows=[...table.querySelectorAll('tr')].map(tr => [...tr.querySelectorAll('th,td')].map(c => (c.textContent||'').trim()));
  if(rows.length<1 || rows[0].length<2) return null;
  return normalizeTableGrid(rows[0], rows.slice(1));
}
function htmlTableToMarkdown(html){
  const grid=htmlTableToGrid(html);
  if(!grid) return '';
  const cell=c => String(c==null?'':c).replace(/\|/g,'\\|');
  const row=cells => '| '+cells.map(cell).join(' | ')+' |';
  const sep='| '+grid.headers.map(()=> '---').join(' | ')+' |';
  return [row(grid.headers), sep].concat(grid.rows.map(row)).join('\n');
}
// ---------------------------------------------------------------------------
// Minimal, dependency-free LaTeX -> MathML converter. Covers the common inline
// subset: sub/superscripts, Greek, operators/relations/arrows/sets, \frac,
// \sqrt (+ optional index), accents, math fonts, function names, spacing.
// NOT full LaTeX (no matrices / aligned environments / sized limits). Output is
// assembled only from a fixed MathML vocabulary with every literal escaped, so
// it never echoes user HTML and is safe to inject (bypassing the HTML sanitizer
// which intentionally drops user-supplied <math>/<svg>).
// ---------------------------------------------------------------------------
const MATH_GREEK = {
  alpha:'\u03b1',beta:'\u03b2',gamma:'\u03b3',delta:'\u03b4',epsilon:'\u03f5',varepsilon:'\u03b5',
  zeta:'\u03b6',eta:'\u03b7',theta:'\u03b8',vartheta:'\u03d1',iota:'\u03b9',kappa:'\u03ba',
  lambda:'\u03bb',mu:'\u03bc',nu:'\u03bd',xi:'\u03be',pi:'\u03c0',varpi:'\u03d6',rho:'\u03c1',
  varrho:'\u03f1',sigma:'\u03c3',varsigma:'\u03c2',tau:'\u03c4',upsilon:'\u03c5',phi:'\u03d5',
  varphi:'\u03c6',chi:'\u03c7',psi:'\u03c8',omega:'\u03c9',
  Gamma:'\u0393',Delta:'\u0394',Theta:'\u0398',Lambda:'\u039b',Xi:'\u039e',Pi:'\u03a0',
  Sigma:'\u03a3',Upsilon:'\u03a5',Phi:'\u03a6',Psi:'\u03a8',Omega:'\u03a9'
};
const MATH_OP = {
  dagger:'\u2020',ddagger:'\u2021',times:'\u00d7',div:'\u00f7',cdot:'\u22c5',ast:'\u2217',
  star:'\u22c6',circ:'\u2218',bullet:'\u2219',pm:'\u00b1',mp:'\u2213',oplus:'\u2295',
  ominus:'\u2296',otimes:'\u2297',oslash:'\u2298',odot:'\u2299',
  leq:'\u2264',le:'\u2264',geq:'\u2265',ge:'\u2265',neq:'\u2260',ne:'\u2260',approx:'\u2248',
  equiv:'\u2261',cong:'\u2245',sim:'\u223c',simeq:'\u2243',propto:'\u221d',ll:'\u226a',gg:'\u226b',
  leftarrow:'\u2190',rightarrow:'\u2192',to:'\u2192',gets:'\u2190',leftrightarrow:'\u2194',
  Leftarrow:'\u21d0',Rightarrow:'\u21d2',Leftrightarrow:'\u21d4',mapsto:'\u21a6',
  uparrow:'\u2191',downarrow:'\u2193',implies:'\u27f9',iff:'\u27fa',
  in:'\u2208',notin:'\u2209',ni:'\u220b',subset:'\u2282',subseteq:'\u2286',supset:'\u2283',
  supseteq:'\u2287',cup:'\u222a',cap:'\u2229',setminus:'\u2216',emptyset:'\u2205',varnothing:'\u2205',
  forall:'\u2200',exists:'\u2203',nexists:'\u2204',neg:'\u00ac',lnot:'\u00ac',land:'\u2227',
  wedge:'\u2227',lor:'\u2228',vee:'\u2228',
  langle:'\u27e8',rangle:'\u27e9',lfloor:'\u230a',rfloor:'\u230b',lceil:'\u2308',rceil:'\u2309',
  sum:'\u2211',prod:'\u220f',coprod:'\u2210',int:'\u222b',oint:'\u222e',iint:'\u222c',iiint:'\u222d',
  partial:'\u2202',nabla:'\u2207',angle:'\u2220',perp:'\u22a5',parallel:'\u2225',mid:'\u2223',
  cdots:'\u22ef',ldots:'\u2026',dots:'\u2026',vdots:'\u22ee',ddots:'\u22f1',prime:'\u2032'
};
const MATH_ID = { infty:'\u221e',hbar:'\u210f',ell:'\u2113',Re:'\u211c',Im:'\u2111',aleph:'\u2135',wp:'\u2118' };
const MATH_FUNCS = new Set(['sin','cos','tan','cot','sec','csc','sinh','cosh','tanh','log','ln','lg',
  'exp','lim','limsup','liminf','max','min','sup','inf','arg','det','dim','ker','deg','gcd','hom','Pr',
  'arcsin','arccos','arctan','mod']);
const MATH_ACCENT = { hat:'\u005e',widehat:'\u005e',tilde:'\u007e',widetilde:'\u007e',bar:'\u203e',
  overline:'\u203e',vec:'\u2192',dot:'\u02d9',ddot:'\u00a8',acute:'\u00b4',grave:'\u0060',check:'\u02c7',breve:'\u02d8' };
const MATH_FONT = { mathbb:'double-struck',mathcal:'script',mathfrak:'fraktur',mathbf:'bold',
  boldsymbol:'bold',mathrm:'normal',mathsf:'sans-serif',mathtt:'monospace',mathit:'italic' };
const MATH_SPACE = { ',':'0.17em',':':'0.22em',';':'0.28em','!':'-0.17em',quad:'1em',qquad:'2em' };

function _mathEsc(x){ return String(x).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

function latexToMathML(src, display){
  let i=0; const s=src||'';
  const mrow = a => a.length===1 ? a[0] : '<mrow>'+a.join('')+'</mrow>';
  const EMPTY='<mrow></mrow>';
  function skipWs(){ while(i<s.length && /\s/.test(s[i])) i++; }
  function readGroup(){ skipWs(); if(s[i]==='{'){ i++; return mrow(parseList('}')); } return parseAtom()||EMPTY; }
  function readRaw(){ skipWs(); if(s[i]!=='{'){ const c=s[i++]; return c||''; } i++; let d=1,out='';
    while(i<s.length && d>0){ const c=s[i++]; if(c==='{')d++; else if(c==='}'){ d--; if(d===0)break; } out+=c; } return out; }
  function parseCommand(){
    i++; let name='';
    if(/[a-zA-Z]/.test(s[i])){ while(i<s.length && /[a-zA-Z]/.test(s[i])) name+=s[i++]; } else { name=s[i++]||''; }
    if(name==='frac'||name==='tfrac'||name==='dfrac'){ const a=readGroup(),b=readGroup(); return '<mfrac>'+a+b+'</mfrac>'; }
    if(name==='binom'){ const a=readGroup(),b=readGroup(); return '<mrow><mo>(</mo><mfrac linethickness="0">'+a+b+'</mfrac><mo>)</mo></mrow>'; }
    if(name==='sqrt'){ let idx=null; skipWs(); if(s[i]==='['){ i++; idx=mrow(parseList(']')); } const a=readGroup(); return idx? '<mroot>'+a+idx+'</mroot>' : '<msqrt>'+a+'</msqrt>'; }
    if(MATH_ACCENT[name]){ const a=readGroup(); return '<mover accent="true">'+a+'<mo>'+_mathEsc(MATH_ACCENT[name])+'</mo></mover>'; }
    if(MATH_FONT[name]){ const raw=readRaw(); return '<mi mathvariant="'+MATH_FONT[name]+'">'+_mathEsc(raw)+'</mi>'; }
    if(name==='text'||name==='textrm'||name==='textbf'||name==='mbox'){ const raw=readRaw(); return '<mtext>'+_mathEsc(raw)+'</mtext>'; }
    if(name==='operatorname'){ const raw=readRaw(); return '<mi mathvariant="normal">'+_mathEsc(raw)+'</mi>'; }
    if(name==='left'||name==='right'){ skipWs(); const d=s[i++]||''; if(d==='.') return ''; return '<mo stretchy="true">'+_mathEsc(d)+'</mo>'; }
    if(MATH_SPACE[name]!==undefined){ return '<mspace width="'+MATH_SPACE[name]+'"/>'; }
    if(MATH_OP[name]!==undefined){ return '<mo>'+_mathEsc(MATH_OP[name])+'</mo>'; }
    if(MATH_ID[name]!==undefined){ return '<mi>'+_mathEsc(MATH_ID[name])+'</mi>'; }
    if(MATH_GREEK[name]!==undefined){ return '<mi>'+_mathEsc(MATH_GREEK[name])+'</mi>'; }
    if(MATH_FUNCS.has(name)){ return '<mi>'+_mathEsc(name)+'</mi>'; }
    if(name==='\\'){ return '<mspace linebreak="newline"/>'; }
    return '<mtext>\\'+_mathEsc(name)+'</mtext>';
  }
  function parseAtom(){
    const ch=s[i]; if(ch===undefined) return '';
    if(ch==='{'){ i++; return mrow(parseList('}')); }
    if(ch==='\\') return parseCommand();
    i++;
    if(/\s/.test(ch)) return '';
    if(ch>='0'&&ch<='9'){ let num=ch; while(i<s.length && /[0-9.]/.test(s[i])) num+=s[i++]; return '<mn>'+num+'</mn>'; }
    if(/[a-zA-Z]/.test(ch)) return '<mi>'+ch+'</mi>';
    if(ch==='-') return '<mo>\u2212</mo>';
    if(ch==="'") return '<mo>\u2032</mo>';
    return '<mo>'+_mathEsc(ch)+'</mo>';
  }
  function parseList(stop){
    const out=[];
    while(i<s.length){
      const ch=s[i];
      if(stop && ch===stop){ i++; break; }
      if(!stop && ch==='}'){ break; }
      if(ch==='_'||ch==='^'){
        i++; skipWs();
        const base=out.length?out.pop():EMPTY; let sub=null,sup=null;
        if(ch==='_'){ sub=readGroup(); skipWs(); if(s[i]==='^'){ i++; skipWs(); sup=readGroup(); } }
        else { sup=readGroup(); skipWs(); if(s[i]==='_'){ i++; skipWs(); sub=readGroup(); } }
        if(sub!=null && sup!=null) out.push('<msubsup>'+base+sub+sup+'</msubsup>');
        else if(sub!=null) out.push('<msub>'+base+sub+'</msub>');
        else out.push('<msup>'+base+sup+'</msup>');
        continue;
      }
      const a=parseAtom(); if(a) out.push(a);
    }
    return out;
  }
  const body = mrow(parseList(null));
  return '<math xmlns="http://www.w3.org/1998/Math/MathML"'+(display?' display="block"':'')+'>'+body+'</math>';
}

// $$...$$ (display) or $...$ (inline, no leading/trailing space to avoid matching prose like "$5 ... $10")
const MATH_DELIM_RE = /\$\$([\s\S]+?)\$\$|\$(?!\s)([^$\n]+?)(?<!\s)\$/;
function containsMath(text){
  if(!text || text.indexOf('$')<0) return false;
  return new RegExp(MATH_DELIM_RE.source).test(text);
}

// Render text that may contain BOTH inline formatting/markup AND $...$ math.
// Math is extracted first into placeholder tokens (so its contents are never
// parsed as HTML), the remaining text is formatted/linked, then the rendered
// MathML is dropped back in. Lets math coexist with bold/italic/bullets/links —
// <b>$x^2$</b>, bulleted equations, etc.  (PUA placeholders survive HTML parsing.)
function renderFormattedWithMath(container, text){
  const slots=[];
  const re=new RegExp(MATH_DELIM_RE.source,'g');
  const masked=(text||'').replace(re,(full,dd,inl)=>{
    const tex = dd!=null ? dd : inl, display = dd!=null;
    let mathml=null; try{ mathml=latexToMathML(tex, display); }catch(e){ mathml=null; }
    slots.push({mathml, original: full});
    return '\uE000'+(slots.length-1)+'\uE001';
  });
  // Entities (&rarr; &#8594; ...) only decode via innerHTML, so route them through
  // the sanitizer too — createTextNode would show them literally.
  if(hasInlineMarkup(masked) || HTML_ENTITY_RE.test(masked)) container.innerHTML = sanitizeInlineHTML(masked);
  else container.appendChild(document.createTextNode(masked));
  autoLinkPlainTextNodes(container);
  if(!slots.length) return;
  const walker=document.createTreeWalker(container, NodeFilter.SHOW_TEXT, null);
  const hits=[]; let tn;
  while((tn=walker.nextNode())){ if(tn.nodeValue && tn.nodeValue.indexOf('\uE000')>=0) hits.push(tn); }
  hits.forEach(node=>{
    const parts=node.nodeValue.split(/\uE000(\d+)\uE001/);   // [text, idx, text, idx, ...]
    const frag=document.createDocumentFragment();
    for(let i=0;i<parts.length;i++){
      if(i%2===0){ if(parts[i]) frag.appendChild(document.createTextNode(parts[i])); }
      else {
        const slot=slots[+parts[i]];
        if(slot && slot.mathml){ const tmp=document.createElement('span'); tmp.innerHTML=slot.mathml; while(tmp.firstChild) frag.appendChild(tmp.firstChild); }
        else frag.appendChild(document.createTextNode(slot ? slot.original : ''));
      }
    }
    node.parentNode.replaceChild(frag, node);
  });
}
// Formats a node's created/updated timestamp for the hover watermark — e.g. "Jul 15, 2026 · 3:42 PM".
// Uses the browser's own locale, same as everything else in the app that shows a date.
function formatNodeTimestamp(ts){
  if(!ts) return '';
  try{
    const d=new Date(ts);
    if(isNaN(d.getTime())) return '';
    return d.toLocaleDateString(undefined,{month:'short',day:'numeric',year:'numeric'})+' \u00b7 '+d.toLocaleTimeString(undefined,{hour:'numeric',minute:'2-digit'});
  }catch(e){ return ''; }
}
function renderNodeTextList(container, text, listType){
  const isHTML = hasInlineMarkup(text);
  let lines;
  if(isHTML){
    const tmp=document.createElement('div'); tmp.innerHTML=sanitizeInlineHTML(text);
    tmp.querySelectorAll('br').forEach(br=>br.replaceWith(document.createTextNode('\n')));
    lines = tmp.innerHTML.split(/\n+/);
  } else {
    lines = (text||'').split('\n');
  }
  lines.forEach((line, i)=>{
    if(i>0) container.appendChild(document.createElement('br'));
    const prefix = document.createElement('span');
    prefix.className='list-marker';
    prefix.textContent = listType==='ol' ? `${i+1}.\u00A0` : '•\u00A0';
    container.appendChild(prefix);
    const span=document.createElement('span');
    container.appendChild(span);
    renderFormattedWithMath(span, line);
  });
}
function renderNodeText(container, text, listType){
  container.textContent='';
  const parts=splitTextWithGfmTables(text);
  if(parts.some(p => p.type==='table')){
    container.classList.add('has-md-table');
    parts.forEach(p=>{
      if(p.type==='table') appendNodeMarkdownTable(container, p.grid);
      else if(p.value){
        const span=document.createElement('span');
        span.className='node-md-text';
        if(listType) renderNodeTextList(span, p.value, listType);
        else renderFormattedWithMath(span, p.value);
        container.appendChild(span);
      }
    });
    return;
  }
  if(!listType){
    renderFormattedWithMath(container, text);
    return;
  }
  renderNodeTextList(container, text, listType);
}
// Walk text nodes inside `root` and convert any bare URLs into <a> links.
// Skips text already inside an <a>, so we don't double-link.
function autoLinkPlainTextNodes(root){
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const toReplace=[];
  let node;
  while((node = walker.nextNode())){
    if(node.parentElement && node.parentElement.closest('a')) continue;
    // URL_RE is global: .test() advances lastIndex, so reset it or the next
    // text node is searched from the previous match's end and can be missed.
    URL_RE.lastIndex=0;
    if(URL_RE.test(node.nodeValue||'')) toReplace.push(node);
  }
  toReplace.forEach(t=>{
    const frag=document.createDocumentFragment();
    appendTextWithLinks(frag, t.nodeValue||'');
    t.parentNode.replaceChild(frag, t);
  });
}

function colorFor(hex){ // root gradient
  return `linear-gradient(135deg, ${hex}, ${shade(hex,-22)})`;
}
function shade(hex,amt){
  const n=parseInt(hex.slice(1),16);
  let r=(n>>16)+amt,g=((n>>8)&255)+amt,b=(n&255)+amt;
  r=Math.max(0,Math.min(255,r));g=Math.max(0,Math.min(255,g));b=Math.max(0,Math.min(255,b));
  return '#'+((r<<16)|(g<<8)|b).toString(16).padStart(6,'0');
}
function drawEdges(hidden){
  const style=map.style||'modern';
  const layout=map.layout||'balanced';
  let path='';
  for(const id in map.nodes){
    const n=map.nodes[id]; if(!n.parent||hidden.has(id)||hidden.has(n.parent)) continue;
    const p=map.nodes[n.parent]; if(!p) continue;
    // Choose attach points based on layout orientation
    let x1,y1,x2,y2,horizontal=true,leftSide=(n.side==='left');
    if(layout==='timeline' && n.parent!==map.rootId){
      // Sub-topic stem: straight up (or down) out of the main topic, then
      // across to the child. Direction is derived from the placed geometry
      // rather than a stored side, so it stays correct if a node is dragged.
      const pcx=p.x+(p.w||0)/2, pcy=p.y+(p.h||0)/2;
      const ncy=n.y+(n.h||0)/2;
      const sx=pcx, sy = ncy<pcy ? p.y : p.y+(p.h||0);
      path += `M${sx},${sy} L${sx},${ncy} L${n.x},${ncy} `;
      continue;
    }
    if(layout==='radial'){
      // Spokes. The default bezier attaches to a card's left or right edge,
      // which on a radial map sends a connector for a node directly ABOVE the
      // centre looping out sideways and back — the single thing that stopped
      // it reading as radial. Centre-to-centre is the honest line here: the
      // edge SVG sits beneath the cards, so the overlap is hidden and what
      // remains is a clean spoke.
      const pcx=p.x+(p.w||0)/2, pcy=p.y+(p.h||0)/2;
      const ncx=n.x+(n.w||0)/2, ncy=n.y+(n.h||0)/2;
      path += `M${pcx},${pcy} L${ncx},${ncy} `;
      continue;
    }
    if(layout==='grid'){
      if(n.parent===map.rootId){
        // Root to card: drop, across, drop. Long curves between grid cards
        // read as accidental rather than structural.
        const sx=p.x+(p.w||0)/2, sy=p.y+(p.h||0);
        const tx=n.x+(n.w||0)/2, ty=n.y;
        const mid=(sy+ty)/2;
        path += `M${sx},${sy} L${sx},${mid} L${tx},${mid} L${tx},${ty} `;
      } else {
        // Within a card's outline: the classic indented-list elbow — straight
        // down the parent's left edge, then across to the child. Indentation
        // already carries the hierarchy, so this only needs to confirm it.
        const sx=p.x+12, sy=p.y+(p.h||0);
        const ty=n.y+(n.h||0)/2;
        path += `M${sx},${sy} L${sx},${ty} L${n.x},${ty} `;
      }
      continue;
    }
    if(layout==='down'){
      horizontal=false;
      x1=p.x+(p.w||0)/2; y1=p.y+(p.h||0);
      x2=n.x+(n.w||0)/2; y2=n.y;
    } else {
      x1=leftSide ? p.x : p.x+(p.w||0);
      y1=p.y+(p.h||0)/2;
      x2=leftSide ? n.x+(n.w||0) : n.x;
      y2=n.y+(n.h||0)/2;
    }
    path += edgePath(x1,y1,x2,y2,leftSide,horizontal,style)+' ';
  }
  // Cross-links: non-tree edges (references / dependencies). Drawn as separate
  // dotted paths so they read differently from the structural tree edges.
  let linkPath='';
  (map.links||[]).forEach(lk=>{
    const a=map.nodes[lk.from], b=map.nodes[lk.to];
    if(!a||!b) return;
    if(hidden.has(lk.from)||hidden.has(lk.to)) return;
    const ax=a.x+(a.w||120)/2, ay=a.y+(a.h||40)/2;
    const bx=b.x+(b.w||120)/2, by=b.y+(b.h||40)/2;
    // Gentle curve so overlapping links are distinguishable
    const mx=(ax+bx)/2, my=(ay+by)/2;
    const dx=bx-ax, dy=by-ay;
    const len=Math.hypot(dx,dy)||1;
    const off=Math.min(60, len*0.18);
    const cx=mx - (dy/len)*off, cy=my + (dx/len)*off;
    linkPath += `M${ax},${ay} Q${cx},${cy} ${bx},${by} `;
  });
  edges.innerHTML =
    `<path d="${path}" fill="none" stroke="var(--edge-color, var(--line-2))" stroke-width="var(--edge-width, 2.2)" stroke-linecap="round"/>` +
    (linkPath ? `<path d="${linkPath}" fill="none" stroke="var(--accent)" stroke-width="2" stroke-dasharray="2 6" stroke-linecap="round" opacity="0.85"/>` : '');
}
function edgePath(x1,y1,x2,y2,leftSide,horizontal,style){
  switch(style){
    case 'classic': {                                   // step / right-angle elbow
      if(horizontal){
        const mid=(x1+x2)/2;
        return `M${x1},${y1} L${mid},${y1} L${mid},${y2} L${x2},${y2}`;
      } else {
        const mid=(y1+y2)/2;
        return `M${x1},${y1} L${x1},${mid} L${x2},${mid} L${x2},${y2}`;
      }
    }
    case 'sketch': return `M${x1},${y1} L${x2},${y2}`;  // straight line
    case 'bubble':                                       // same path as modern but CSS makes it thicker
    case 'modern':
    default: {                                           // smooth bezier
      if(horizontal){
        const dx=Math.abs(x2-x1)*0.5;
        return `M${x1},${y1} C${x1+(leftSide?-dx:dx)},${y1} ${x2+(leftSide?dx:-dx)},${y2} ${x2},${y2}`;
      } else {
        const dy=Math.abs(y2-y1)*0.5;
        return `M${x1},${y1} C${x1},${y1+dy} ${x2},${y2-dy} ${x2},${y2}`;
      }
    }
  }
}

/* ---------- tree helpers ---------- */
// ---- Children index (perf) -------------------------------------------------
// childrenOf is called all over layout/render. Scanning every node each time is
// O(n) per call → O(n²) renders/layouts on big maps. When a parent→children
// index is active (set up for the duration of a render/layout pass), childrenOf
// is O(1). buildChildIndex() builds it in one O(n) pass; withChildIndex(fn) makes
// it available for the duration of fn and restores any previous index after.
let _ci=null;
const EMPTY_KIDS=Object.freeze([]);
function buildChildIndex(){
  const idx=Object.create(null);
  for(const id in map.nodes){
    const p=map.nodes[id].parent;
    if(p==null) continue;
    (idx[p] || (idx[p]=[])).push(id);
  }
  return idx;
}
function withChildIndex(fn){
  const prev=_ci;
  _ci=buildChildIndex();
  try{ return fn(); } finally{ _ci=prev; }
}
const childrenOf=id => _ci
  ? (_ci[id] ? _ci[id].slice() : EMPTY_KIDS)
  : Object.values(map.nodes).filter(n=>n.parent===id).map(n=>n.id);
function countDesc(id){let c=0;const walk=i=>childrenOf(i).forEach(k=>{c++;walk(k)});walk(id);return c;}
// One O(n) post-order pass computing, for every node: descendant count (desc),
// and task done/total among descendants (tdone/ttot). render() uses these instead
// of calling countDesc()/taskProgress() per node, which were each O(subtree) and
// made a full render O(n²) — the real cost when expanding a large map.
function computeRollups(){
  const desc=Object.create(null), tdone=Object.create(null), ttot=Object.create(null);
  const order=[]; const stack=[map.rootId];
  while(stack.length){ const id=stack.pop(); order.push(id); const ks=childrenOf(id); for(let j=0;j<ks.length;j++) stack.push(ks[j]); }
  for(let i=order.length-1;i>=0;i--){
    const id=order[i]; let d=0,td=0,tt=0;
    const ks=childrenOf(id);
    for(let j=0;j<ks.length;j++){
      const c=ks[j]; d+=desc[c]+1;
      const t=map.nodes[c].task;
      tt+=ttot[c]+(t?1:0); td+=tdone[c]+(t==='done'?1:0);
    }
    desc[id]=d; tdone[id]=td; ttot[id]=tt;
  }
  return {desc,tdone,ttot};
}
function hiddenSet(){
  const h=new Set();
  // Use the active index if we're inside a render/layout scope; otherwise build
  // one locally so this is always O(n), never O(n²) (it's also called by
  // fit/recenter/exportPNG/minimap, which run outside the render scope).
  const idx=_ci || buildChildIndex();
  const walk=(id, hide)=>{
    const newHide = hide || !!map.nodes[id]?.collapsed;
    const kids=idx[id]; if(!kids) return;
    for(const c of kids){ if(newHide) h.add(c); walk(c, newHide); }
  };
  walk(map.rootId,false);
  return h;
}

/* ============================================================
   LAYOUT — tidy tree, supports balanced / right / down
   ============================================================ */
const HGAP=70, VGAP=22, DOWN_HGAP=38, DOWN_VGAP=70;

// ===== Global overlap avoidance =====
// Layout places from stored n.w/n.h. Those sizes go stale whenever wrapping,
// font, zoom, or a badge makes a card taller than last time — then siblings
// stack using the too-small height and visually overlap. After measuring the
// live boxes, nudge colliding subtrees apart. Parent/child pairs are skipped
// (they are supposed to sit along a connector). Manual arrangement is kept
// except where boxes actually collide.
function nodeLayoutBox(n){ return {x:n.x, y:n.y, w:n.w||120, h:n.h||40}; }
function boxesOverlap(a,b,gap){
  gap=gap||0;
  return a.x < b.x+b.w+gap && a.x+a.w+gap > b.x && a.y < b.y+b.h+gap && a.y+a.h+gap > b.y;
}
function layoutSizesGrew(before, nodes, hidden){
  hidden=hidden||new Set();
  for(const id in nodes){
    if(hidden.has(id)) continue;
    const n=nodes[id], b=before&&before[id];
    if(!b) return true;
    if((n.h||0)>(b.h||0)+1.5 || (n.w||0)>(b.w||0)+1.5) return true;
  }
  return false;
}
function collectSubtreeIds(id, kidsOf){
  const s=new Set([id]);
  const walk=i=>kidsOf(i).forEach(c=>{ s.add(c); walk(c); });
  walk(id);
  return s;
}
function shiftSubtreeNodes(nodes, id, dx, dy, kidsOf){
  const n=nodes[id]; if(!n) return;
  n.x+=dx; n.y+=dy;
  kidsOf(id).forEach(c=>shiftSubtreeNodes(nodes, c, dx, dy, kidsOf));
}
function resolveNodeOverlaps(nodes, opts){
  if(!nodes) return false;
  opts=opts||{};
  const gap=opts.gap==null?16:opts.gap;
  const vertical=opts.vertical!==false;
  const hidden=opts.hidden||new Set();
  const kidsOf=opts.kidsOf||(id=>Object.keys(nodes).filter(k=>nodes[k]&&nodes[k].parent===id));
  const ids=Object.keys(nodes).filter(id=>nodes[id]&&!hidden.has(id));
  const anchorSet=opts.anchorId?collectSubtreeIds(opts.anchorId, kidsOf):new Set();
  let moved=false, iterations=0;
  while(iterations++<80){
    let movedAny=false;
    for(let i=0;i<ids.length;i++){
      for(let j=i+1;j<ids.length;j++){
        const A=ids[i], B=ids[j];
        const na=nodes[A], nb=nodes[B];
        if(na.parent===B || nb.parent===A) continue;
        const a=nodeLayoutBox(na), b=nodeLayoutBox(nb);
        if(!boxesOverlap(a,b,gap)) continue;
        let mover;
        if(anchorSet.has(A)&&!anchorSet.has(B)) mover=B;
        else if(anchorSet.has(B)&&!anchorSet.has(A)) mover=A;
        else mover=vertical?(a.y<=b.y?B:A):(a.x<=b.x?B:A);
        const other=mover===A?B:A;
        const mb=nodeLayoutBox(nodes[mover]), ob=nodeLayoutBox(nodes[other]);
        if(vertical){
          const dir=(mb.y>=ob.y)?1:-1;
          const push=dir>0?(ob.y+ob.h+gap-mb.y):(mb.y+mb.h+gap-ob.y);
          if(push>0){ shiftSubtreeNodes(nodes, mover, 0, dir*push, kidsOf); movedAny=true; moved=true; }
        } else {
          const dir=(mb.x>=ob.x)?1:-1;
          const push=dir>0?(ob.x+ob.w+gap-mb.x):(mb.x+mb.w+gap-ob.x);
          if(push>0){ shiftSubtreeNodes(nodes, mover, dir*push, 0, kidsOf); movedAny=true; moved=true; }
        }
      }
    }
    if(!movedAny) break;
  }
  return moved;
}
function _nbox(id){ return nodeLayoutBox(map.nodes[id]); }
function _overlap(a,b,gap){ return boxesOverlap(a,b,gap); }
function _subtreeSet(id){ return collectSubtreeIds(id, childrenOf); }
function shiftSubtreeBy(id,dx,dy){ shiftSubtreeNodes(map.nodes, id, dx, dy, childrenOf); }
function resolveOverlaps(anchorId){
  if(!map) return false;
  return resolveNodeOverlaps(map.nodes, {
    gap:16,
    vertical:(map.layout||'balanced')!=='down',
    hidden:hiddenSet(),
    kidsOf:childrenOf,
    anchorId
  });
}
// Visible cards that are not in a parent/child chain. Used on map load to
// decide whether stale x/y (translated text that wrapped, zoom, font) need a
// full tree relayout. Sibling-only nudges leave cousin branches stacked.
function mapHasCardOverlap(nodes, opts){
  if(!nodes) return false;
  opts=opts||{};
  const hidden=opts.hidden||new Set();
  const ids=[];
  for(const id in nodes){
    if(hidden.has(id)) continue;
    if(nodes[id]) ids.push(id);
  }
  // Sweep by x: once a later box starts past this one's right edge, no later
  // box can overlap it either. The ancestor walk runs only on overlapping pairs.
  const boxes=ids.map(id=>({id, b:nodeLayoutBox(nodes[id])}));
  boxes.sort((p,q)=>(p.b.x||0)-(q.b.x||0));
  for(let i=0;i<boxes.length;i++){
    const a=boxes[i].b;
    for(let j=i+1;j<boxes.length;j++){
      const b=boxes[j].b;
      if(b.x>=a.x+a.w) break;
      if(!boxesOverlap(a, b, 0)) continue;
      const A=boxes[i].id, B=boxes[j].id;
      if(nodeIsAncestor(nodes, A, B) || nodeIsAncestor(nodes, B, A)) continue;
      return true;
    }
  }
  return false;
}
function nodeIsAncestor(nodes, ancestorId, id){
  let p=nodes[id] && nodes[id].parent;
  while(p){
    if(p===ancestorId) return true;
    p=nodes[p] && nodes[p].parent;
  }
  return false;
}

// Which axis tree siblings stack on for a resolved layout ({strategy, params}),
// or null when the layout is not a tree and siblings must not be nudged.
function siblingOverlapAxis(run){
  if(!run || run.strategy!=='tree') return null;
  return (run.params && run.params.axis==='y') ? 'horizontal' : 'vertical';
}

// Only same-parent, same-side siblings. A dense map has many unrelated
// branches whose boxes happen to overlap in 2D; shoving those apart would
// scatter the whole canvas. The overlap the user actually sees is two
// children of one node stacked on top of each other after a stale height.
function resolveSiblingOverlaps(nodes, opts){
  if(!nodes) return false;
  opts=opts||{};
  const gap=opts.gap==null?16:opts.gap;
  const vertical=opts.vertical!==false;
  const hidden=opts.hidden||new Set();
  const kidsOf=opts.kidsOf||(id=>Object.keys(nodes).filter(k=>nodes[k]&&nodes[k].parent===id));
  const groups={};
  for(const id in nodes){
    if(hidden.has(id)) continue;
    const n=nodes[id];
    if(!n || !n.parent) continue;
    const key=n.parent+'|'+(n.side||'');
    (groups[key]||(groups[key]=[])).push(id);
  }
  let moved=false;
  for(const ids of Object.values(groups)){
    if(ids.length<2) continue;
    ids.sort((a,b)=> vertical ? ((nodes[a].y||0)-(nodes[b].y||0)) : ((nodes[a].x||0)-(nodes[b].x||0)));
    for(let i=0;i<ids.length-1;i++){
      const A=ids[i], B=ids[i+1];
      const a=nodeLayoutBox(nodes[A]), b=nodeLayoutBox(nodes[B]);
      // Siblings that are apart on the other axis do not collide, whatever
      // their order on this one.
      if(!boxesOverlap(a,b,gap)) continue;
      const need=vertical ? (a.y+a.h+gap) : (a.x+a.w+gap);
      const got=vertical ? b.y : b.x;
      if(got<need){
        const delta=need-got;
        if(vertical) shiftSubtreeNodes(nodes, B, 0, delta, kidsOf);
        else shiftSubtreeNodes(nodes, B, delta, 0, kidsOf);
        moved=true;
      }
    }
  }
  return moved;
}


// Assign root children to left/right by subtree weight for a balanced split.
// Used when first building a map (templates) or when explicitly re-balancing;
// stable autoLayout then preserves the assignment.
function balanceRootSides(){
  if(!map) return;
  // The "balanced" layout is the natural first-load arrangement: split the root
  // branches, in their existing top-to-bottom order, into two contiguous halves —
  // first half on the right, second half on the left. Matches how a fresh/imported
  // map is balanced and keeps branch order rather than reshuffling by weight.
  const kids=childrenOf(map.rootId);
  const half=Math.ceil(kids.length/2);
  kids.forEach((k,i)=>{ map.nodes[k].side = (i<half) ? 'right' : 'left'; });
}
// FLIP-animates nodes from their pre-layout positions (captured in `before`, {id:{x,y}})
// to wherever autoLayout() just placed them. Used after tidy layout / collapse-expand-all
// / any autoLayout() re-render, so the map eases into its new shape instead of jumping.
function flipAnimateNodes(before){
  if(!before || document.body.classList.contains('node-dragging')) return;
  if(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const toAnimate=[];
  document.querySelectorAll('.node[data-id]').forEach(el=>{
    const id=el.dataset.id, b=before[id], n=map && map.nodes[id];
    if(!b || !n) return;                     // brand-new node, or map gone: nothing to FLIP from
    const dx=b.x-n.x, dy=b.y-n.y;
    if(Math.abs(dx)<0.5 && Math.abs(dy)<0.5) return;   // negligible/no movement
    el.style.transition='none';
    el.style.transform=`translate(${dx}px,${dy}px)`;
    toAnimate.push(el);
  });
  if(!toAnimate.length) return;
  void document.body.offsetHeight;   // force layout so the browser registers the starting transform before animating away from it
  requestAnimationFrame(()=>{
    toAnimate.forEach(el=>{ el.style.transition='transform .22s cubic-bezier(.4,0,.2,1)'; el.style.transform=''; });
    setTimeout(()=>{ toAnimate.forEach(el=>{ el.style.transition=''; }); }, 260);   // hand back to the normal CSS transition afterward
  });
}
/* ------------------------------------------------------------
   Layout configuration.

   The knobs a layout exposes, as plain validated JSON stored on the map
   (map.layoutConfig) so it travels with exports and imports.

   Deliberately DATA, never code. A layout config arrives with any map
   file someone imports, so anything executable here would be a
   code-execution channel into imported maps — the opposite of the
   care taken in sanitizeInlineHTML(). Numbers get clamped, unknown keys are
   dropped, and a malformed config falls back to defaults rather than
   throwing: a bad config should never make a map unopenable.
   ------------------------------------------------------------ */
const LAYOUT_CONFIG_DEFAULTS = {
  // The four tree layouts share a shape (gap between depth levels, gap between
  // siblings) but not values: 'down' stacks generations vertically, so its
  // larger gap is the vertical one.
  balanced: { hGap:70, vGap:22 },
  right:    { hGap:70, vGap:22 },
  left:     { hGap:70, vGap:22 },
  down:     { hGap:38, vGap:70 },
  radial: { ring:180, startAngle:-90, sweep:360 },
  grid:   { columns:3, gapX:60, gapY:60, rowGap:14, indent:24 },
  timeline: {
    gap: 70,            // horizontal gap between consecutive main topics
    stem: 30,           // clearance between the axis and a sub-topic block
    indent: 26,         // sub-topic inset from its main topic's left edge
    alternate: true,    // alternate sub-topics above/below, or keep one side
    start: 'above',     // which side the first main topic's sub-topics take
  },
};
// Bounds chosen so any accepted value still produces a readable map: a gap of
// 0 overlaps cards, and very large values scatter them past a usable canvas.
const LAYOUT_CONFIG_BOUNDS = {
  balanced: { hGap:[8,400], vGap:[4,300] },
  right:    { hGap:[8,400], vGap:[4,300] },
  left:     { hGap:[8,400], vGap:[4,300] },
  down:     { hGap:[8,400], vGap:[4,300] },
  radial:   { ring:[60,600], startAngle:[-360,360], sweep:[30,360] },
  grid:     { columns:[1,8], gapX:[8,300], gapY:[8,300], rowGap:[0,120], indent:[0,120] },
  timeline: { gap:[8,400], stem:[0,300], indent:[0,300] },
};

function validateLayoutConfig(raw){
  const out = {};
  for(const engine of Object.keys(LAYOUT_CONFIG_DEFAULTS)){
    out[engine] = { ...LAYOUT_CONFIG_DEFAULTS[engine] };
  }
  if(!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;

  for(const engine of Object.keys(out)){
    const sec = raw[engine];
    if(!sec || typeof sec !== 'object' || Array.isArray(sec)) continue;
    const bounds = LAYOUT_CONFIG_BOUNDS[engine] || {};
    for(const key of Object.keys(bounds)){
      const v = sec[key];
      if(typeof v !== 'number' || !isFinite(v)) continue;  // strings/NaN ignored, not coerced
      const [lo,hi] = bounds[key];
      out[engine][key] = Math.min(hi, Math.max(lo, Math.round(v)));
    }
    if(engine === 'timeline'){
      if(typeof sec.alternate === 'boolean') out.timeline.alternate = sec.alternate;
      if(sec.start === 'above' || sec.start === 'below') out.timeline.start = sec.start;
    }
  }
  return out;
}
// The knobs that actually apply to one engine — what the settings dialog shows.
function layoutConfigFor(engine, raw){
  const all = validateLayoutConfig(raw);
  return all[engine] ? { [engine]: all[engine] } : {};
}

/* ------------------------------------------------------------
   Chain placement — root children strung along an axis, subtrees hanging off.

   The timeline is one instance of this: root at the left, main topics chained
   rightward on a centre line, sub-trees alternating above and below. The same
   procedure with a different axis gives a vertical timeline; with alternation
   off it gives a single-sided sequence.

   Like layoutTree, the two axes are transposes, so this works in "main" and
   "cross" terms:
     axis 'x'  main = x (the chain runs sideways), cross = y (branches hang up/down)
     axis 'y'  main = y (the chain runs downward),  cross = x (branches hang left/right)

   Mutates x/y/side on the given nodes.
   ------------------------------------------------------------ */
function layoutChain(nodes, rootId, kidsOf, opts){
  const horiz = opts.axis !== 'y';
  const dir = opts.dir < 0 ? -1 : 1;
  const { gap, stem, indent, gapMain, gapCross, alternate, start } = opts;
  // Fishbone is this engine with ribs leaving the spine at an angle instead of
  // square to it. 90 means perpendicular, which is the plain timeline, so the
  // default changes nothing for existing layouts.
  const angle = opts.angle != null ? opts.angle : 90;
  const slant = Math.abs(angle - 90) < 0.01 ? 0 : 1 / Math.tan(angle * Math.PI / 180);

  const mainSize  = n => horiz ? (n.w || 120) : (n.h || 40);
  const crossSize = n => horiz ? (n.h || 40)  : (n.w || 120);
  const setPos = (n, main, cross) => { if(horiz){ n.x = main; n.y = cross; } else { n.y = main; n.x = cross; } };
  const getMain  = n => horiz ? n.x : n.y;
  const getCross = n => horiz ? n.y : n.x;

  // Sub-tree extent along the cross axis (siblings stack there).
  const extent = id => {
    const n = nodes[id], cs = kidsOf(id);
    if(!cs.length || n.collapsed) return crossSize(n);
    let s = 0; cs.forEach((c,i)=>{ s += extent(c) + (i ? gapCross : 0); });
    return Math.max(crossSize(n), s);
  };
  // Ordinary tree placement, used for everything below a chain item.
  const place = (id, main, crossTop) => {
    const n = nodes[id];
    setPos(n, main, crossTop + (extent(id) - crossSize(n)) / 2);
    const cs = kidsOf(id);
    if(!cs.length || n.collapsed) return;
    let cross = crossTop;
    cs.forEach(c => {
      const cm = dir > 0 ? getMain(n) + mainSize(n) + gapMain
                         : getMain(n) - mainSize(nodes[c]) - gapMain;
      place(c, cm, cross);
      cross += extent(c) + gapCross;
    });
  };
  // Furthest point a placed sub-tree reaches along the chain direction, so the
  // next chain item can clear it.
  const reach = id => {
    const n = nodes[id];
    let r = dir > 0 ? getMain(n) + mainSize(n) : getMain(n);
    if(!n.collapsed) kidsOf(id).forEach(c => {
      const cr = reach(c);
      r = dir > 0 ? Math.max(r, cr) : Math.min(r, cr);
    });
    return r;
  };
  const assign = id => { nodes[id].side = opts.sideName || 'right'; kidsOf(id).forEach(assign); };

  const root = nodes[rootId];
  root.side = 'root';
  setPos(root, 0, -crossSize(root) / 2);          // the chain's centre line is cross = 0
  let cursor = dir > 0 ? mainSize(root) + gap : -gap;

  kidsOf(rootId).forEach((id, i) => {
    const item = nodes[id];
    assign(id);
    const itemMain = dir > 0 ? cursor : cursor - mainSize(item);
    setPos(item, itemMain, -crossSize(item) / 2);  // centred on the line
    let far = dir > 0 ? itemMain + mainSize(item) : itemMain;

    const kids = item.collapsed ? [] : kidsOf(id);
    if(kids.length){
      const first = (start === 'below') ? false : true;
      const up = alternate ? ((i % 2 === 0) === first) : first;
      let blockH = 0; kids.forEach((c,j)=>{ blockH += extent(c) + (j ? gapCross : 0); });
      let cross = up ? (getCross(item) - stem - blockH)
                     : (getCross(item) + crossSize(item) + stem);
      kids.forEach(c => {
        // How far this rib sits from the spine, and therefore how far it slides
        // back along it — which is what turns a square branch into a diagonal.
        const off = Math.abs(cross - getCross(item));
        const slide = slant ? off * slant * dir : 0;
        const base = dir > 0 ? getMain(item) + indent
                             : getMain(item) + mainSize(item) - indent - mainSize(nodes[c]);
        place(c, base + slide, cross);
        cross += extent(c) + gapCross;
      });
      kids.forEach(c => { const r = reach(c); far = dir > 0 ? Math.max(far, r) : Math.min(far, r); });
    }
    cursor = dir > 0 ? far + gap : far - gap;
  });
}

/* ------------------------------------------------------------
   Radial placement — root at the centre, descendants on rings.

   Each subtree owns an angular wedge sized by how many leaves it contains, so
   a bushy branch gets more of the circle than a sparse one and siblings never
   compete for the same arc. Depth becomes distance from the centre.

   Mutates x/y/side on the given nodes.
   ------------------------------------------------------------ */
function layoutRadial(nodes, rootId, kidsOf, opts){
  const ring   = opts.ring   != null ? opts.ring   : 180;   // radius added per level
  const start  = (opts.startAngle != null ? opts.startAngle : -90) * Math.PI / 180;
  const sweep  = (opts.sweep      != null ? opts.sweep      : 360) * Math.PI / 180;

  // Leaf count drives the wedge share. Counting leaves rather than nodes keeps
  // a long thin branch from crowding out a wide shallow one.
  const leaves = id => {
    const n = nodes[id];
    const cs = n.collapsed ? [] : kidsOf(id);
    if(!cs.length) return 1;
    let s = 0; cs.forEach(c => { s += leaves(c); });
    return s;
  };

  const place = (id, a0, a1, depth) => {
    const n = nodes[id];
    const mid = (a0 + a1) / 2;
    const r = depth * ring;
    // Position by centre, then convert to the top-left the renderer expects.
    n.x = Math.cos(mid) * r - (n.w || 120) / 2;
    n.y = Math.sin(mid) * r - (n.h || 40) / 2;
    // side drives which edge of the card connectors attach to.
    n.side = depth === 0 ? 'root' : (Math.cos(mid) < 0 ? 'left' : 'right');

    const cs = n.collapsed ? [] : kidsOf(id);
    if(!cs.length) return;
    const total = leaves(id);
    let a = a0;
    cs.forEach(c => {
      const share = (a1 - a0) * (leaves(c) / total);
      place(c, a, a + share, depth + 1);
      a += share;
    });
  };

  place(rootId, start, start + sweep, 0);
  nodes[rootId].side = 'root';
}

/* ------------------------------------------------------------
   Matrix placement — root children as columns, their children as aligned rows.

   Looks like the grid at a glance, but the defining property is different:
   row N means the same thing in every column, so rows share a height and line
   up horizontally. That alignment is what makes a matrix readable as a table,
   and it is why this cannot be the grid with different numbers — the grid
   sizes each column independently.

   Anything below the second level is stacked inside its cell.
   ------------------------------------------------------------ */
function layoutMatrix(nodes, rootId, kidsOf, opts){
  const colGap = opts.colGap != null ? opts.colGap : 40;
  const rowGap = opts.rowGap != null ? opts.rowGap : 24;
  const cellGap = opts.cellGap != null ? opts.cellGap : 10;   // between stacked descendants
  const headGap = opts.headGap != null ? opts.headGap : 60;   // root to the header row

  const cols = kidsOf(rootId);
  // Everything under a cell, flattened — the matrix aligns rows, so a deep
  // branch stacks within its cell rather than spawning new columns.
  const stackOf = (id, out) => {
    out.push(id);
    if(!nodes[id].collapsed) kidsOf(id).forEach(c => stackOf(c, out));
    return out;
  };
  const cellsFor = colId => (nodes[colId].collapsed ? [] : kidsOf(colId))
    .map(rowId => stackOf(rowId, []));

  const grid = cols.map(cellsFor);
  const rowCount = grid.reduce((m, cells) => Math.max(m, cells.length), 0);

  // Uniform column widths and — the point of a matrix — uniform row heights.
  const colW = cols.map((colId, c) => {
    let w = nodes[colId].w || 120;
    grid[c].forEach(stack => stack.forEach(id => { w = Math.max(w, nodes[id].w || 120); }));
    return w;
  });
  const rowH = [];
  for(let r = 0; r < rowCount; r++){
    let h = 0;
    grid.forEach(cells => {
      const stack = cells[r];
      if(!stack) return;
      let sh = 0;
      stack.forEach((id, i) => { sh += (nodes[id].h || 40) + (i ? cellGap : 0); });
      h = Math.max(h, sh);
    });
    rowH[r] = h;
  }

  const colX = []; let x = 0;
  colW.forEach((w, i) => { colX[i] = x; x += w + colGap; });
  const totalW = x > 0 ? x - colGap : 0;

  const root = nodes[rootId];
  root.side = 'root';
  root.x = totalW / 2 - (root.w || 120) / 2;
  root.y = 0;

  const headY = (root.h || 40) + headGap;
  const rowY = []; let y = headY + (cols.length ? Math.max(...cols.map(id => nodes[id].h || 40)) + rowGap : 0);
  rowH.forEach((h, i) => { rowY[i] = y; y += h + rowGap; });

  cols.forEach((colId, c) => {
    const head = nodes[colId];
    head.side = 'down';
    head.x = colX[c]; head.y = headY;
    grid[c].forEach((stack, r) => {
      let cy = rowY[r];
      stack.forEach(id => {
        const n = nodes[id];
        n.side = 'down';
        n.x = colX[c]; n.y = cy;
        cy += (n.h || 40) + cellGap;
      });
    });
  });
}

/* ------------------------------------------------------------
   Grid placement — root children as cards in a grid, each with its
   sub-tree as an indented outline beneath it.

   Useful when the root's children are peers to be compared rather than a
   hierarchy to be traced: a board of topics rather than a branching map.
   ------------------------------------------------------------ */
function layoutGrid(nodes, rootId, kidsOf, opts){
  const cols   = Math.max(1, opts.columns != null ? opts.columns : 3);
  const gapX   = opts.gapX   != null ? opts.gapX   : 60;   // between columns
  const gapY   = opts.gapY   != null ? opts.gapY   : 60;   // between rows
  const rowGap = opts.rowGap != null ? opts.rowGap : 14;   // between outline rows
  const indent = opts.indent != null ? opts.indent : 24;   // per outline level

  // Flatten a sub-tree into indented rows, and measure the block it needs.
  const rowsOf = (id, depth, out) => {
    const n = nodes[id];
    out.push({ id, depth });
    if(n.collapsed) return out;
    kidsOf(id).forEach(c => rowsOf(c, depth + 1, out));
    return out;
  };
  const blockSize = rows => {
    let w = 0, h = 0;
    rows.forEach((r, i) => {
      const n = nodes[r.id];
      w = Math.max(w, r.depth * indent + (n.w || 120));
      h += (n.h || 40) + (i ? rowGap : 0);
    });
    return { w, h };
  };

  const kids = kidsOf(rootId);
  const cells = kids.map(id => {
    const rows = rowsOf(id, 0, []);
    return { id, rows, size: blockSize(rows) };
  });

  // Uniform column widths and per-row heights keep the grid readable.
  const colW = [];
  cells.forEach((c, i) => {
    const col = i % cols;
    colW[col] = Math.max(colW[col] || 0, c.size.w);
  });
  const rowH = [];
  cells.forEach((c, i) => {
    const row = Math.floor(i / cols);
    rowH[row] = Math.max(rowH[row] || 0, c.size.h);
  });
  const colX = [];
  let x = 0;
  for(let i = 0; i < colW.length; i++){ colX[i] = x; x += colW[i] + gapX; }
  const gridW = x > 0 ? x - gapX : 0;

  const root = nodes[rootId];
  root.side = 'root';
  root.x = gridW / 2 - (root.w || 120) / 2;      // centred above the grid
  root.y = 0;
  const top = (root.h || 40) + gapY;

  const rowY = [];
  let y = top;
  for(let i = 0; i < rowH.length; i++){ rowY[i] = y; y += rowH[i] + gapY; }

  cells.forEach((cell, i) => {
    const cx = colX[i % cols];
    let cy = rowY[Math.floor(i / cols)];
    cell.rows.forEach(r => {
      const n = nodes[r.id];
      n.x = cx + r.depth * indent;
      n.y = cy;
      n.side = 'down';
      cy += (n.h || 40) + rowGap;
    });
  });
}

// Named chain layouts, in the same spirit as TREE_LAYOUTS: the timeline is one
// set of parameters, not a special case. Verified against positions captured
// from the previous hand-written layoutTimeline — identical output for every
// shape and config in test/fixtures/chain-layout-golden.json.
const CHAIN_LAYOUTS = {
  timeline: { axis:'x', dir: 1 },
};
function chainLayoutOpts(name, cfg, hGap, vGap){
  const base = CHAIN_LAYOUTS[name];
  if(!base) return null;
  const t = validateLayoutConfig(cfg).timeline;
  return { ...base, gap:t.gap, stem:t.stem, indent:t.indent,
           alternate:t.alternate, start:t.start,
           gapMain:hGap, gapCross:vGap };
}

/* ------------------------------------------------------------
   Tree placement — one engine behind balanced / right / left / down.

   Those four are not four algorithms. They are the same recursive procedure
   with three parameters: which axis subtrees grow along, which direction, and
   whether the root splits its children between both directions. Writing them
   separately hid that, and meant a new variant (org-chart upward, logic chart
   with the root centred) needed new code rather than new numbers.

   The two axes are transposes of each other, so the code works in "main" and
   "cross" terms:
     axis 'x'  main = x (subtrees grow sideways), cross = y (siblings stack)
     axis 'y'  main = y (subtrees grow downward),  cross = x (siblings stack)

   Mutates x/y/side on the given nodes, like the other layout paths.
   ------------------------------------------------------------ */
function layoutTree(nodes, rootId, kidsOf, opts){
  const horiz = opts.axis !== 'y';
  const gapMain  = opts.gapMain,  gapCross = opts.gapCross;
  const mainSize  = n => horiz ? (n.w || 120) : (n.h || 40);
  const crossSize = n => horiz ? (n.h || 40)  : (n.w || 120);
  const setPos = (n, main, cross) => { if(horiz){ n.x = main; n.y = cross; } else { n.y = main; n.x = cross; } };
  const getMain = n => horiz ? n.x : n.y;

  // Cross-axis extent of a subtree: siblings stack along this axis, so it is
  // the sum of their extents, floored at the node's own size.
  const extent = id => {
    const n = nodes[id], cs = kidsOf(id);
    if(!cs.length || n.collapsed) return crossSize(n);
    let s = 0; cs.forEach((c,i)=>{ s += extent(c) + (i ? gapCross : 0); });
    return Math.max(crossSize(n), s);
  };
  // Place a node centred within its own subtree extent, then lay out children.
  const place = (id, main, crossTop, dir) => {
    const n = nodes[id];
    setPos(n, main, crossTop + (extent(id) - crossSize(n)) / 2);
    const cs = kidsOf(id);
    if(!cs.length || n.collapsed) return;
    let cross = crossTop;
    cs.forEach(c => {
      // Growing backwards positions by the CHILD's size, since coordinates are
      // top-left based; growing forwards positions past the parent's.
      const cm = dir > 0 ? getMain(n) + mainSize(n) + gapMain
                         : getMain(n) - mainSize(nodes[c]) - gapMain;
      place(c, cm, cross, dir);
      cross += extent(c) + gapCross;
    });
  };
  const assign = (id, side) => { nodes[id].side = side; kidsOf(id).forEach(c => assign(c, side)); };

  const root = nodes[rootId];
  root.side = 'root';
  const kids = kidsOf(rootId);

  // 'centered' runs the root through the placer, so it sits centred over its
  // children (org-chart). 'origin' pins it at 0,0 and balances each side's
  // block around its middle (mind-map).
  if(opts.rootAnchor === 'centered'){
    kids.forEach(k => assign(k, opts.sideName));
    place(rootId, 0, 0, opts.dir);
    return;
  }

  let backSet = [], fwdSet = [];
  if(opts.split === 'balanced'){
    // STABLE: keep whatever side each child already has so the map never
    // reshuffles on an unrelated edit; only new children (no side) are
    // assigned, to whichever side is lighter.
    kids.forEach(k => {
      const s = nodes[k].side;
      if(s === 'left') backSet.push(k); else if(s === 'right') fwdSet.push(k);
    });
    kids.forEach(k => {
      const s = nodes[k].side;
      if(s !== 'left' && s !== 'right'){
        if(fwdSet.length <= backSet.length){ fwdSet.push(k); nodes[k].side = 'right'; }
        else { backSet.push(k); nodes[k].side = 'left'; }
      }
    });
  } else if(opts.dir > 0){ fwdSet = kids.slice(); } else { backSet = kids.slice(); }

  fwdSet.forEach(k => assign(k, 'right'));
  backSet.forEach(k => assign(k, 'left'));

  root.x = 0; root.y = 0;
  const rootMid = (root.h || 50) / 2;   // 50, matching the original default here
  let fTop = -(fwdSet.reduce((s,k,i)=> s + extent(k) + (i ? gapCross : 0), 0)) / 2 + rootMid;
  fwdSet.forEach(k => { const e = extent(k); place(k, root.x + (root.w || 120) + gapMain, fTop, 1); fTop += e + gapCross; });
  let bTop = -(backSet.reduce((s,k,i)=> s + extent(k) + (i ? gapCross : 0), 0)) / 2 + rootMid;
  backSet.forEach(k => { const e = extent(k); place(k, root.x - (nodes[k].w || 120) - gapMain, bTop, -1); bTop += e + gapCross; });
}

// The parameters that reproduce each named layout. Verified against positions
// captured from the previous hand-written implementations: identical output for
// every shape/layout combination in test/fixtures/tree-layout-golden.json.
//
// Note the gap swap on the vertical axis: with subtrees growing downward, hGap
// separates SIBLINGS (cross axis) and vGap separates GENERATIONS (main axis) —
// the reverse of the horizontal layouts. Getting this backwards is the one
// mistake this table exists to prevent.
const TREE_LAYOUTS = {
  balanced: { axis:'x', dir: 1, split:'balanced', rootAnchor:'origin' },
  right:    { axis:'x', dir: 1, split:'one-side', rootAnchor:'origin' },
  left:     { axis:'x', dir:-1, split:'one-side', rootAnchor:'origin' },
  down:     { axis:'y', dir: 1, split:'one-side', rootAnchor:'centered', sideName:'down' },
};
function treeLayoutOpts(name, hGap, vGap){
  const base = TREE_LAYOUTS[name];
  if(!base) return null;
  return base.axis === 'y'
    ? { ...base, gapMain: vGap, gapCross: hGap }
    : { ...base, gapMain: hGap, gapCross: vGap };
}

function autoLayout(noRender, opts){
  if(!map) return;
  const _prevCI=_ci; _ci=buildChildIndex();   // O(1) childrenOf for the whole layout
  // Snapshot current positions before anything below moves them — used to FLIP-animate
  // into the new layout once it's rendered (see flipAnimateNodes), so "tidy layout" and
  // "collapse/expand all" ease into place instead of jumping. render() clears and rebuilds
  // node DOM elements from scratch, so a plain CSS left/top transition can't apply here —
  // this replays the movement manually via a transform on the fresh elements instead.
  const _beforePos={}; for(const id in map.nodes){ const n=map.nodes[id]; _beforePos[id]={x:n.x,y:n.y}; }
  try{
  // Render-to-measure only if some visible node has no measured size yet (e.g.
  // it was just revealed by expanding). This avoids a full extra render on every
  // collapse/expand — the single biggest cost when expanding a large branch.
  const _hid=hiddenSet(); let _needMeasure=false;
  for(const id in map.nodes){ if(!_hid.has(id) && !(map.nodes[id].w>0)){ _needMeasure=true; break; } }
  if(!noRender && _needMeasure) render();
  const root=map.nodes[map.rootId];
  root.side='root';
  const layout = map.layout || 'balanced';
  // Spacing comes from this map's config. Local names, so the module constants
  // stay the defaults and other callers (drag-insertion, FLIP) are unaffected.

  // ----- PLACEMENT -----
  // One dispatch for every layout: resolve to a strategy plus a complete
  // parameter set, then run it. Adding a layout is now a table entry rather
  // than another branch here.
  const _run = resolveLayout(layout, map.layoutParams);
  const _p = { ..._run.params };
  // The per-map spacing config still applies on top, so the settings dialog
  // keeps working for the built-ins.
  const _cfg = validateLayoutConfig(map.layoutConfig)[layout];
  if(_cfg){
    if(_cfg.hGap != null && _run.strategy === 'tree'){
      if(_p.axis === 'y'){ _p.gapCross = _cfg.hGap; _p.gapMain = _cfg.vGap; }
      else { _p.gapMain = _cfg.hGap; _p.gapCross = _cfg.vGap; }
    }
    for(const k of ['gap','stem','indent','alternate','start','ring','startAngle','sweep',
                    'columns','gapX','gapY','rowGap']){
      if(_cfg[k] !== undefined) _p[k] = _cfg[k];
    }
  }
  const _place=()=>{
    ({ tree: layoutTree, chain: layoutChain, radial: layoutRadial, grid: layoutGrid,
       matrix: layoutMatrix }[_run.strategy])
      (map.nodes, map.rootId, childrenOf, _p);
  };
  // Snapshot sizes used for this placement. render() remeasures from the DOM;
  // if a card grew (wrapping, font, zoom), place once more with the live size
  // so siblings are stacked from the real height, not a stale 40px default.
  const _sized={};
  for(const id in map.nodes){ const n=map.nodes[id]; _sized[id]={w:n.w||0,h:n.h||0}; }
  _place();
  if(!noRender){
    render();
    if(layoutSizesGrew(_sized, map.nodes, hiddenSet())){
      _place();
      render();
    }
    if(!(opts && opts.persist===false)) scheduleSave();
    flipAnimateNodes(_beforePos);
  }
  } finally { _ci=_prevCI; }
}

// --- Live re-layout while editing -------------------------------------------
// Move EXISTING node elements to freshly-computed positions and redraw the
// connectors WITHOUT rebuilding the DOM, so the node being edited keeps its
// caret/selection intact.
function paintPositions(hidden){
  hidden = hidden || hiddenSet();
  document.querySelectorAll('.node').forEach(el=>{
    const n=map.nodes[el.dataset.id];
    if(n){ el.style.left=n.x+'px'; el.style.top=n.y+'px'; }
  });
  drawEdges(hidden);
  repositionNodeBar();
  // Nodes shifted into view by the live relayout must stop being culled.
  cullOffscreenNodes();
}
// Re-measure the node being edited, recompute the tidy layout, and paint it.
// Keeps the map neat as the node grows while typing (the way GitMind reflows).
function relayoutDuringEdit(id){
  if(!map) return;
  const el=document.querySelector(`.node[data-id="${id}"]`);
  if(!el) return;
  const n=map.nodes[id]; if(!n) return;
  const k=view.k||1;
  if(_editFloat){
    const maxPx=typeof nodeEditMaxWidthPx==='function' ? nodeEditMaxWidthPx(el, n) : (n.width||240);
    n.w=Math.min(_editFloat.offsetWidth/k, maxPx);
    n.h=_editFloat.offsetHeight/k;
  } else {
    const sz=k*_uiZ();
    const r=el.getBoundingClientRect();
    n.w=r.width/sz; n.h=r.height/sz;
  }
  autoLayout(true);   // positions only — no DOM rebuild
  paintPositions();   // shift existing elements + redraw edges
  placeEditFloat(el);
}

/* ============================================================
   NODE OPERATIONS
   ============================================================ */
/* ---- Markdown mode: edit the map as text with a live two-way preview (v1) ---- */
let mdMode=false, _mdSyncing=false, _mdTimer=0, _mdLines=[], _mdSelSync=false, _mdActiveLine=0, mdPreview=false, mdWrap=false;
let _mdPosCache={pos:-1, line:0}, _mdSelRAF=0, _mdComposing=false;
function mdInvalidatePosCache(){
  _mdPosCache={pos:-1, line:0};
}
function mdPlain(el){
  el=el||document.getElementById('mdEditor');
  if(!el) return '';
  if(el.tagName==='TEXTAREA' || el.tagName==='INPUT') return el.value||'';
  let t='';
  const walk=n=>{
    if(!n) return;
    if(n.nodeType===3){ t+=n.nodeValue; return; }
    if(n.nodeType!==1) return;
    if(n!==el && n.getAttribute && n.getAttribute('contenteditable')==='false') return;
    for(let c=n.firstChild;c;c=c.nextSibling) walk(c);
  };
  walk(el);
  return t;
}
function mdGetSel(el){
  el=el||document.getElementById('mdEditor');
  if(!el) return {s:0,e:0};
  const dragging=_mdSelection && _mdSelection.range();
  if(dragging) return dragging;
  if(el.tagName==='TEXTAREA' || el.tagName==='INPUT') return {s:el.selectionStart|0, e:el.selectionEnd|0};
  const sel=typeof window!=='undefined' && window.getSelection && window.getSelection();
  if(!sel || !sel.rangeCount) return {s:0,e:0};
  const r=sel.getRangeAt(0);
  if(!el.contains(r.startContainer) && r.startContainer!==el) return {s:0,e:0};
  const index=mdSelectionIndex(el);
  const s=index.offset(r.startContainer,r.startOffset);
  const e=index.offset(r.endContainer,r.endOffset);
  return {s:s==null ? 0 : s,e:e==null ? (s||0) : e};
}
function mdNodeAt(el, position){
  const point=mdSelectionIndex(el).point(position);
  return {node:point.node,off:point.offset};
}
function mdSetSel(el, s, e){
  el=el||document.getElementById('mdEditor');
  if(!el) return;
  s=s|0; e=e|0;
  if(e<s){ const t=s; s=e; e=t; }
  if(el.tagName==='TEXTAREA' || el.tagName==='INPUT'){
    try{ el.selectionStart=s; el.selectionEnd=e; }catch(_){}
    return;
  }
  const index=mdSelectionIndex(el);
  const a=index.point(s), b=index.point(e);
  try{
    const r=document.createRange();
    r.setStart(a.node, a.offset);
    r.setEnd(b.node, b.offset);
    const sel=window.getSelection();
    sel.removeAllRanges();
    sel.addRange(r);
  }catch(_){}
}
function mdPaint(el, text, keepSel){
  el=el||document.getElementById('mdEditor');
  if(!el) return;
  if(keepSel==null) keepSel=true;
  const html=mdHighlight(text, _mdView);
  if(el._mdPaintedHTML===html) return;
  const sel=keepSel?mdGetSel(el):{s:0,e:0};
  mdClearDragSel();
  el.innerHTML=html;
  el._mdPaintedHTML=html;
  if(keepSel) mdSetSel(el, sel.s, sel.e);
}
function mdBindEditor(el){
  if(!el || el._mdBound) return el;
  el._mdBound=true;
  Object.defineProperty(el, 'value', {
    configurable:true,
    get(){ return mdPlain(el); },
    set(v){
      const text=String(v==null?'':v);
      if(mdPlain(el)===text && el.firstChild) return;
      mdPaint(el, text, true);
    }
  });
  Object.defineProperty(el, 'selectionStart', {
    configurable:true,
    get(){ return mdGetSel(el).s; },
    set(v){ const cur=mdGetSel(el); mdSetSel(el, v|0, cur.e); }
  });
  Object.defineProperty(el, 'selectionEnd', {
    configurable:true,
    get(){ return mdGetSel(el).e; },
    set(v){ const cur=mdGetSel(el); mdSetSel(el, cur.s, v|0); }
  });
  Object.defineProperty(el, 'readOnly', {
    configurable:true,
    get(){ return el.contentEditable==='false'; },
    set(v){ el.contentEditable = v ? 'false' : 'true'; }
  });
  el.setSelectionRange=function(a,b){ mdSetSel(el, a, b==null?a:b); };
  return el;
}
let _mdSelection=null;
function mdClearDragSel(){
  if(_mdSelection) _mdSelection.cancel();
}
function mdLineColFromPos(text, pos, cache){
  const s=String(text==null?'':text);
  let p=pos|0;
  if(p<0) p=0;
  if(p>s.length) p=s.length;
  let line=0;
  const cached=cache && typeof cache.pos==='number' && typeof cache.line==='number'
    && cache.pos>=0 && cache.pos<=s.length && cache.line>=0;
  if(cached && p>=cache.pos){
    line=cache.line;
    for(let i=cache.pos;i<p;i++) if(s.charCodeAt(i)===10) line++;
  } else if(cached){
    line=cache.line;
    for(let i=cache.pos-1;i>=p;i--) if(s.charCodeAt(i)===10) line--;
  } else {
    for(let i=0;i<p;i++) if(s.charCodeAt(i)===10) line++;
  }
  if(cache){ cache.pos=p; cache.line=line; }
  const lastNl=s.lastIndexOf('\n', p-1);
  const col=p-(lastNl+1);
  return {line, col};
}
// ---- Fold-aware text model ----
// `_mdFullText` is the ALWAYS-COMPLETE markdown (source of truth for parsing back into
// the map). `ed.value` only ever holds the *visible* subset of its lines — whatever's
// left after removing any folded ranges — and `_mdView` is the mapping between the two.
// Folds are stored as a Set of _mdFullText line indices (the anchor/parent line of each
// folded range); indices are kept in sync across edits in mdCommitVisibleEdit().
let _mdFullText='', _mdFolds=new Set(), _mdView=null, _mdPrevVisible='';
function applyMdPaneI18n(pane){
  pane = pane || document.getElementById('mdPane');
  if(!pane) return;
  const setTitle=(sel,key,fallback)=>{ const el=pane.querySelector(sel); if(el) el.title=rmsTr(key,fallback); };
  const ttl=pane.querySelector('.md-ttl'); if(ttl) ttl.textContent=rmsTr('idMarkdown','Markdown');
  setTitle('.md-pdf-btn','mdDownloadPdf','Download the rendered preview as a PDF');
  setTitle('.md-wrap-btn','mdWrap','Toggle word wrap');
  setTitle('.md-prev-btn','mdPreview','Toggle rendered preview');
  setTitle('.md-close','mdExit','Exit Markdown mode');
  setTitle('.md-resize','mdResize','Drag to resize');
  const setText=(sel,txt)=>{ const el=pane.querySelector(sel); if(el) el.textContent=txt; };
  setText('.md-pdf-btn', rmsTr('mdPdfBtn','Download PDF'));
  setText('.md-wrap-btn', rmsTr('mdWrapBtn','Wrap'));
  setText('.md-prev-btn', (typeof mdPreview!=='undefined' && mdPreview) ? rmsTr('mdEdit','Edit') : rmsTr('mdPreviewOn','Preview'));
  const ed=pane.querySelector('#mdEditor'); if(ed) ed.setAttribute('data-placeholder', rmsTr('mdPlaceholder','# Central idea\n- a branch\n  - a leaf'));
  const fmt={
    bold:'actBold', italic:'actItalic', strike:'actStrike', code:'inlineCode',
    h1:'heading1', h2:'heading2', h3:'heading3', quote:'blockquote',
    ul:'actUl', ol:'actOl', hr:'divider', link:'actHref', image:'actImage',
    codeblock:'codeBlock', table:'table'
  };
  const fb={bold:'Bold', italic:'Italic', strike:'Strikethrough', code:'Inline code', h1:'Heading 1', h2:'Heading 2', h3:'Heading 3', quote:'Blockquote', ul:'Bulleted list', ol:'Numbered list', hr:'Divider', link:'Hyperlink', image:'Image', codeblock:'Code block', table:'Table'};
  pane.querySelectorAll('.md-toolbar [data-fmt]').forEach(b=>{
    const k=b.dataset.fmt;
    if(fmt[k]) b.title=rmsTr(fmt[k], fb[k]);
  });
}
function ensureMdPane(){
  if(document.getElementById('mdPane')) return;
  const app=document.querySelector('.app'), stage=document.querySelector('.stage'); if(!app||!stage) return;
  const pane=document.createElement('div'); pane.id='mdPane';
  pane.innerHTML='<div class="md-head"><span class="md-ttl">Markdown</span><span class="md-pos"></span><button class="md-pdf-btn" title="Download the rendered preview as a PDF">Download PDF</button><button class="md-wrap-btn" title="Toggle word wrap">Wrap</button><button class="md-prev-btn" title="Toggle rendered preview">Preview</button><button class="md-close" title="Exit Markdown mode (Esc)">\u2715</button></div>'
    +'<div class="md-toolbar"><button data-fmt="bold" title="Bold"><b>B</b></button><button data-fmt="italic" title="Italic"><i>I</i></button><button data-fmt="strike" title="Strikethrough"><s>S</s></button><button data-fmt="code" title="Inline code">&lt;/&gt;</button><span class="md-sep"></span><button data-fmt="h1" title="Heading 1">H1</button><button data-fmt="h2" title="Heading 2">H2</button><button data-fmt="h3" title="Heading 3">H3</button><span class="md-sep"></span><button data-fmt="quote" title="Blockquote">\u275D</button><button data-fmt="ul" title="Bullet list">\u2022</button><button data-fmt="ol" title="Numbered list">1.</button><button data-fmt="hr" title="Divider">\u2014</button><span class="md-sep"></span><button data-fmt="link" title="Link">\uD83D\uDD17</button><button data-fmt="image" title="Image">\uD83D\uDDBC</button><button data-fmt="codeblock" title="Code block">\u2317</button><button data-fmt="table" title="Table">\u25A6</button></div><div class="md-body"><div class="md-code"><pre id="mdEditor" class="md-editor" contenteditable="true" spellcheck="false" role="textbox" aria-multiline="true" data-placeholder="# Central idea&#10;- a branch&#10;  - a leaf"></pre><div id="mdSelLayer" class="md-sel-layer" aria-hidden="true"></div><div class="md-prev" aria-hidden="true"></div></div></div>'
    +'<div class="md-resize" title="Drag to resize"></div>';
  app.insertBefore(pane, stage);
  document.body.classList.add('md-ready');
  applyMdPaneI18n(pane);
  pane.querySelector('.md-close').addEventListener('click',()=>toggleMdMode(false));
  pane.querySelector('.md-prev-btn').addEventListener('click', mdTogglePreview);
  pane.querySelector('.md-wrap-btn').addEventListener('click', mdToggleWrap);
  pane.querySelector('.md-pdf-btn').addEventListener('click', mdDownloadPdf);
  pane.querySelector('.md-toolbar').addEventListener('mousedown', e=>{ const b=e.target.closest('button[data-fmt]'); if(b){ e.preventDefault(); mdFormat(b.dataset.fmt); } });
  const ed=mdBindEditor(pane.querySelector('#mdEditor'));
  ed.addEventListener('compositionstart', ()=>{ _mdComposing=true; clearTimeout(_mdTimer); _mdTimer=0; });
  ed.addEventListener('compositionend', ()=>{ _mdComposing=false; markImeCompositionEnd(); delete ed._mdPaintedHTML; mdAfterEdit(); });
  ed.addEventListener('input', ()=>{ delete ed._mdPaintedHTML; if(!_mdComposing) mdAfterEdit(); });
  ed.addEventListener('paste', e=>{
    e.preventDefault();
    if(ed.readOnly) return;
    const t=(e.clipboardData && e.clipboardData.getData('text/plain'))||'';
    if(typeof insertFieldText==='function') insertFieldText(ed, t);
    else mdInsertText(t);
  });
  ed.addEventListener('keydown',e=>{
    if(_mdComposing || e.isComposing || e.keyCode===229) return;
    if(e.key==='Escape'){ e.preventDefault(); toggleMdMode(false); return; }
    if(ed.readOnly) return;
    if(isImeConfirmEnter(e)){ e.preventDefault(); return; }
    if((e.ctrlKey||e.metaKey) && !e.altKey){ const k=(e.key||'').toLowerCase();
      if(k==='z' && !e.shiftKey){ e.preventDefault(); performHistoryChord('undo'); return; }
      if(k==='y' || (k==='z' && e.shiftKey)){ e.preventDefault(); performHistoryChord('redo'); return; }
      if(k==='b'){ e.preventDefault(); mdFormat('bold'); return; }
      if(k==='i'){ e.preventDefault(); mdFormat('italic'); return; } }
    if(e.key==='Tab'){ e.preventDefault(); const a=ed.selectionStart,b=ed.selectionEnd; ed.value=ed.value.slice(0,a)+'  '+ed.value.slice(b); ed.selectionStart=ed.selectionEnd=a+2; mdAfterEdit(); }
    if(e.key==='Enter'){
      e.preventDefault();
      if(e.shiftKey || e.ctrlKey || e.metaKey || !mdHandleEnter(ed)) mdInsertText('\n');
      else mdAfterEdit();
    }
  });
  const syncNodeFromCaret=()=>{ if(_mdSelSync) return; const vline=mdLineColFromPos(ed.value, ed.selectionStart, _mdPosCache).line; const line=_mdView?_mdView.visLineToFull[vline]:vline; let id=null; for(let l=line;l>=0;l--){ if(_mdLines[l]){ id=_mdLines[l]; break; } } if(id && map.nodes[id]){ _mdSelSync=true; select(id); _mdSelSync=false; } };
  ed.addEventListener('click', ()=>{ mdUpdateActive(); syncNodeFromCaret(); });
  _mdSelection=createMarkdownSelection(ed, pane.querySelector('#mdSelLayer'), mdUpdateActive);
  document.addEventListener('mousedown', e=>{
    if(mdMode && !pane.contains(e.target)) flushMdEdits();
  }, true);
  document.addEventListener('selectionchange', ()=>{
    if(!mdMode || (_mdSelection && _mdSelection.active) || _mdComposing) return;
    if(document.activeElement!==document.getElementById('mdEditor')) return;
    if(_mdSelRAF) return;
    _mdSelRAF=requestAnimationFrame(()=>{ _mdSelRAF=0; mdUpdateActive(); });
  });
  ed.addEventListener('keyup', e=>{ mdUpdateActive(); if(e.key && e.key.indexOf('Arrow')===0) syncNodeFromCaret(); });
  const rz=pane.querySelector('.md-resize');
  rz.addEventListener('mousedown',e=>{ document.body.classList.add('md-resizing');
    e.preventDefault(); const x0=e.clientX, w0=pane.getBoundingClientRect().width;
    const mv=ev=>{ const w=Math.max(240, Math.min(window.innerWidth*0.72, w0+(ev.clientX-x0))); app.style.setProperty('--md-w', w+'px'); };
    const {w:SW0,h:SH0}=_stageSize();
    const cx0=(SW0/2-view.x)/view.k, cy0=(SH0/2-view.y)/view.k;
    const up=()=>{ window.removeEventListener('mousemove',mv); window.removeEventListener('mouseup',up); document.body.classList.remove('md-resizing');
      try{
        const {w:W1,h:H1}=_stageSize();
        if(isFinite(cx0)&&isFinite(cy0)&&W1>1&&H1>1) _reframeSmooth(cx0, cy0, W1, H1);
      }catch(_){}
      mdClearDragSel(); };
    window.addEventListener('mousemove',mv); window.addEventListener('mouseup',up);
  });
}
function syncTextFromMap(){
  clearTimeout(_mdTimer); _mdTimer=0;
  const ed=document.getElementById('mdEditor'); if(!ed) return;
  const oldLines=_mdLines, oldFolds=_mdFolds;   // remember before rebuilding, to carry fold state across the resync
  const newLines=[];
  _mdSyncing=true;
  try{ _mdFullText=buildMarkdown(undefined,{rich:true,meta:true,lineMap:newLines}); }catch(e){ _mdFullText=''; }
  _mdSyncing=false;
  _mdLines=newLines;
  // Carry folds over by node identity — a section folded before a canvas-side style
  // change (or any other resync) stays folded at that node's new line, instead of
  // silently popping back open on every edit.
  if(oldFolds.size){
    const nodeIdToNewLine=new Map();
    for(let i=0;i<newLines.length;i++){ if(newLines[i]!=null) nodeIdToNewLine.set(newLines[i], i); }
    const nextFolds=new Set();
    for(const oldLine of oldFolds){
      const id=oldLines[oldLine];
      if(id==null){
        // Not a node line — the mindspark meta comment (anchor line 0) is the one
        // expected case: it's always the very first line whenever present, so its own
        // fold carries straight across without a node-identity lookup.
        if(oldLine===0 && /^\uFEFF?\s*<!--\s*mindspark\b/i.test((_mdFullText.split('\n')[0])||'')) nextFolds.add(0);
        continue;
      }
      const newLine=nodeIdToNewLine.get(id);
      if(newLine!=null) nextFolds.add(newLine);
    }
    _mdFolds=nextFolds;
  } else {
    _mdFolds=new Set();
  }
  const view=mdBuildView(); _mdView=view;
  const vis=mdVisibleText(view);
  ed.value=vis; _mdPrevVisible=vis;
  mdRefreshDecorations();
  mdRenderPreviewIfActive();
}
function mdHighlightNode(id){   // node -> select + scroll its line in the editor
  const ed=document.getElementById('mdEditor'); if(!ed) return;
  let line=-1; for(const k in _mdLines){ if(_mdLines[k]===id){ line=+k; break; } }
  if(line<0) return;
  if(mdUnfoldAncestorsOf(line)) mdRefreshDecorations();   // reveal the line if it was hidden in a fold
  const vline=(_mdView&&_mdView.fullToVis[line]!=null) ? _mdView.fullToVis[line] : line;
  const arr=ed.value.split('\n'); let start=0; for(let i=0;i<vline;i++) start+=(arr[i]||'').length+1;
  try{ ed.setSelectionRange(start, start); }catch(e){}   // caret at line start (no whole-line selection)
  ed.scrollLeft=0;                                       // don't jump horizontally on open
  const point=mdNodeAt(ed,start), range=document.createRange();
  range.setStart(point.node,point.off); range.collapse(true);
  const caret=range.getBoundingClientRect(), box=ed.getBoundingClientRect();
  if(caret.height) ed.scrollTop=Math.max(0, ed.scrollTop+caret.top-box.top-ed.clientHeight/2);
  mdUpdateActive();
  // A browser can apply its own "scroll the caret into view" adjustment asynchronously —
  // a tick after the selection change above — which would silently reintroduce horizontal
  // scroll. Re-assert once more on the next frame to catch that.
  requestAnimationFrame(()=>{ ed.scrollLeft=0; });
}
// ---- Syntax coloring for the editable text ----
function _hlLine(raw){
  const esc=t=>t.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  let s=esc(raw);
  if(/^\s*([-*_])(\s*\1){2,}\s*$/.test(raw)) return '<span class="hl-hr">'+s+'</span>';                      // horizontal rule
  if(/^#{1,6}(\s|$)/.test(raw)) return s.replace(/^(#{1,6})([\s\S]*)$/, '<span class="hl-hmark">$1</span><span class="hl-head">$2</span>');
  if(/^\s*&gt;/.test(s)) return '<span class="hl-quote">'+s+'</span>';
  if(/^\s*\|.*\|/.test(s)) s=s.replace(/\|/g,'<span class="hl-punc">|</span>');
  s=s.replace(/^(\s*)([-*+]|\d+\.)(\s+)(\[[ xX]\]\s)?/, (m,a,b,c,t)=> a+'<span class="hl-bullet">'+b+'</span>'+c+(t?'<span class="hl-task">'+t.trim()+'</span> ':''));
  s=s.replace(/!\[[^\]]*\]\([^)]+\)/g, m=>'<span class="hl-img">'+m+'</span>');
  s=s.replace(/(^|[^!])(\[[^\]]+\]\([^)]+\))/g, (m,p,l)=>p+'<span class="hl-link">'+l+'</span>');
  s=s.replace(/`[^`]+`/g, m=>'<span class="hl-code-inline">'+m+'</span>');
  s=s.replace(/\*\*[^*]+\*\*/g, m=>'<span class="hl-strong">'+m+'</span>');
  s=s.replace(/~~[^~]+~~/g, m=>'<span class="hl-strike">'+m+'</span>');
  s=s.replace(/(^|[^*<])(\*[^*<]+\*)/g, (m,p,e)=>p+'<span class="hl-em">'+e+'</span>');
  s=s.replace(/(^|[\s(>])(__[^_]+__)(?=[\s).,;:!?<]|$)/g, (m,p,e)=>p+'<span class="hl-strong">'+e+'</span>');   // __bold__
  s=s.replace(/(^|[\s(>])(_[^_]+_)(?=[\s).,;:!?<]|$)/g, (m,p,e)=>p+'<span class="hl-em">'+e+'</span>');            // _italic_ (not snake_case)
  s=s.replace(/&lt;\/?[a-zA-Z][a-zA-Z0-9-]*(?:\s[^&]*?)?\/?&gt;/g, m=>'<span class="hl-tag">'+m+'</span>');    // raw HTML tags
  s=s.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, (m,p,u)=>p+'<span class="hl-url">'+u+'</span>');              // bare URLs
  return s;
}
function renderMdList(items, itemFn){
  const root={children:[],depth:-1}; const stack=[root];
  items.forEach(raw=>{ const ind=(raw.match(/^\s*/)||[''])[0].replace(/\t/g,'  ').length; const depth=Math.floor(ind/2); const ordered=/^\s*\d+\./.test(raw);
    const node={text:itemFn(raw),children:[],depth,ordered};
    while(stack.length>1 && stack[stack.length-1].depth>=depth) stack.pop();
    stack[stack.length-1].children.push(node); stack.push(node); });
  const emit=n=>{ if(!n.children.length) return ''; const tag=n.children[0].ordered?'ol':'ul';
    return '<'+tag+'>'+n.children.map(c=>'<li>'+c.text+emit(c)+'</li>').join('')+'</'+tag+'>'; };
  return emit(root);
}
// Display-only variant of mdInlineToHtml that also renders $...$ / $$...$$ LaTeX to MathML
// (via the existing dependency-free latexToMathML(), same one the canvas nodes use). Used by
// mdToHtml() for the Markdown preview and PDF export — NOT by the parser: node text must keep
// math as literal $...$ source (see htmlToInlineMd's comment) so it stays editable/round-trips.
function mdInlineToHtmlWithMath(txt, slotsOut){
  if(!txt || txt.indexOf('$')<0) return mdInlineToHtml(txt);
  const re=new RegExp(MATH_DELIM_RE.source,'g');
  const slots=slotsOut || [];
  const masked = txt.replace(re, (full,dd,inl)=>{
    const tex = dd!=null ? dd : inl, display = dd!=null;
    let mathml=null; try{ mathml=latexToMathML(tex, display); }catch(e){ mathml=null; }
    slots.push(mathml!=null ? mathml : escapeHtml(full));   // fall back to the raw text if it doesn't parse as LaTeX
    return '\uE000'+(slots.length-1)+'\uE001';               // PUA placeholder survives markdown/HTML processing untouched
  });
  if(slotsOut) return mdInlineToHtml(masked);   // caller substitutes after sanitizing (see mdToHtml)
  return mdInlineToHtml(masked).replace(/\uE000(\d+)\uE001/g, (m,idx)=> slots[+idx]!=null ? slots[+idx] : '');
}
function mdToHtml(md){
  let frontHtml='';
  // Strip a leading mindspark comment and/or YAML frontmatter block, in whichever order
  // they appear (loop, not two independent one-shot checks — same reasoning as
  // parseMarkdownOutline: an anchored check silently stops matching if the other block
  // ends up first, leaking raw "<!-- mindspark" / "---" text into the rendered preview).
  for(let guard=0; guard<4; guard++){
    const mm = md.match(/^\uFEFF?\s*<!--\s*mindspark[\s\S]*?-->\s*\n?/i);
    if(mm){ md=md.slice(mm[0].length); continue; }
    const fm = md.match(/^\s*---\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?/);
    if(fm){ frontHtml = frontmatterFieldsToHtml(parseFrontmatterFields(fm[0])); md=md.slice(fm[0].length); continue; }
    break;
  }
  const L=md.split('\n'); const out=frontHtml?[frontHtml]:[]; let i=0;
  const mathSlots=[];   // rendered MathML, spliced back in only after sanitizing (see end)
  const inl=x=>mdInlineToHtmlWithMath(x, mathSlots);
  const esc=x=>x.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const item=x=>inl(x.replace(/^\s*([-*+]|\d+\.)\s+/,'').replace(/^\[[ ]\]\s/,'\u2610 ').replace(/^\[[xX]\]\s/,'\u2611 '));
  const cells=r=>r.replace(/^\s*\|?/,'').replace(/\|?\s*$/,'').split('|').map(c=>c.trim());
  const tbl=rows=>'<table><thead><tr>'+cells(rows[0]).map(h=>'<th>'+inl(h)+'</th>').join('')+'</tr></thead><tbody>'+rows.slice(2).map(r=>'<tr>'+cells(r).map(c=>'<td>'+inl(c)+'</td>').join('')+'</tr>').join('')+'</tbody></table>';
  while(i<L.length){
    let line=L[i];
    if(!line.trim()){ i++; continue; }
    let fm=line.match(/^\s*(```+|~~~+)(.*)$/);
    if(fm){ const buf=[]; let j=i+1; while(j<L.length && !/^\s*(```+|~~~+)\s*$/.test(L[j])){ buf.push(L[j]); j++; } out.push('<pre class="mp-code"><code>'+esc(buf.join('\n'))+'</code></pre>'); i=j+1; continue; }
    let h=line.match(/^(#{1,6})\s+(.*)$/);
    if(h){ out.push('<h'+h[1].length+'>'+inl(h[2])+'</h'+h[1].length+'>'); i++; continue; }
    if(/^\s*([-*_])(?:[ \t]*\1){2,}[ \t]*$/.test(line)){ out.push('<hr>'); i++; continue; }
    if(/^\s*>/.test(line)){ const buf=[]; while(i<L.length && /^\s*>/.test(L[i])){ buf.push(L[i].replace(/^\s*>\s?/,'')); i++; } out.push('<blockquote>'+inl(buf.join('<br>'))+'</blockquote>'); continue; }
    if(line.includes('|') && i+1<L.length && /-/.test(L[i+1]) && /^[\s|:\-]+$/.test(L[i+1])){ const rows=[]; while(i<L.length && L[i].includes('|') && L[i].trim()){ rows.push(L[i]); i++; } out.push(tbl(rows)); continue; }
    if(/^\s*<(table|div|details|figure|section|img|hr|blockquote|p|h[1-6]|ul|ol)\b/i.test(line)){ const tm=line.match(/^\s*<([a-z0-9]+)/i), tag=tm?tm[1].toLowerCase():''; const buf=[line];
      const VOID=/^(img|hr|br|input|source|col|area|embed|track|wbr|link|meta)$/;
      if(tag && !VOID.test(tag) && !new RegExp('</'+tag+'>','i').test(line) && !/\/>\s*$/.test(line)){ let j=i+1, found=false; while(j<L.length){ buf.push(L[j]); if(new RegExp('</'+tag+'>','i').test(L[j])){ found=true; j++; break; } j++; } if(found){ i=j; } else { buf.length=1; i++; } } else i++;
      out.push(buf.join('\n').replace(/<\/?(script|style|iframe|object|embed|link|meta)\b[^>]*>/gi,'').replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi,'').replace(/\b(href|src)\s*=\s*("\s*javascript:[^"]*"|'\s*javascript:[^']*')/gi,'$1="#"')); continue; }
    let im=line.match(/^\s*!\[([^\]]*)\]\(([^)]+)\)\s*$/);
    if(im){ out.push('<img alt="'+esc(im[1])+'" src="'+esc(im[2])+'">'); i++; continue; }
    if(/^\s*([-*+]|\d+\.)\s+/.test(line)){ const items=[]; while(i<L.length && (/^\s*([-*+]|\d+\.)\s+/.test(L[i]) || (L[i].trim() && /^\s{2,}\S/.test(L[i])))){ items.push(L[i]); i++; } out.push(renderMdList(items,item)); continue; }
    const buf=[line]; i++; while(i<L.length && L[i].trim() && !/^\s*(#{1,6}\s|[-*+]\s|\d+\.\s|>|```|~~~|\||<)/.test(L[i])){ buf.push(L[i]); i++; }
    out.push('<p>'+inl(buf.join(' '))+'</p>');
  }
  // Final safety: whitelist-sanitize everything (raw HTML blocks included). A regex
  // blacklist missed unquoted handlers like <img/src=x/onerror=1>.
  return mdPreviewSanitize(out.join('\n'), mathSlots);
}
// Tags/attributes the Markdown preview and PDF may contain. Everything else is
// unwrapped or dropped by sanitizeInlineHTML; <img> keeps only a safe src.
const MD_PREVIEW_TAGS = ['h1','h2','h3','h4','h5','h6','blockquote','pre','code','hr','img',
  'table','thead','tbody','tr','th','td','details','summary','figure','figcaption'];
function mdPreviewSanitize(html, mathSlots){
  const safe = sanitizeInlineHTML(html, MD_PREVIEW_TAGS,
    { img:true, mailto:true, classes:/^mp-code$/, style:/^text-align$/i });
  if(!mathSlots || !mathSlots.length || safe.indexOf('\uE000')<0) return safe;
  // Math placeholders (\uE000n\uE001) survive sanitizing as plain text. Swap them for
  // the MathML built by latexToMathML (every literal escaped there), but only inside
  // text nodes, never inside an attribute value.
  const PH=/\uE000(\d+)\uE001/g;
  const tpl=document.createElement('template'); tpl.innerHTML=safe;
  const walk=node=>{
    [...node.childNodes].forEach(ch=>{
      if(ch.nodeType===3){
        const v=ch.nodeValue||''; if(v.indexOf('\uE000')<0) return;
        const parts=v.split(/\uE000(\d+)\uE001/);
        const htmlPart=parts.map((p,k)=> k%2 ? (mathSlots[+p]!=null ? mathSlots[+p] : '') : escapeHtml(p)).join('');
        const t2=document.createElement('template'); t2.innerHTML=htmlPart;
        node.insertBefore(t2.content, ch); node.removeChild(ch);
      } else if(ch.nodeType===1){
        [...ch.attributes].forEach(at=>{ if(at.value.indexOf('\uE000')>=0) ch.setAttribute(at.name, at.value.replace(PH,'')); });
        walk(ch);
      }
    });
  };
  walk(tpl.content);
  const outEl=document.createElement('div'); outEl.appendChild(tpl.content);
  return outEl.innerHTML;
}
function mdWrapSel(before, after){ const ed=document.getElementById('mdEditor'); if(!ed) return; const s=ed.selectionStart,e=ed.selectionEnd,sel=ed.value.slice(s,e);
  ed.value=ed.value.slice(0,s)+before+sel+after+ed.value.slice(e);
  if(s===e){ ed.selectionStart=ed.selectionEnd=s+before.length; } else { ed.selectionStart=s+before.length; ed.selectionEnd=e+before.length; }
  ed.focus(); mdAfterEdit(); }
function mdLinePrefix(pfx){ const ed=document.getElementById('mdEditor'); if(!ed) return; const s=ed.selectionStart,e=ed.selectionEnd; const ls=ed.value.lastIndexOf('\n',s-1)+1;
  const block=ed.value.slice(ls,Math.max(e,ls)); const out=block.split('\n').map(l=>pfx+l).join('\n');
  ed.value=ed.value.slice(0,ls)+out+ed.value.slice(Math.max(e,ls)); ed.selectionStart=ls; ed.selectionEnd=ls+out.length; ed.focus(); mdAfterEdit(); }
function mdLineToggle(pfx){ const ed=document.getElementById('mdEditor'); if(!ed) return; const s=ed.selectionStart; const ls=ed.value.lastIndexOf('\n',s-1)+1; let le=ed.value.indexOf('\n',ls); if(le<0) le=ed.value.length;
  let line=ed.value.slice(ls,le).replace(/^#{1,6}\s+/,''); const nl=pfx+line; ed.value=ed.value.slice(0,ls)+nl+ed.value.slice(le); ed.selectionStart=ed.selectionEnd=ls+nl.length; ed.focus(); mdAfterEdit(); }
function mdInsertText(text, caret){ const ed=document.getElementById('mdEditor'); if(!ed||ed.readOnly) return; const s=ed.selectionStart; ed.value=ed.value.slice(0,s)+text+ed.value.slice(ed.selectionEnd); const pos=s+(caret!=null?caret:text.length); ed.selectionStart=ed.selectionEnd=pos; ed.focus(); mdAfterEdit(); }
function mdFormat(a){ const ed=document.getElementById('mdEditor'); if(!ed||ed.readOnly) return;
  switch(a){
    case 'bold': mdWrapSel('**','**'); break;
    case 'italic': mdWrapSel('*','*'); break;
    case 'strike': mdWrapSel('~~','~~'); break;
    case 'code': mdWrapSel('`','`'); break;
    case 'h1': mdLineToggle('# '); break;
    case 'h2': mdLineToggle('## '); break;
    case 'h3': mdLineToggle('### '); break;
    case 'quote': mdLinePrefix('> '); break;
    case 'ul': mdLinePrefix('- '); break;
    case 'ol': mdLinePrefix('1. '); break;
    case 'hr': mdInsertText('\n\n---\n\n'); break;
    case 'link': mdWrapSel('[','](url)'); break;
    case 'image': mdInsertText('![alt](url)', 2); break;
    case 'codeblock': mdInsertText('\n```\n\n```\n', 5); break;
    case 'table': mdInsertText('\n| Column A | Column B |\n| --- | --- |\n| Cell 1 | Cell 2 |\n'); break;
  }
}
// Smart Enter: continue lists/quotes onto the next line the way markmap-repl's CodeMirror
// editor does, and auto-close a fenced code block right after its opening fence. Returns
// true if it handled the keypress (caller must preventDefault + commit); false lets the
// browser's default Enter behaviour run (plain paragraph text, or a selection replace).
function mdHandleEnter(ed){
  if(ed.readOnly) return false;
  if(ed.selectionStart!==ed.selectionEnd) return false;   // let default Enter replace a real selection
  const val=ed.value, pos=ed.selectionStart;
  const lineStart=val.lastIndexOf('\n', pos-1)+1;
  let lineEnd=val.indexOf('\n', pos); if(lineEnd<0) lineEnd=val.length;
  const line=val.slice(lineStart, pos);           // current line's text up to the caret
  const fullLine=val.slice(lineStart, lineEnd);    // whole current line (fence detection needs the full line)
  const atLineEnd=pos>=lineEnd;
  const insertAt=(text,caretOffset)=>{ ed.value=val.slice(0,pos)+text+val.slice(pos); ed.selectionStart=ed.selectionEnd=pos+(caretOffset!=null?caretOffset:text.length); };
  const replaceLine=(text,caretOffset)=>{ ed.value=val.slice(0,lineStart)+text+val.slice(lineEnd); ed.selectionStart=ed.selectionEnd=lineStart+(caretOffset!=null?caretOffset:text.length); };

  // Are we currently inside a fenced code block? Count fence lines strictly above this one.
  const before=val.slice(0, lineStart);
  const fenceCount=(before.match(/^[ \t]*(`{3,}|~{3,})/gm)||[]).length;
  const inFence=fenceCount%2===1;

  if(!inFence){
    const fenceOpen=fullLine.match(/^(\s*)(`{3,}|~{3,})(\S*)\s*$/);
    if(fenceOpen && atLineEnd){
      const indent=fenceOpen[1], marker=fenceOpen[2];
      insertAt('\n'+indent+'\n'+indent+marker, 1+indent.length);
      return true;
    }
  }
  if(inFence){
    const indent=(fullLine.match(/^\s*/)||[''])[0];   // just keep code indentation, no list logic inside a fence
    insertAt('\n'+indent);
    return true;
  }

  const task=line.match(/^(\s*)([-*+])(\s+)(\[[ xX]\]\s+)(.*)$/);
  if(task){
    const [, indent, bullet, gap, , body]=task;
    if(!body.trim() && atLineEnd){ replaceLine(''); return true; }   // empty item -> exit the list
    insertAt('\n'+indent+bullet+gap+'[ ] ');
    return true;
  }
  const ul=line.match(/^(\s*)([-*+])(\s+)(.*)$/);
  if(ul){
    const [, indent, bullet, gap, body]=ul;
    if(!body.trim() && atLineEnd){ replaceLine(''); return true; }
    insertAt('\n'+indent+bullet+gap);
    return true;
  }
  const ol=line.match(/^(\s*)(\d+)([.)])(\s+)(.*)$/);
  if(ol){
    const [, indent, num, sep, gap, body]=ol;
    if(!body.trim() && atLineEnd){ replaceLine(''); return true; }
    insertAt('\n'+indent+(parseInt(num,10)+1)+sep+gap);
    return true;
  }
  const bq=line.match(/^(\s*(?:>\s?)+)(.*)$/);
  if(bq && bq[1].trim()){
    const [, prefix, body]=bq;
    if(!body.trim() && atLineEnd){ replaceLine(''); return true; }
    insertAt('\n'+prefix);
    return true;
  }
  return false;
}
function mdRenderPreviewIfActive(){
  if(!mdPreview) return;
  const pane=document.getElementById('mdPane'); if(!pane) return;
  const prev=pane.querySelector('.md-prev'); if(prev) prev.innerHTML=mdToHtml(_mdFullText);   // full text: preview isn't affected by folds
}
function mdTogglePreview(){
  mdPreview=!mdPreview;
  const pane=document.getElementById('mdPane'); if(!pane) return;
  pane.classList.toggle('md-preview', mdPreview);
  const btn=pane.querySelector('.md-prev-btn'); if(btn){ btn.classList.toggle('on', mdPreview); btn.textContent=mdPreview?rmsTr('mdEdit','Edit'):rmsTr('mdPreviewOn','Preview'); }
  if(mdPreview) mdRenderPreviewIfActive();
  else mdRefreshDecorations();   // gutter/highlight were display:none while previewing — re-sync now that they're visible again, rather than trusting whatever was last written while hidden
}
// The editor's own layout supplies wrapped caret and selection geometry.
function mdToggleWrap(){
  mdWrap=!mdWrap;
  const pane=document.getElementById('mdPane'); if(!pane) return;
  pane.classList.toggle('md-wrap', mdWrap);
  const btn=pane.querySelector('.md-wrap-btn'); if(btn) btn.classList.toggle('on', mdWrap);
  mdClearDragSel();
}
// "Download PDF": renders the full markdown into a dedicated print-only container and
// hands off to the browser's native print dialog (Save as PDF works everywhere without
// pulling in a PDF-generation library, keeping this a zero-dependency app). Print-specific
// CSS (see styles.css) hides the rest of the app and forces light, ink-friendly colors
// regardless of the active theme.
function mdDownloadPdf(){
  if(!map) return;
  let root=document.getElementById('mdPrintRoot');
  if(!root){ root=document.createElement('div'); root.id='mdPrintRoot'; document.body.appendChild(root); }
  // No separate title heading here — the root/center node's own text is already the
  // document's first H1 (via buildMarkdown -> mdToHtml), so adding map.title on top of
  // that would just duplicate or mismatch it. The center node itself is never touched.
  root.innerHTML=mdToHtml(_mdFullText);   // full text: PDF export isn't affected by folds
  const oldTitle=document.title;
  const suggestedName=(map.title||'mindmap').replace(/[\\/:*?"<>|]/g,'').trim()||'mindmap';
  document.title=suggestedName;   // browsers use this as the suggested "Save as PDF" filename
  document.body.classList.add('md-printing');
  let cleaned=false;
  const cleanup=()=>{
    if(cleaned) return; cleaned=true;
    document.body.classList.remove('md-printing');
    document.title=oldTitle;
    window.removeEventListener('afterprint', cleanup);
  };
  window.addEventListener('afterprint', cleanup);
  setTimeout(()=>{ window.print(); setTimeout(cleanup, 1000); }, 30);   // tiny delay lets the print layout settle first
}
// ---- Folding: outline depth per line, independent of the full parser ----
// Mirrors parseMarkdownOutline()'s nesting rules (heading level; bullet indent relative
// to the nearest heading/lead-in paragraph; fenced code + GFM tables as one atomic unit)
// closely enough that a fold's boundary always matches a node's subtree, without needing
// a full parse on every keystroke. Lines that aren't a heading/bullet/block-owner (blank
// lines, blockquote/notes lines, plain paragraph continuations) get `null`: they're not
// fold anchors themselves, they just fold away together with whatever anchor precedes them.
function mdLineDepths(text){
  const L=text.split('\n');
  const depth=new Array(L.length).fill(null);
  let lastHeadingDepth=0, subDepth=null;
  const base=()=>(subDepth!=null?subDepth:lastHeadingDepth);
  const nextIsBullet=from=>{ for(let k=from+1;k<L.length;k++){ if(!L[k].trim()) continue; return /^\s*(?:[-*+]|\d+\.)\s+/.test(L[k]); } return false; };
  for(let i=0;i<L.length;i++){
    const line=L[i];
    const fence=line.match(/^(\s*)(`{3,}|~{3,})/);
    if(fence){
      const ind=fence[1], fch=fence[2][0], flen=fence[2].length;
      depth[i]=base()+1+Math.floor(ind.length/2);
      let j=i+1; while(j<L.length){ const cl=L[j].match(/^\s*(`{3,}|~{3,})\s*$/); if(cl && cl[1][0]===fch && cl[1].length>=flen) break; j++; }
      i=j; continue;
    }
    if(line.includes('|') && line.trim() && i+1<L.length && L[i+1].includes('|') && /-/.test(L[i+1]) && /^[\s|:-]+$/.test(L[i+1])){
      const ind=(line.match(/^\s*/)||[''])[0].length;
      depth[i]=base()+1+Math.floor(ind/2);
      let j=i+2; while(j<L.length && L[j].includes('|') && L[j].trim()) j++;
      i=j-1; continue;
    }
    if(!line.trim()) continue;
    const h=line.match(/^(#{1,6})\s+/);
    if(h){ lastHeadingDepth=h[1].length; subDepth=null; depth[i]=lastHeadingDepth; continue; }
    if(/^\s*>/.test(line)) continue;   // blockquote/notes line: attaches to its owner
    if(/^\s*<img\b/i.test(line)) continue;   // embedded-image line: attaches to its owner, same as a blockquote — never its own fold level (see mdFoldRange)
    const bullet=line.match(/^(\s*)(?:[-*+]|\d+\.)\s+/);
    if(bullet){ const indent=bullet[1].replace(/\t/g,'  ').length; depth[i]=base()+1+Math.floor(indent/2); continue; }
    if(nextIsBullet(i)){ depth[i]=lastHeadingDepth+1; subDepth=lastHeadingDepth+1; continue; }   // lead-in paragraph above a list
  }
  return depth;
}
function mdFoldRange(depths, anchor){   // [start,end) of lines nested under `anchor`, or null if nothing to fold
  const d=depths[anchor]; if(d==null) return null;
  for(let j=anchor+1;j<depths.length;j++){ if(depths[j]!=null && depths[j]<=d) return j>anchor+1 ? [anchor+1,j] : null; }
  return depths.length>anchor+1 ? [anchor+1, depths.length] : null;
}
// Builds the mapping between the full (authoritative) text and the visible (folded) text
// that actually lives in the textarea. Cached on _mdView after every render.
function mdBuildView(){
  const fullLines=_mdFullText.split('\n');
  const depths=mdLineDepths(_mdFullText);
  const allRanges=new Map();
  for(let i=0;i<depths.length;i++){ if(depths[i]!=null){ const r=mdFoldRange(depths,i); if(r) allRanges.set(i,r); } }
  // The mindspark meta comment, when present, is always the very first line(s) — it sits
  // outside the document's outline entirely, so its body (the JSON line + closing "-->")
  // can't be found via the depth-based sibling/ancestor search above. Detect its span
  // directly instead, so its opening line gets a fold toggle like any other line would.
  if(/^\uFEFF?\s*<!--\s*mindspark\b/i.test(fullLines[0]||'')){
    for(let j=1;j<fullLines.length;j++){
      if(/-->/.test(fullLines[j])){
        let end=j+1;
        if(fullLines[end]!=null && fullLines[end].trim()==='') end++;   // fold the blank spacer line after --> too, if present
        if(end>1) allRanges.set(0, [1, end]);
        break;
      }
    }
  }
  const hidden=new Set(), foldInfo=new Map();
  for(const a of _mdFolds){
    const r=allRanges.get(a); if(!r) continue;
    for(let k=r[0];k<r[1];k++) hidden.add(k);
    foldInfo.set(a, {start:r[0], end:r[1], count:r[1]-r[0]});
  }
  const visLineToFull=[], fullToVis=new Array(fullLines.length).fill(-1);
  for(let i=0;i<fullLines.length;i++){ if(hidden.has(i)) continue; fullToVis[i]=visLineToFull.length; visLineToFull.push(i); }
  return { fullLines, depths, allRanges, hidden, foldInfo, visLineToFull, fullToVis };
}
function mdVisibleText(view){ return view.visLineToFull.map(i=>view.fullLines[i]).join('\n'); }
// Reveals every fold that hides `fullLineIdx`. Returns true if anything changed.
function mdUnfoldAncestorsOf(fullLineIdx){
  const view=_mdView||mdBuildView(); let changed=false;
  for(const [a,info] of view.foldInfo){ if(fullLineIdx>=info.start && fullLineIdx<info.end){ _mdFolds.delete(a); changed=true; } }
  return changed;
}
function mdToggleFold(fullLineIdx){
  const ed=document.getElementById('mdEditor'); if(!ed) return;
  if(_mdFolds.has(fullLineIdx)) _mdFolds.delete(fullLineIdx); else _mdFolds.add(fullLineIdx);
  const view=mdBuildView(); _mdView=view;
  const vis=mdVisibleText(view);
  ed.value=vis; _mdPrevVisible=vis;
  const vline=view.fullToVis[fullLineIdx];
  if(vline!=null && vline>=0){
    const arr=vis.split('\n'); let start=0; for(let i=0;i<vline;i++) start+=(arr[i]||'').length+1;
    try{ ed.setSelectionRange(start,start); }catch(e){}
  }
  mdRefreshDecorations();
  ed.focus();
}
function mdHighlight(text, view){
  const esc=t=>t.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const lines=text.split('\n'); let inFence=false, inComment=false; const parts=[];
  for(let i=0;i<lines.length;i++){
    const raw=lines[i]; let html;
    if(inComment){ html='<span class="hl-comment">'+esc(raw)+'</span>'; if(/--&gt;|-->/.test(raw)) inComment=false; }
    else if(/^\s*<!--/.test(raw)){ inComment=!/-->/.test(raw); html='<span class="hl-comment">'+esc(raw)+'</span>'; }
    else if(inFence){ html='<span class="hl-code">'+esc(raw)+'</span>'; if(/^\s*(```+|~~~+)\s*$/.test(raw)) inFence=false; }
    else if(/^\s*(```+|~~~+)/.test(raw)){ inFence=true; html='<span class="hl-fence">'+esc(raw)+'</span>'; }
    else html=_hlLine(raw);
    if(view){
      const fi=view.visLineToFull[i];
      const info=fi!=null ? view.foldInfo.get(fi) : null;
      if(info){
        html='<span data-fold="'+info.count+'">'+(html||'')+'</span>';
        // The lines this fold hides might contain whatever would have closed an
        // in-progress comment/fence (opened on this line, or already open before it) —
        // scan them via the full text (without rendering them) so that state resolves
        // correctly instead of leaking into the still-visible lines after the fold.
        if(inComment || inFence){
          for(let k=info.start; k<info.end && (inComment||inFence); k++){
            const hraw=view.fullLines[k];
            if(inComment){ if(/-->/.test(hraw)) inComment=false; }
            else if(/^\s*(```+|~~~+)\s*$/.test(hraw)) inFence=false;
          }
        }
      }
    }
    // Newlines belong to the editable text; coloring adds inline spans only.
    parts.push(html||'');
    if(i<lines.length-1) parts.push('\n');
  }
  return parts.join('');
}
function mdUpdateActive(){
  const ed=document.getElementById('mdEditor'); if(!ed) return;
  const {line, col}=mdLineColFromPos(ed.value, ed.selectionStart, _mdPosCache);
  _mdActiveLine=line;
  const pos=document.querySelector('#mdPane .md-pos'); if(pos) pos.textContent=rmsTf('mdPos','Ln %s, Col %s', line+1, col+1);

}
function mdRefreshDecorations(){
  mdInvalidatePosCache();
  const ed=document.getElementById('mdEditor'); if(!ed) return;
  _mdView=mdBuildView();
  const visible=mdVisibleText(_mdView);
  mdPaint(ed, visible, true);
  _mdPrevVisible=visible;
  mdUpdateActive();
}
// ---- Merging an editor edit (typing, paste, toolbar action, …) back into _mdFullText ----
function mdLineDiff(oldLines,newLines){
  let p=0; const maxP=Math.min(oldLines.length,newLines.length);
  while(p<maxP && oldLines[p]===newLines[p]) p++;
  let s=0; while(s<maxP-p && oldLines[oldLines.length-1-s]===newLines[newLines.length-1-s]) s++;
  return { p, oldEnd:oldLines.length-s, newEnd:newLines.length-s };
}
function mdCommitVisibleEdit(){
  const ed=document.getElementById('mdEditor'); if(!ed) return;
  const newVis=ed.value;
  if(newVis===_mdPrevVisible) return;
  const view=_mdView||mdBuildView();
  const oldLines=_mdPrevVisible.split('\n'), newLines=newVis.split('\n');
  const {p, oldEnd, newEnd}=mdLineDiff(oldLines, newLines);
  const fullOldStart = p<view.visLineToFull.length ? view.visLineToFull[p] : view.fullLines.length;
  const fullOldEnd = oldEnd>p ? view.visLineToFull[oldEnd-1]+1 : fullOldStart;
  // Safety check: does the replaced span skip over any folded (hidden) full-text lines?
  // A textarea can only ever show/edit visible lines, so if the visible-to-full mapping
  // isn't consecutive across the replaced range, some hidden content sits inside it.
  let gapCrossed=false;
  if(oldEnd>p){ const span=view.visLineToFull[oldEnd-1]-view.visLineToFull[p]; if(span!==(oldEnd-1-p)) gapCrossed=true; }
  if(gapCrossed){
    // Never silently drop hidden content: reveal it and let the user redo the edit
    // against the now fully-visible text, instead of deleting what they couldn't see.
    let changed=false;
    for(const [a,info] of view.foldInfo){ if(info.end>fullOldStart && info.start<fullOldEnd){ _mdFolds.delete(a); changed=true; } }
    const freshView=mdBuildView(); _mdView=freshView;
    const freshVis=mdVisibleText(freshView);
    ed.value=freshVis; _mdPrevVisible=freshVis;
    if(changed) toast(rmsTr('tExpandedFold','Expanded a folded section — try that edit again'));
    return;
  }
  const newFullLines=newLines.slice(p,newEnd);
  const retainedIds=_mdLines.slice(fullOldStart,fullOldEnd);
  _mdLines.length=view.fullLines.length;
  _mdLines.splice(fullOldStart,fullOldEnd-fullOldStart,...newFullLines.map((_,i)=>retainedIds[i]));
  const fullLines=view.fullLines.slice();
  fullLines.splice(fullOldStart, fullOldEnd-fullOldStart, ...newFullLines);
  _mdFullText=fullLines.join('\n');
  const delta=newFullLines.length-(fullOldEnd-fullOldStart);
  const nextFolds=new Set();
  for(const a of _mdFolds){
    if(a>=fullOldStart && a<fullOldEnd){
      // The anchor's own line was inside the replaced span. If it was a plain in-place
      // edit (that one line swapped for exactly one new line — by far the common case,
      // e.g. fixing a typo in a folded heading), keep the fold anchored there. Otherwise
      // the line's identity is gone, so the fold is dropped — which just means its
      // content becomes visible again, never that it's lost.
      if(a===fullOldStart && newFullLines.length>0) nextFolds.add(fullOldStart);
      continue;
    }
    nextFolds.add(a>=fullOldEnd ? a+delta : a);
  }
  _mdFolds=nextFolds;
  _mdPrevVisible=newVis;   // ed.value itself is left exactly as the browser already has it
}
function mdAfterEdit(){
  mdInvalidatePosCache();
  mdCommitVisibleEdit();
  mdRefreshDecorations();
  clearTimeout(_mdTimer);
  const target=map;
  _mdTimer=setTimeout(()=>{ _mdTimer=0; if(map===target) applyMdToMap(); scheduleSaveStatePost(); }, 300);
}
function flushMdEdits(){
  if(!mdMode || _mdSyncing || _mdComposing || !_mdTimer) return;
  clearTimeout(_mdTimer); _mdTimer=0;
  applyMdToMap();
}
function applyMdToMap(){
  const ed=document.getElementById('mdEditor'); if(!ed||!mdMode||!map) return;
  if(typeof READONLY!=='undefined' && READONLY) return;
  const nextLines=[];
  let parsed;
  try{
    parsed=parseMarkdownOutline(_mdFullText,map.title||'Map',{
      previousNodes:map.nodes, nodeIdsByLine:_mdLines, lineMap:nextLines
    });
  }catch(e){ console.warn('Markdown sync failed:',e); return; }
  if(!parsed||!parsed.rootId||!parsed.nodes||!parsed.nodes[parsed.rootId]) return;
  _mdSyncing=true;
  try{
    sel=null;
    document.querySelectorAll('.node.sel').forEach(n=>n.classList.remove('sel'));
    document.getElementById('nodebar')?.remove();
    map.nodes=parsed.nodes; map.rootId=parsed.rootId;
    map.links=(map.links||[]).filter(link=>map.nodes[link.from] && map.nodes[link.to]);
    _mdLines=nextLines;
    if(typeof balanceRootSides==='function') balanceRootSides();
    autoLayout(); pushHistory();
  }finally{ _mdSyncing=false; }
}

function mdPaneTargetWidthPx(){
  const app=(typeof document!=='undefined' && document.querySelector) ? document.querySelector('.app') : null;
  const raw=(app && typeof getComputedStyle==='function' && getComputedStyle(app).getPropertyValue('--md-w').trim()) || '';
  if(raw.endsWith('vw') && typeof window!=='undefined') return (parseFloat(raw)/100)*window.innerWidth;
  const n=parseFloat(raw);
  if(isFinite(n) && n>0) return n;
  const pane=(typeof document!=='undefined' && document.getElementById) ? document.getElementById('mdPane') : null;
  if(pane && typeof mdMode!=='undefined' && mdMode){
    const w=pane.getBoundingClientRect().width;
    if(w>1) return w;
  }
  if(typeof window!=='undefined' && window.innerWidth) return window.innerWidth*0.4;
  return 0;
}
function reframeKeepZoomForMd(opening, stageBox, mdW){
  if(typeof map==='undefined' || !map) return;
  if(typeof window!=='undefined' && window.matchMedia && window.matchMedia('(max-width: 720px)').matches) return;
  const W0=stageBox && stageBox.w, H0=stageBox && stageBox.h;
  if(!(W0>1 && H0>1)) return;
  const cx=(W0/2-view.x)/view.k, cy=(H0/2-view.y)/view.k;
  if(!isFinite(cx)||!isFinite(cy)) return;
  const paneW=Number(mdW)||0;
  if(!(paneW>0)) return;
  const W1=opening ? Math.max(120, W0-paneW) : (W0+paneW);
  _reframeSmooth(cx, cy, W1, H0);
}
function toggleMdMode(on){
  const want=(on===undefined)?!mdMode:!!on; if(want===mdMode) return;
  if(!want){ flushMdEdits(); mdClearDragSel(); }
  ensureMdPane();
  const _pane=document.getElementById('mdPane'); if(_pane) void _pane.offsetWidth;
  const opening=want;
  const stageBox=_stageSize();
  const livePane=_pane && _pane.getBoundingClientRect().width;
  const mdW=(livePane>1)?livePane:mdPaneTargetWidthPx();
  mdMode=want; document.body.classList.toggle('md-mode', mdMode);
  const btn=document.getElementById('mdToggle'); if(btn) btn.classList.toggle('on', mdMode);
  try{ reframeKeepZoomForMd(opening, stageBox, mdW); }catch(e){}
  if(mdMode){
    syncTextFromMap();
    const ed=document.getElementById('mdEditor');
    if(ed){
      ed.readOnly=!!(typeof READONLY!=='undefined' && READONLY);
      ed.focus();
      if(sel) mdHighlightNode(sel);
      else{ try{ ed.setSelectionRange(0,0); }catch(e){} ed.scrollTop=0; ed.scrollLeft=0; mdUpdateActive(); }
      // Belt-and-suspenders: a browser can apply its own "scroll the caret into view"
      // adjustment asynchronously (a tick after focus/selection change), which would
      // silently reintroduce horizontal scroll after the synchronous reset above. Re-assert
      // once more on the next frame to catch that — same defensive pattern as the earlier
      // click-auto-scroll fix for the active-line highlight.
      requestAnimationFrame(()=>{ ed.scrollLeft=0; });
    }
  }
  else if(!(typeof READONLY!=='undefined' && READONLY)) pushHistory();   // one undo entry for the md session
  if(typeof scheduleSaveStatePost==='function') scheduleSaveStatePost();

}
// Map-level fields a history step captures and restores. One list for both
// sides so a new user-editable field cannot be saved but never restored.
// `pinned` is sidebar state, not an edit, so undo leaves it alone.
const MAP_HISTORY_KEYS=['nodes','rootId','title','titleAuto','color','sameLevelColors','links','layout',
  'vars','style','frontmatter','layoutConfig','layoutParams','layoutPreset'];
function mapHistorySnapshot(){
  const o={};
  for(const key of MAP_HISTORY_KEYS) o[key]=map[key];
  if(!o.links) o.links=[];
  if(!o.vars) o.vars={};
  return JSON.stringify(o);
}
function pushHistory({preserveEditor=false}={}){
  // Snapshot the live WK editor, not the hidden placeholder card. Otherwise
  // marker/color/task clicks (which do not blur-commit) save the pre-edit text
  // and then render() leaves the .edit-float clone on screen.
  if(typeof flushOpenEditToModel==='function') flushOpenEditToModel({preserveEditor});
  if(typeof applyLevelColors==='function') applyLevelColors();
  const snapshot = mapHistorySnapshot();
  if(history.length && hpos>=0 && history[hpos]===snapshot) return;   // nothing actually changed — don't save/flash "Saving…" for no reason
  history=history.slice(0,hpos+1);
  history.push(snapshot);
  if(history.length>60) history.shift();
  hpos=history.length-1;
  updateUndo();
  scheduleSave();                              // any change to history persists
  if(mdMode && !_mdSyncing) syncTextFromMap();                // keep the Markdown editor in sync with canvas edits
}
function updateUndo(){ $('#undo').disabled=hpos<=0; $('#redo').disabled=hpos>=history.length-1; }
function restore(s){
  // Drop the WK editor without writing it — the snapshot is about to replace
  // the model, and flushing would stamp the live draft onto the restored map.
  if(typeof discardEditOverlay==='function') discardEditOverlay();
  const o=JSON.parse(s);
  for(const key of MAP_HISTORY_KEYS){
    if(Object.hasOwn(o,key)) map[key]=o[key]; else delete map[key];
  }
  $('#mapTitle').value=map.title;
  // The snapshot may not contain the nodes the selection points at (undo of an
  // add). Leaving them would make addNode/deleteNode read a missing node.
  if(sel && !map.nodes[sel]) sel=null;
  if(typeof multiSel!=='undefined' && multiSel && multiSel.size){
    for(const id of [...multiSel]) if(!map.nodes[id]) multiSel.delete(id);
    if(multiSel.size<2){ multiSel.clear(); if(typeof hideBulkBar==='function') hideBulkBar(); }
  }
  autoLayout();
  if(mdMode && !_mdSyncing) syncTextFromMap();
  scheduleSave();
}
let _historyChordAt=0;
function undo(){ if(hpos>0){hpos--;restore(history[hpos]);updateUndo(); opLog('undo');} }
function redo(){ if(hpos<history.length-1){hpos++;restore(history[hpos]);updateUndo(); opLog('redo');} }
// Native performKeyEquivalent and the page keydown both see ⌘Z. One chord
// must move history once. Fresh edit sessions have a WK undo stack that is
// not the user's typing — execCommand('undo') there looks like paste/revert.
function notesEditorIsFocused(){
  if(typeof document==='undefined' || !document.activeElement) return false;
  const ae=document.activeElement;
  if(ae.closest && ae.closest('.notes-popup')) return true;
  const notes=typeof openNotesEditorEl==='function' && openNotesEditorEl();
  return !!(notes && (ae===notes || (notes.contains && notes.contains(ae))));
}
function resolveHistoryChordTarget(state){
  if(!state) return 'map';
  if(state.editing && state.typed) return 'editor';
  if(state.notesFocused) return 'editor';
  return 'map';
}
function performHistoryChord(which){
  const now=Date.now();
  if(now-_historyChordAt<50) return true;
  _historyChordAt=now;
  if(typeof isAppTextField==='function' && typeof document!=='undefined' && isAppTextField(document.activeElement)
     && !(typeof openClipboardTarget==='function' && openClipboardTarget())){
    return !!(typeof execCmd==='function' && execCmd(which==='redo'?'redo':'undo'));
  }
  const notesFocused=typeof notesEditorIsFocused==='function' && notesEditorIsFocused();
  const editing=!!(typeof document!=='undefined' && document.querySelector && document.querySelector('.node.editing'))
    || (typeof _editFloat!=='undefined' && !!_editFloat);
  const target=resolveHistoryChordTarget({
    notesFocused:!!notesFocused,
    editing:!!editing,
    typed: typeof _editTyped!=='undefined' && !!_editTyped
  });
  if(target==='editor'){
    return !!(typeof execCmd==='function' && execCmd(which==='redo'?'redo':'undo'));
  }
  if(editing && typeof cancelOpenEdit==='function') cancelOpenEdit();
  if(which==='redo'){ if(typeof redo==='function') redo(); }
  else if(typeof undo==='function') undo();
  return true;
}

function applyLevelColors(){
  if(typeof RMSLevelColors!=='undefined' && map) RMSLevelColors.apply(map, NODE_COLORS.slice(1));
}
window.rmsGetLevelColorsState=()=>({enabled:!!map?.sameLevelColors,disabled:!map || READONLY});
window.rmsSetLevelColorsEnabled=function(on){
  if(!map || READONLY) return;
  commitOpenEdit();
  RMSLevelColors.setEnabled(map, !!on, NODE_COLORS.slice(1));
  pushHistory();
  render();
};

function insertChildNode(parent, extra){
  const pn=map.nodes[parent]||map.nodes[map.rootId];
  const side = pn.id===map.rootId ? (childrenOf(map.rootId).length%2? 'left':'right') : (pn.side||'right');
  const id=uid();
  // Pick a random soft color from the palette (skip plain white at index 0)
  const palette=NODE_COLORS.slice(1);
  const color=palette[Math.floor(Math.random()*palette.length)];
  const node={id,text:rmsTr('newTopic','New topic'),parent:pn.id,
    x:pn.x+(side==='left'?-180:180),y:pn.y+40,side, color, created:Date.now()};
  if(extra) Object.assign(node, extra);
  map.nodes[id]=node;
  if(pn.collapsed) pn.collapsed=false;
  return id;
}
function addNode(parentId,asSibling){
  if(READONLY) return;
  if(!map.nodes[parentId]) parentId=map.rootId;
  let parent=parentId;
  if(asSibling){ const p=map.nodes[parentId]; parent=p.parent||map.rootId; if(parentId===map.rootId) parent=map.rootId; }
  const id=insertChildNode(parent);
  opLog(asSibling?'addSibling':'addChild', {id, parent});
  pushHistory();
  // Stable auto-layout tidies the tree (the new node is inserted in order and
  // everything stays non-overlapping). Because layout is stable, existing
  // branches keep their side/order — it tidies, it doesn't reshuffle.
  autoLayout();
  select(id,true);
}
// Position a freshly-added node relative to its existing siblings without
// moving any other node. Keeps insertion order (new node goes last) and
// preserves the user's manual arrangement of the rest of the map.
function placeNewNodeNear(id){
  const n=map.nodes[id]; if(!n) return;
  const parent=map.nodes[n.parent]; if(!parent) return;
  const layout=map.layout||'balanced';
  // Only stack against siblings on the SAME side. Root children can be split
  // left/right, and a left-side node must be placed on the left (so its edge
  // leaves the root's left edge) rather than next to a right-side sibling —
  // otherwise the connector stretches all the way across the canvas.
  const sibs=childrenOf(n.parent).filter(c=>c!==id && map.nodes[c].side===n.side);
  const nw=n.w||120, nh=n.h||40;
  if(layout==='down'){
    // Horizontal stacking: new node goes to the right of the rightmost sibling
    const childY=parent.y+(parent.h||40)+DOWN_VGAP;
    if(sibs.length){
      let maxRight=-Infinity, y=childY;
      sibs.forEach(s=>{ const sn=map.nodes[s]; maxRight=Math.max(maxRight, sn.x+(sn.w||120)); y=sn.y; });
      n.x=maxRight+DOWN_HGAP; n.y=y;
    } else {
      n.x=parent.x+((parent.w||120)-nw)/2; n.y=childY;
    }
  } else {
    // Vertical stacking: new node goes below the lowest SAME-SIDE sibling
    const dir=n.side==='left'?-1:1;
    if(sibs.length){
      let maxBottom=-Infinity, colX=null;
      sibs.forEach(s=>{ const sn=map.nodes[s]; const b=sn.y+(sn.h||40); if(b>maxBottom){maxBottom=b;} colX=sn.x; });
      n.y=maxBottom+VGAP;
      n.x=(colX!=null)?colX:(dir>0?parent.x+(parent.w||120)+HGAP:parent.x-nw-HGAP);
    } else {
      // First node on this side — sit it beside the parent on the matching side
      n.x=dir>0?parent.x+(parent.w||120)+HGAP:parent.x-nw-HGAP;
      n.y=parent.y+((parent.h||40)-nh)/2;
    }
  }
}
function deleteNode(id){
  if(READONLY) return;
  if(id===map.rootId || !map.nodes[id]) return;
  const rm=[id]; const walk=i=>childrenOf(i).forEach(c=>{rm.push(c);walk(c)}); walk(id);
  const parent=map.nodes[id].parent;
  opLog('del', {id, parent, text:(map.nodes[id].text||'')});
  rm.forEach(r=>delete map.nodes[r]);
  pruneLinks(rm);
  sel=parent;
  autoLayout();      // re-tidy first…
  pushHistory();     // …then snapshot the clean, balanced state
}
// Find-next keeps focus in the search box. select() would otherwise mount the
// WK typing host and steal the caret.
let _searchNavigating=false;
function select(id,edit,fromPointer){
  // Toggle .sel class on existing elements rather than re-rendering — so the
  // DOM element identity is preserved across clicks (required for dblclick).
  document.querySelectorAll('.node.sel').forEach(n=>n.classList.remove('sel'));
  sel=id;
  if(id){
    const el=document.querySelector(`.node[data-id="${id}"]`);
    if(el){
      el.classList.add('sel');
      ensureNodeChrome(el);
    }
  }
  // A pointer select must not put the format toolbar under the second click of
  // a double-click (that click otherwise hits ＋ / paste-looking "New topic" /
  // delete). Keyboard select can show the bar immediately.
  if(fromPointer && !edit){
    $('#nodebar')?.remove();
    scheduleNodeBar();
  } else {
    if(_nodeBarTimer){ clearTimeout(_nodeBarTimer); _nodeBarTimer=0; }
    positionNodeBar();
  }
  updateBreadcrumb();
  if(mdMode && !_mdSelSync && id) mdHighlightNode(id);   // node click -> highlight its Markdown line
  if(edit) setTimeout(()=>startEdit(id),0);
  syncAddSiblingBtn();
  if(!edit && !mdMode && multiSel.size<2 && !_searchNavigating) prepareNodeTyping(id);
}
function syncAddSiblingBtn(){
  const btn=document.getElementById('addSiblingBtn');
  if(!btn) return;
  btn.disabled=!map || !sel || sel===map.rootId;
}

/* ============================================================
   MULTI-SELECT — shift-click to build a selection set, then
   bulk delete / recolor / re-parent.
   ============================================================ */
let multiSel = new Set();
let reparentMode = false;

function toggleMultiSelect(id){
  if(READONLY) return;
  // First shift-click seeds the set with the current primary selection so the
  // node you already had selected is included.
  if(multiSel.size === 0 && sel && sel !== id) multiSel.add(sel);
  if(multiSel.has(id)) multiSel.delete(id);
  else multiSel.add(id);
  updateMultiSelUI();
}
function clearMultiSelect(){
  multiSel.clear();
  reparentMode = false;
  updateMultiSelUI();
}
// Nodes on screen: everything not hidden under a collapsed ancestor.
function visibleNodeIds(nodes, rootId){
  const out=[];
  if(!nodes || !nodes[rootId]) return out;
  const kids={};
  for(const k in nodes){ const p=nodes[k] && nodes[k].parent; if(p!=null) (kids[p]||(kids[p]=[])).push(k); }
  const walk=id=>{ out.push(id); if(!nodes[id].collapsed) (kids[id]||[]).forEach(walk); };
  walk(rootId);
  return out;
}
// ⌘A / ⌘⇧A on the canvas (no editor or text field focused).
function canvasOwnsSelectAll(){
  if(typeof map==='undefined' || !map || !map.nodes) return false;
  if(typeof READONLY!=='undefined' && READONLY) return false;
  if(typeof topModalEl==='function' && topModalEl()) return false;
  const ae=typeof document!=='undefined' ? document.activeElement : null;
  if(ae && (ae.tagName==='INPUT' || ae.tagName==='TEXTAREA' || (ae.isContentEditable && !(typeof pendingNodeTyping==='function' && pendingNodeTyping())))) return false;
  if(ae && ae.closest && ae.closest('#mdPane')) return false;
  return !document.querySelector('.node.editing');
}
function selectNodeSet(ids){
  ids=(ids||[]).filter(id=>map.nodes[id]);
  if(!ids.length) return false;
  multiSel.clear();
  reparentMode=false;
  if(ids.length>=2) ids.forEach(id=>multiSel.add(id));
  if(!sel || !ids.includes(sel)) select(ids[0], false);
  updateMultiSelUI();
  return true;
}
function selectAllNodesOnCanvas(){
  if(!canvasOwnsSelectAll()) return false;
  return selectNodeSet(visibleNodeIds(map.nodes, map.rootId));
}
function selectSiblingsOnCanvas(){
  if(!canvasOwnsSelectAll() || !sel || !map.nodes[sel]) return false;
  const parent=map.nodes[sel].parent;
  return selectNodeSet(parent!=null && map.nodes[parent] ? childrenOf(parent) : [sel]);
}
function updateMultiSelUI(){
  if(multiSel.size>=2 && pendingNodeTyping()) discardEditOverlay();
  document.querySelectorAll('.node.multi-sel').forEach(n=>n.classList.remove('multi-sel'));
  multiSel.forEach(id=>{
    document.querySelector(`.node[data-id="${id}"]`)?.classList.add('multi-sel');
  });
  if(multiSel.size >= 2){
    $('#nodebar')?.remove();   // hide the single-node format toolbar
    showBulkBar();
  } else {
    hideBulkBar();
    if(sel && !mdMode) prepareNodeTyping(sel);
  }
}
function hideBulkBar(){ $('#bulkBar')?.remove(); }
function showBulkBar(prompt){
  hideBulkBar();
  const bar = document.createElement('div');
  bar.id = 'bulkBar'; bar.className = 'bulk-bar';
  if(prompt){
    bar.innerHTML = `<span class="bulk-count">${prompt}</span>
      <button class="bulk-cancel" data-a="cancel">${rmsTr('notesCancel','Cancel')}</button>`;
  } else {
    bar.innerHTML = `
      <span class="bulk-count">${rmsTr('bulkSelected','%s selected').replace('%s', multiSel.size)}</span>
      <div class="bulk-sep"></div>
      <button data-a="bold" title="${rmsTr('actBold','Bold')}"><b>B</b></button>
      <button data-a="italic" title="${rmsTr('actItalic','Italic')}"><i>I</i></button>
      <button data-a="underline" title="${rmsTr('actUnderline','Underline')}"><u>U</u></button>
      <button data-a="strike" title="${rmsTr('actStrike','Strikethrough')}"><s>S</s></button>
      <div class="bulk-sep"></div>
      <button data-a="size" title="${rmsTr('actSize','Font size')}">A<span style="font-size:9px">▾</span></button>
      <button data-a="align" title="${rmsTr('actAlign','Text alignment')}">⇆</button>
      <button data-a="textcolor" title="${rmsTr('actTextColor','Text color')}"><span style="border-bottom:2px solid var(--accent)">A</span></button>
      <button data-a="highlight" title="${rmsTr('actHighlight','Highlight')}">▦</button>
      <button data-a="color" title="${rmsTr('actBg','Node background')}">🎨</button>
      <div class="bulk-sep"></div>
      <button data-a="copymd" title="${rmsTr('actCopyAsMd','Copy as Markdown')}">MD</button>
      <button data-a="reparent" title="${rmsTr('actReparent','Move under a new parent')}">⤷</button>
      <button data-a="delete" class="bulk-danger" title="${rmsTr('scDeleteNode','Delete node')}">🗑</button>
      <button class="bulk-cancel" data-a="cancel" title="${rmsTr('actClearSel','Clear selection')}">✕</button>`;
  }
  document.body.appendChild(bar);
  bar.addEventListener('mousedown', e=>e.stopPropagation());
  bar.querySelectorAll('button').forEach(b=> b.onclick = (ev)=>{
    ev.stopPropagation();
    const a = b.dataset.a;
    if(a==='delete') bulkDelete();
    else if(a==='copymd') copySelectionAsMarkdown();
    else if(a==='color') showBulkColorPicker(b, 'bg');
    else if(a==='reparent') startBulkReparent();
    else if(a==='cancel') clearMultiSelect();
    else if(a==='bold') bulkFormat('bold');
    else if(a==='italic') bulkFormat('italic');
    else if(a==='underline') bulkFormat('underline');
    else if(a==='strike') bulkFormat('strike');
    else if(a==='size') showBulkSizePicker(b);
    else if(a==='align') bulkCycleAlign();
    else if(a==='textcolor') showBulkColorPicker(b, 'text');
    else if(a==='highlight') showBulkColorPicker(b, 'highlight');
  });
}
// Toggle a boolean style across all selected nodes (on if any are off).
function bulkFormat(prop){
  if(READONLY) return;
  const ids = [...multiSel].filter(id=>map.nodes[id]);
  const anyOff = ids.some(id => !map.nodes[id][prop]);
  ids.forEach(id => { map.nodes[id][prop] = anyOff; });
  pushHistory(); render(); updateMultiSelUI();
}
function bulkSetProp(prop, value){
  if(READONLY) return;
  [...multiSel].forEach(id=>{
    if(!map.nodes[id]) return;
    // The root's fill is map.color (the node's own .color is never drawn).
    if(prop==='color' && id===map.rootId){ if(value) map.color = value; }
    else map.nodes[id][prop] = value;
  });
  pushHistory(); render(); updateMultiSelUI();
}
function bulkCycleAlign(){
  if(READONLY) return;
  const order = ['left','center','right'];
  const ids = [...multiSel].filter(id=>map.nodes[id]);
  // Use the first node's current alignment to decide the next in the cycle
  const cur = map.nodes[ids[0]]?.align || 'left';
  const next = order[(order.indexOf(cur)+1) % order.length];
  ids.forEach(id => { map.nodes[id].align = next; });
  pushHistory(); render(); updateMultiSelUI();
  toast(rmsTf('tAligned','Aligned %s', rmsTr('align_'+next, next)));
}
function showBulkSizePicker(anchorBtn){
  document.querySelectorAll('.picker').forEach(p=>p.remove());
  const pk = document.createElement('div');
  pk.className = 'picker size';
  pk.innerHTML = FONT_SIZES.map(s=>`<button data-s="${s}">${s}px</button>`).join('');
  document.body.appendChild(pk);
  positionPopup(pk, anchorBtn);
  pk.addEventListener('mousedown', e=>e.stopPropagation());
  pk.querySelectorAll('button').forEach(b=> b.onclick=()=>{ bulkSetProp('fontSize', +b.dataset.s); pk.remove(); });
  setTimeout(()=>document.addEventListener('click', function cl(e){
    if(!pk.contains(e.target)){ pk.remove(); document.removeEventListener('click', cl); }
  }), 0);
}
function showBulkColorPicker(anchorBtn, kind){
  document.querySelectorAll('.picker').forEach(p=>p.remove());
  let colors, prop, allowNone=false;
  if(kind==='text'){ colors = textColorSwatches(); prop='textColor'; }
  else if(kind==='highlight'){ colors = HILITES; prop='highlight'; allowNone=true; }
  else { colors = ['#fff','#ffd9c2','#ffe9a8','#d6f0c8','#c5e8e4','#cfe0f5','#e6d4f2','#f5d0dd','#e0e0e0']; prop='color'; }
  const pk = document.createElement('div');
  pk.className = 'picker';
  pk.innerHTML =
    (allowNone ? `<button class="p-sw" style="background:transparent;position:relative" data-c="" title="${rmsTr('actNone','None')}">∅</button>` : '') +
    colors.map(c=>`<button class="p-sw" style="background:${c}" data-c="${c}"></button>`).join('');
  document.body.appendChild(pk);
  positionPopup(pk, anchorBtn);
  pk.addEventListener('mousedown', e=>e.stopPropagation());
  pk.querySelectorAll('button').forEach(b=> b.onclick=()=>{
    const v = b.dataset.c;
    bulkSetProp(prop, v || null);
    pk.remove();
  });
  setTimeout(()=>document.addEventListener('click', function cl(e){
    if(!pk.contains(e.target)){ pk.remove(); document.removeEventListener('click', cl); }
  }), 0);
}
function bulkDelete(){
  if(READONLY) return;
  const targets = [...multiSel].filter(id => id !== map.rootId);
  if(!targets.length){ toast(rmsTr('tCantDeleteRoot','Can’t delete the root')); return; }
  const removed = new Set();
  targets.forEach(id=>{
    if(!map.nodes[id]) return;
    const rm=[id]; const walk=i=>childrenOf(i).forEach(c=>{rm.push(c);walk(c)}); walk(id);
    rm.forEach(r=>{ delete map.nodes[r]; removed.add(r); });
  });
  if(sel && removed.has(sel)) sel = map.rootId;
  pruneLinks(removed);
  clearMultiSelect();
  opLog('bulkDel', {text:String(removed.size)});
  pushHistory(); autoLayout();
  toast(removed.size===1 ? rmsTr('tDeletedOne','Deleted 1 node') : rmsTf('tDeletedN','Deleted %s nodes', removed.size));
}
function startBulkReparent(){
  reparentMode = true;
  showBulkBar('Click a target node to move ' + multiSel.size + ' nodes under it…');
}
function selectionMarkdownPayload(){
  if(typeof multiSel==='undefined' || !multiSel || multiSel.size<2) return '';
  if(typeof map==='undefined' || !map || !map.nodes) return '';
  return buildSelectionMarkdown([...multiSel], map.nodes, map.rootId);
}
function copySelectionAsMarkdown(){
  const md=typeof nodeSelectionClipboard==='function' && multiSel && multiSel.size>=2 ? nodeSelectionClipboard().text : selectionMarkdownPayload();
  if(!md) return false;
  if(typeof writeClipboardText==='function' && writeClipboardText(md)){
    toast(rmsTr('copiedAsMd','Copied as Markdown'));
    return true;
  }
  if(typeof navigator!=='undefined' && navigator.clipboard && navigator.clipboard.writeText){
    navigator.clipboard.writeText(md).then(
      ()=>toast(rmsTr('copiedAsMd','Copied as Markdown')),
      ()=>toast(rmsTr('tCopyFailed','Copy failed'))
    );
    return true;
  }
  return false;
}
function bulkReparent(targetId){
  if(READONLY) return;
  const roots = selectionMoveRoots([...multiSel], map.nodes, map.rootId);
  const did = applySelectionMove(roots, targetId, 'on');
  reparentMode = false;
  if(did) clearMultiSelect();
  else updateMultiSelUI();
  toast(did ? (roots.length===1 ? rmsTr('tMovedOne','Moved 1 node') : rmsTf('tMovedN','Moved %s nodes', roots.length)) : rmsTr('tNothingMoved','Nothing moved'));
}

// Axis-aligned boxes. Used by ⌘-marquee hit-testing.
function rectsIntersect(a, b){
  return !!(a && b && a.x < b.x+b.w && a.x+a.w > b.x && a.y < b.y+b.h && a.y+a.h > b.y);
}
function mapRectFromCorners(x0, y0, x1, y1){
  return {x:Math.min(x0,x1), y:Math.min(y0,y1), w:Math.abs(x1-x0), h:Math.abs(y1-y0)};
}
function clientBoxFromGbr(r){
  if(!r) return null;
  const w=r.width!=null?r.width:(r.right-r.left);
  const h=r.height!=null?r.height:(r.bottom-r.top);
  return {x:r.left, y:r.top, w:w, h:h};
}
// Box is painted in clientX. After dropping whole-app zoom/transform, GBR is
// already in that space.
function nodesInMarqueeEls(nodeEls, clientRect){
  if(!nodeEls || !clientRect || !(clientRect.w>0) || !(clientRect.h>0)) return [];
  return nodesInMarqueeRects(marqueeRectsFromEls(nodeEls), clientRect);
}
// One layout read per node, done once when a marquee starts (or the camera
// moves), so each mousemove afterwards is pure math with no forced reflow.
function marqueeRectsFromEls(nodeEls){
  const out=[];
  if(!nodeEls) return out;
  for(let i=0;i<nodeEls.length;i++){
    const el=nodeEls[i];
    const id=el && el.dataset && el.dataset.id;
    if(!id || typeof el.getBoundingClientRect!=='function') continue;
    const box=clientBoxFromGbr(el.getBoundingClientRect());
    if(box && box.w>0 && box.h>0) out.push({id, box});
  }
  return out;
}
function nodesInMarqueeRects(rects, clientRect){
  const hit=[];
  if(!rects || !clientRect || !(clientRect.w>0) || !(clientRect.h>0)) return hit;
  for(let i=0;i<rects.length;i++){
    if(rectsIntersect(rects[i].box, clientRect)) hit.push(rects[i].id);
  }
  return hit;
}
// Model-space variant, kept for tests and anything without a live DOM.
function nodesInMarquee(nodes, rect, hiddenIds){
  const hit=[];
  if(!nodes || !rect || !(rect.w>0) || !(rect.h>0)) return hit;
  for(const id in nodes){
    if(hiddenIds && hiddenIds.has(id)) continue;
    const n=nodes[id];
    if(!n || n.x==null || n.y==null) continue;
    const x=+n.x, y=+n.y, w=+(n.w||120), h=+(n.h||40);
    if(!isFinite(x) || !isFinite(y) || !isFinite(w) || !isFinite(h)) continue;
    if(rectsIntersect({x, y, w, h}, rect)) hit.push(id);
  }
  return hit;
}
// The topics that actually move. A selected child of a selected parent is
// visual-only — it already rides along with the parent, like XMind. Root is
// never a move root, and selecting the root does not swallow its children.
function selectionMoveRoots(ids, nodes, rootId){
  const set=new Set(ids||[]);
  const roots=[];
  for(const id of (ids||[])){
    if(!nodes || !nodes[id] || id===rootId) continue;
    let p=nodes[id].parent, covered=false;
    while(p){
      if(p!==rootId && set.has(p)){ covered=true; break; }
      p=nodes[p]?.parent;
    }
    if(!covered) roots.push(id);
  }
  return roots;
}
function selectionCommonParent(ids, nodes){
  let parent=undefined;
  for(const id of (ids||[])){
    const n=nodes && nodes[id];
    if(!n) continue;
    if(parent===undefined) parent=n.parent;
    else if(n.parent!==parent) return null;
  }
  return parent===undefined ? null : parent;
}
function orderIdsByNodeKeys(ids, nodes){
  const set=new Set(ids||[]);
  const out=[];
  if(!nodes) return out;
  for(const k in nodes) if(set.has(k)) out.push(k);
  return out;
}
function canDropSelection(dragIds, targetId, mode, nodes, rootId){
  if(!dragIds || !dragIds.length || !targetId || !nodes || !nodes[targetId]) return false;
  if(mode!=='on' && targetId===rootId) return false;
  for(const id of dragIds){
    if(!nodes[id] || id===rootId || id===targetId) return false;
    let cur=targetId;
    while(cur){
      if(cur===id) return false;
      cur=nodes[cur]?.parent;
    }
  }
  return true;
}
function spliceNodeOrder(nodes, pullIds, at){
  const pull=new Set(pullIds);
  const out={};
  const insert=()=>{ pullIds.forEach(id=>{ if(nodes[id]) out[id]=nodes[id]; }); };
  let inserted=false;
  for(const k in nodes){
    if(pull.has(k)) continue;
    if(at && at.before && k===at.before){ insert(); inserted=true; }
    out[k]=nodes[k];
    if(at && at.after && k===at.after){ insert(); inserted=true; }
  }
  if(!inserted) insert();
  return out;
}
function siblingIdsOf(nodes, parentId){
  const out=[];
  for(const k in nodes) if(nodes[k] && nodes[k].parent===parentId) out.push(k);
  return out;
}
// Mutates mapObj.nodes. Nest (`on`) or insert as siblings (`before`/`after`).
// Returns false on a no-op so the caller can snap the drag back.
function computeSelectionMove(mapObj, dragIds, targetId, mode){
  const nodes=mapObj && mapObj.nodes;
  const rootId=mapObj && mapObj.rootId;
  const moving=orderIdsByNodeKeys(dragIds, nodes);
  if(!canDropSelection(moving, targetId, mode, nodes, rootId)) return false;
  const target=nodes[targetId];
  const nextParent=mode==='on' ? targetId : target.parent;
  if(nextParent==null && mode!=='on') return false;

  const kidsOf=(()=>{
    const idx=Object.create(null);
    for(const id in nodes){
      const p=nodes[id].parent;
      if(p==null) continue;
      (idx[p]||(idx[p]=[])).push(id);
    }
    return id => idx[id] || [];
  })();
  const setSide=(id, side)=>{
    nodes[id].side=side;
    kidsOf(id).forEach(c=>setSide(c, side));
  };

  if(mode==='on'){
    const toMove=moving.filter(id=>nodes[id].parent!==targetId);
    if(!toMove.length) return false;
    let rootKids=0;
    if(targetId===rootId){
      for(const k in nodes) if(nodes[k].parent===rootId && !toMove.includes(k)) rootKids++;
    }
    toMove.forEach((id,i)=>{
      nodes[id].parent=targetId;
      const side=targetId===rootId
        ? ((rootKids+i)%2 ? 'left' : 'right')
        : (target.side || 'right');
      setSide(id, side);
    });
    let after=targetId;
    const skip=new Set(toMove);
    for(const k in nodes){
      if(skip.has(k)) continue;
      if(nodes[k].parent===targetId) after=k;
    }
    mapObj.nodes=spliceNodeOrder(nodes, toMove, {after});
    return true;
  }

  const prevSibs=siblingIdsOf(nodes, nextParent).join('\0');
  const alreadyHere=moving.every(id=>nodes[id].parent===nextParent);
  const side=(nextParent===rootId) ? (target.side||'right') : (nodes[nextParent].side||target.side||'right');
  moving.forEach(id=>{
    nodes[id].parent=nextParent;
    setSide(id, side);
  });
  mapObj.nodes=spliceNodeOrder(nodes, moving, mode==='before' ? {before:targetId} : {after:targetId});
  if(alreadyHere && siblingIdsOf(mapObj.nodes, nextParent).join('\0')===prevSibs) return false;
  return true;
}
function isBoxSelectModifier(e){
  return !!(e && (e.metaKey || e.ctrlKey) && !e.altKey);
}
function selectionNodeMdText(n){
  if(!n) return 'Untitled';
  if(n.hr) return '---';
  const raw=String(n.text==null?'':n.text);
  const plain=raw.replace(/<[^>]+>/g,'').replace(/&nbsp;/g,' ').replace(/\u00A0/g,' ').replace(/\n+/g,' ').trim();
  return plain || 'Untitled';
}
function buildSelectionMarkdown(ids, nodes, rootId){
  const set=new Set(ids||[]);
  if(!set.size || !nodes) return '';
  const ordered=typeof orderIdsByNodeKeys==='function' ? orderIdsByNodeKeys([...set], nodes) : [...set];
  const roots=[];
  if(rootId && set.has(rootId)) roots.push(rootId);
  const moveRoots=typeof selectionMoveRoots==='function' ? selectionMoveRoots(ordered, nodes, rootId) : ordered;
  moveRoots.forEach(id=>{ if(!roots.includes(id)) roots.push(id); });
  const lines=[];
  const seen=new Set();
  const kidsOf=id=>{
    const out=[];
    for(const k in nodes){
      if(nodes[k] && nodes[k].parent===id && set.has(k)) out.push(k);
    }
    return out;
  };
  const walk=(id, depth)=>{
    if(!nodes[id] || seen.has(id) || !set.has(id)) return;
    seen.add(id);
    const pad='  '.repeat(depth);
    const n=nodes[id];
    if(n.hr) lines.push(pad+'---');
    else lines.push(pad+'- '+selectionNodeMdText(n));
    kidsOf(id).forEach(c=>walk(c, depth+1));
  };
  roots.forEach(id=>walk(id, 0));
  return lines.join('\n');
}

/* ============================================================
   Node clipboard — copy/paste whole subtrees.
   Text on the clipboard is always the Markdown outline (portable,
   works through the native shell which only carries a string). A JSON
   snapshot rides along as NODE_CLIP_MIME where the browser allows it
   and in memory (lastNodeClip) so pasting what we just copied keeps
   notes, markers, colors and links exactly.
   ============================================================ */
const NODE_CLIP_MIME='application/x-rms-nodes';
let _lastNodeClip=null;   // {text, clip}
function rememberNodeClip(text, clip){ _lastNodeClip = text && clip ? {text:String(text), clip} : null; }
function lastNodeClipFor(text){
  if(!_lastNodeClip || text==null) return null;
  const norm=s=>String(s).replace(/\r\n?/g,'\n').trim();
  return norm(text)===norm(_lastNodeClip.text) ? _lastNodeClip.clip : null;
}
// Snapshot of the subtrees under `rootIds`. With `onlyIds`, only those nodes
// are kept (a multi-selection copies what is selected, like its Markdown).
function serializeNodeClip(rootIds, nodes, onlyIds, links){
  const out={v:1, roots:[], nodes:{}, links:[]};
  if(!nodes) return out;
  const only=onlyIds ? new Set(onlyIds) : null;
  const kids={};
  for(const k in nodes){ const p=nodes[k] && nodes[k].parent; if(p!=null) (kids[p]||(kids[p]=[])).push(k); }
  const walk=id=>{
    if(out.nodes[id] || !nodes[id] || (only && !only.has(id))) return;
    const c={...nodes[id]};
    delete c.x; delete c.y;
    out.nodes[id]=c;
    (kids[id]||[]).forEach(walk);
  };
  (rootIds||[]).forEach(id=>{
    if(!nodes[id] || out.nodes[id]) return;
    out.roots.push(id);
    walk(id);
  });
  out.roots.forEach(id=>{ if(out.nodes[id]) out.nodes[id].parent=null; });
  (links||[]).forEach(l=>{ if(l && out.nodes[l.from] && out.nodes[l.to]) out.links.push({...l}); });
  return out;
}
function isNodeClip(clip){
  return !!(clip && Array.isArray(clip.roots) && clip.roots.length && clip.nodes && typeof clip.nodes==='object'
    && clip.roots.every(r=>clip.nodes[r]));
}
// Clone a clip under `parentId` with fresh ids. Mutates `nodes` (and `links`
// when given). Returns the new ids in document order; the first is the first root.
function cloneNodeClipInto(clip, parentId, nodes, makeId, links){
  if(!isNodeClip(clip) || !nodes || !nodes[parentId]) return [];
  const parent=nodes[parentId];
  const parentIsRoot=parent.parent==null;
  let sideCount=0;
  if(parentIsRoot) for(const k in nodes) if(nodes[k] && nodes[k].parent===parentId) sideCount++;
  const kids={};
  for(const k in clip.nodes){ const p=clip.nodes[k] && clip.nodes[k].parent; if(p!=null) (kids[p]||(kids[p]=[])).push(k); }
  const idMap={}, created=[], now=Date.now();
  const place=(oldId, newParent, side)=>{
    const src=clip.nodes[oldId];
    if(!src || idMap[oldId]) return;
    const id=makeId();
    idMap[oldId]=id;
    const n={...src, id, parent:newParent, side, x:parent.x||0, y:parent.y||0, created:now, updated:now};
    nodes[id]=n;
    created.push(id);
    (kids[oldId]||[]).forEach(k=>place(k, id, side));
  };
  clip.roots.forEach(r=>{
    const side=parentIsRoot ? (sideCount++%2 ? 'left' : 'right') : (parent.side && parent.side!=='root' ? parent.side : 'right');
    place(r, parentId, side);
  });
  if(parent.collapsed) parent.collapsed=false;
  if(links && Array.isArray(clip.links)){
    clip.links.forEach(l=>{ if(l && idMap[l.from] && idMap[l.to]) links.push({...l, from:idMap[l.from], to:idMap[l.to]}); });
  }
  return created;
}
// Is this clipboard text an outline (bullets / headings / indented lines)
// rather than one piece of text to put in a node?
function isOutlineClipboardText(text){
  const lines=String(text==null?'':text).replace(/\r\n?/g,'\n').split('\n').filter(l=>l.trim());
  if(lines.length<2) return false;
  const structural=l=>/^\s*(?:[-*+]|\d+[.)])\s+\S/.test(l) || /^#{1,6}\s+\S/.test(l);
  const count=lines.filter(structural).length;
  if(count>=2) return true;
  if(count>=1 && /^#{1,6}\s+\S/.test(lines[0])) return true;
  // A plain indented outline (tabs/spaces, no bullets), as other outliners copy it.
  return count===0 && /^\S/.test(lines[0]) && lines.some(l=>/^[ \t]+\S/.test(l));
}
// Parse outline text into a clip (same shape as serializeNodeClip).
function outlineTextToNodeClip(text){
  let src=String(text==null?'':text).replace(/\r\n?/g,'\n');
  const lines=src.split('\n');
  const anyStructural=lines.some(l=>/^\s*(?:[-*+]|\d+[.)])\s+\S/.test(l) || /^#{1,6}\s+\S/.test(l));
  if(!anyStructural){
    src=lines.filter(l=>l.trim()).map(l=>{
      const ind=(l.match(/^[ \t]*/)||[''])[0].replace(/\t/g,'  ');
      return ind+'- '+l.trim();
    }).join('\n');
  }
  // "1) item" is a list in most outliners; the Markdown parser wants "1."
  src=src.replace(/^(\s*)(\d+)\)\s+/gm, '$1$2. ');
  const SENT='⁣rms-paste';
  const parsed=parseMarkdownOutline(src, SENT);
  const nodes=parsed.nodes;
  const root=nodes[parsed.rootId];
  let roots;
  if(root && root.text===SENT){
    roots=Object.keys(nodes).filter(k=>nodes[k].parent===parsed.rootId);
    delete nodes[parsed.rootId];
  } else roots=[parsed.rootId];
  roots.forEach(r=>{ if(nodes[r]) nodes[r].parent=null; });
  return {v:1, roots, nodes, links:[]};
}
// What ⌘C puts on the clipboard for the node selection (no editor open):
// the Markdown outline, plus a snapshot that paste can clone from.
function nodeSelectionClipboard(){
  if(typeof map==='undefined' || !map || !map.nodes) return {text:'', clip:null};
  const nodes=map.nodes;
  if(typeof multiSel!=='undefined' && multiSel && multiSel.size>=2){
    const ids=[...multiSel].filter(id=>nodes[id]);
    const text=buildSelectionMarkdown(ids, nodes, map.rootId);
    const roots=[];
    if(ids.includes(map.rootId)) roots.push(map.rootId);
    selectionMoveRoots(orderIdsByNodeKeys(ids, nodes), nodes, map.rootId).forEach(id=>{ if(!roots.includes(id)) roots.push(id); });
    const clip=serializeNodeClip(roots, nodes, ids, map.links);
    rememberNodeClip(text, clip);
    return {text, clip};
  }
  if(typeof sel==='undefined' || !sel || !nodes[sel]) return {text:'', clip:null};
  const clip=serializeNodeClip([sel], nodes, null, map.links);
  const ids=Object.keys(clip.nodes);
  const text=ids.length>1 ? buildSelectionMarkdown(ids, nodes, null) : nodeClipboardPlain(nodes[sel]);
  rememberNodeClip(text, clip);
  return {text, clip};
}
// ⌘V on a selected node with no editor open: paste a copied subtree or a
// Markdown outline as children. Returns false when the text should go into
// the node as plain text (today's single-line behavior).
function pasteNodesAsChildren(text, clip){
  if(typeof READONLY!=='undefined' && READONLY) return false;
  if(!map || !map.nodes || !sel || !map.nodes[sel]) return false;
  const parentId=sel;
  const parentNode=map.nodes[parentId];
  if(parentNode.hr) return false;
  if(!isNodeClip(clip)) clip=lastNodeClipFor(text);
  if(!isNodeClip(clip)){
    if(!isOutlineClipboardText(text)) return false;
    try{ clip=outlineTextToNodeClip(text); }catch(_){ return false; }
    if(!isNodeClip(clip)) return false;
  }
  if(!map.links) map.links=[];
  const created=cloneNodeClipInto(clip, parentId, map.nodes, uid, map.links);
  if(!created.length) return false;
  opLog('pasteNodes', {parent:parentId, count:created.length});
  pushHistory();
  autoLayout();
  select(created[0]);
  toast(rmsTr('pastedNodes','Pasted {n} nodes').replace('{n}', created.length));
  return true;
}

/* ============================================================
   CROSS-LINKS — non-tree edges between any two nodes.
   Press L on a selected node, then click another to link them.
   ============================================================ */
let linkMode = false, linkSource = null;
function startLinkMode(sourceId){
  if(READONLY || !sourceId){ return; }
  linkMode = true; linkSource = sourceId;
  document.querySelector(`.node[data-id="${sourceId}"]`)?.classList.add('link-source');
  toast(rmsTr('tLinkMode','Link mode — click another node (Esc to cancel)'));
}
function cancelLinkMode(){
  linkMode = false; linkSource = null;
  document.querySelectorAll('.node.link-source').forEach(n=>n.classList.remove('link-source'));
}
function completeLink(targetId){
  const from = linkSource;
  cancelLinkMode();
  if(READONLY) return;
  if(!from || !targetId || from===targetId) return;
  if(!map.links) map.links = [];
  // Toggle: if this exact link already exists (either direction), remove it
  const existsIdx = map.links.findIndex(l =>
    (l.from===from && l.to===targetId) || (l.from===targetId && l.to===from));
  if(existsIdx >= 0){
    map.links.splice(existsIdx, 1);
    toast(rmsTr('tLinkRemoved','Cross-link removed'));
  } else {
    map.links.push({ from, to: targetId });
    toast(rmsTr('tLinkAdded','Cross-link added'));
  }
  pushHistory(); render(); scheduleSave();
}
// Remove any cross-links that reference a node (called when a node is deleted)
function pruneLinks(removedIds){
  if(!map.links || !map.links.length) return;
  const gone = removedIds instanceof Set ? removedIds : new Set(removedIds);
  map.links = map.links.filter(l => !gone.has(l.from) && !gone.has(l.to));
}

/* ============================================================
   TASK STATE — todo → doing → done, with parent roll-up
   ============================================================ */
// Marker palette popup. Anchored to whatever was clicked (nodebar button or
// the badge itself) so it appears next to the thing the user acted on.
function showMarkerPicker(anchor, id){
  const n=map.nodes[id]; if(!n) return;
  if(READONLY) return;
  if(activePicker){ activePicker.remove(); activePicker=null; }
  const cur=n.marker||'';
  const p=document.createElement('div');
  p.className='picker marker-picker'; p._anchor=anchor;
  p.innerHTML = MARKERS.map(m=>
      `<button data-v="${m.c}" title="${escapeHtml(markerLabel(m))}" class="${m.c===cur?'on':''}">${m.c}</button>`
    ).join('') +
    `<button data-v="" title="${rmsTr('markerRemove','Remove marker')}" class="mk-none">\u2716</button>`;
  document.body.appendChild(p);
  positionPopup(p, anchor, {align:'left'});
  activePicker=p;
  p.addEventListener('mousedown',ev=>{ ev.stopPropagation(); ev.preventDefault(); });
  p.querySelectorAll('button').forEach(b=> b.onclick=ev=>{
    ev.stopPropagation();
    setMarker(id, b.dataset.v);
    p.remove(); if(activePicker===p) activePicker=null;
  });
  // Close on the next outside click, matching how the other popups behave.
  setTimeout(()=>{
    const off=ev=>{
      if(!p.contains(ev.target)){
        p.remove(); if(activePicker===p) activePicker=null;
        document.removeEventListener('mousedown',off);
      }
    };
    document.addEventListener('mousedown',off);
  },0);
}
function setMarker(id, ch){
  const n=map.nodes[id]; if(!n) return;
  // Nodebar / badge clicks do not blur-commit. Flush the WK .edit-float first
  // or render() rebuilds from stale n.text and leaves the clone behind.
  flushOpenEditToModel();
  if(ch) n.marker=ch; else delete n.marker;
  // autoLayout, not just render: the badge changes the node's width, and
  // neighbours were positioned for the old size.
  pushHistory(); render(); autoLayout();
}

/* ============================================================
   PER-NODE HYPERLINK — n.url on the node, not inline text.
   Badge click opens; the nodebar button edits. Text is not
   underlined (that fights the existing inline URL renderer).
   ============================================================ */
function normalizeNodeUrl(raw){
  let s=String(raw==null?'':raw).trim();
  if(!s) return '';
  if(s.charAt(0)==='<' && s.charAt(s.length-1)==='>') s=s.slice(1,-1).trim();
  if(!s) return '';
  if(s.length>2000) s=s.slice(0, 2000);
  if(/^(javascript|data|file|vbscript|blob|about):/i.test(s)) return '';
  if(/^\/\//.test(s)) s='https:'+s;
  else if(!/^[a-z][a-z0-9+.-]*:/i.test(s)){
    if(/^(www\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+([/:?#].*)?$/i.test(s))
      s='https://'+s;
    else return '';
  }
  let u;
  try{ u=new URL(s); }catch(_){ return ''; }
  if(u.protocol!=='http:' && u.protocol!=='https:') return '';
  if(!u.hostname) return '';
  return u.href;
}
function nodeHrefContextId(target){
  if(!target || !target.closest) return null;
  // Handles / chrome keep their existing right-click (shortcut bind). A node
  // without n.url must also fall through so the menu does not change.
  if(target.closest('.handle, .resize-grip, .nodebar, .picker, .notes-mark, .ref-mark, .task-check, .rms-ctx, .row-pop, input, textarea, [contenteditable="true"]')) return null;
  const el=target.closest('.node');
  if(!el || !el.dataset) return null;
  const id=el.dataset.id;
  if(!id || !map || !map.nodes || !map.nodes[id] || !map.nodes[id].url) return null;
  return id;
}
function closeNodeHrefMenu(){
  document.querySelectorAll('.node-href-menu').forEach(p=>p.remove());
}
function showNodeHrefMenu(ev, id){
  closeNodeHrefMenu();
  const label=(typeof window!=='undefined' && window.rmsT) ? window.rmsT('actOpenHref') : 'Open link';
  const p=document.createElement('div');
  p.className='rms-ctx node-href-menu';
  const x0=(ev && ev.clientX) || 8, y0=(ev && ev.clientY) || 8;
  p.style.left=x0+'px';
  p.style.top=y0+'px';
  p.innerHTML=`<button type="button" data-a="open-href">${escapeHtml(label)}</button>`;
  document.body.appendChild(p);
  const r=p.getBoundingClientRect();
  if(r.right>innerWidth-8) p.style.left=Math.max(8, innerWidth-r.width-8)+'px';
  if(r.bottom>innerHeight-8) p.style.top=Math.max(8, innerHeight-r.height-8)+'px';
  p.addEventListener('mousedown',e=>e.stopPropagation());
  p.querySelector('[data-a="open-href"]').onclick=e=>{
    e.stopPropagation();
    closeNodeHrefMenu();
    openNodeUrl(id);
  };
  setTimeout(()=>{
    const off=e=>{
      if(!p.contains(e.target)){
        closeNodeHrefMenu();
        document.removeEventListener('mousedown',off,true);
      }
    };
    document.addEventListener('mousedown',off,true);
  },0);
}
// Right-click on a node (not on its handles / buttons / an open editor):
// the node's own menu. Read-only previews only get "Open link".
function nodeContextId(target){
  if(!target || !target.closest) return null;
  if(target.closest('.handle, .resize-grip, .nodebar, .picker, .notes-mark, .ref-mark, .task-check, .rms-ctx, .row-pop, .node.editing, input, textarea, [contenteditable="true"]')) return null;
  const el=target.closest('.node');
  if(!el || !el.dataset) return null;
  const id=el.dataset.id;
  if(!id || typeof map==='undefined' || !map || !map.nodes || !map.nodes[id]) return null;
  return id;
}
function closeNodeContextMenu(){
  document.querySelectorAll('.node-menu').forEach(p=>p.remove());
}
// Insert `ids` right after `anchor` in the key order of `nodes` (sibling order
// follows key order), so a duplicate lands next to its original.
function insertNodeKeysAfter(nodes, anchor, ids){
  const set=new Set(ids), out={};
  let placed=false;
  for(const k in nodes){
    if(set.has(k)) continue;
    out[k]=nodes[k];
    if(k===anchor){ ids.forEach(i=>{ if(nodes[i]) out[i]=nodes[i]; }); placed=true; }
  }
  if(!placed) ids.forEach(i=>{ if(nodes[i]) out[i]=nodes[i]; });
  return out;
}
function duplicateSubtree(id){
  if(READONLY || !map || !map.nodes[id] || id===map.rootId) return false;
  flushOpenEditToModel();
  const src=map.nodes[id];
  const clip=serializeNodeClip([id], map.nodes, null, map.links);
  if(!map.links) map.links=[];
  const created=cloneNodeClipInto(clip, src.parent, map.nodes, uid, map.links);
  if(!created.length) return false;
  created.forEach(c=>{ map.nodes[c].side=src.side; });
  map.nodes=insertNodeKeysAfter(map.nodes, id, created);
  opLog('duplicate', {id, count:created.length});
  pushHistory();
  autoLayout();
  select(created[0]);
  toast(rmsTr('duplicatedNodes','Duplicated {n} nodes').replace('{n}', created.length));
  return true;
}
function copyNodeAsMarkdown(id){
  if(!map || !map.nodes[id]) return false;
  const ids=Object.keys(serializeNodeClip([id], map.nodes, null).nodes);
  const text=ids.length>1 ? buildSelectionMarkdown(ids, map.nodes, null) : nodeClipboardPlain(map.nodes[id]);
  if(!text) return false;
  rememberNodeClip(text, serializeNodeClip([id], map.nodes, null, map.links));
  if(writeClipboardText(text)){ toast(rmsTr('copiedAsMd','Copied as Markdown')); return true; }
  return false;
}
function nodeContextMenuItems(id){
  const n=map.nodes[id];
  const isRoot=id===map.rootId;
  const hasKids=childrenOf(id).length>0;
  const hasNotes=!!String(n.notes||'').trim();
  const kb=cid=>(typeof window!=='undefined' && window.rmsChordLabel) ? window.rmsChordLabel(cid) : '';
  const items=[
    {a:'child', label:rmsTr('scAddChild','Add child'), kbd:kb('addChild')},
    {a:'sibling', label:rmsTr('scAddSibling','Add sibling'), kbd:kb('addSibling'), off:isRoot},
    {a:'edit', label:rmsTr('actEdit','Edit node'), kbd:kb('editNode'), off:!!(n.hr)},
    {sep:true},
    {a:'notes', label:hasNotes?rmsTr('actNotesEdit','Edit notes'):rmsTr('actNotesAdd','Add notes')},
    {a:'marker', label:rmsTr('ctxSetMarker','Set marker…')},
  ];
  if(n.url) items.push({a:'open-href', label:rmsTr('actOpenHref','Open link')});
  items.push(
    {sep:true},
    {a:'copymd', label:rmsTr('ctxCopyMd','Copy as Markdown')},
    {a:'dup', label:rmsTr('ctxDuplicate','Duplicate subtree'), off:isRoot},
  );
  if(hasKids) items.push({a:'collapse', label:n.collapsed?rmsTr('ctxExpand','Expand'):rmsTr('ctxCollapse','Collapse'), kbd:kb('collapse')});
  items.push({sep:true}, {a:'del', label:rmsTr('scDeleteNode','Delete node'), kbd:kb('deleteNode'), off:isRoot, danger:true});
  return items;
}
function runNodeContextAction(a, id, anchor){
  if(!map || !map.nodes[id]) return;
  if(a==='child') addNode(id,false);
  else if(a==='sibling') addNode(id,true);
  else if(a==='edit') startEdit(id);
  else if(a==='notes') showNotesEditor(id, { sticky:true });
  else if(a==='marker') showMarkerPicker(anchor, id);
  else if(a==='open-href') openNodeUrl(id);
  else if(a==='copymd') copyNodeAsMarkdown(id);
  else if(a==='dup') duplicateSubtree(id);
  else if(a==='collapse'){
    const n=map.nodes[id];
    n.collapsed=!n.collapsed;
    opLog(n.collapsed?'collapse':'expand', {id});
    pushHistory(); autoLayout();
  }
  else if(a==='del') deleteNode(id);
}
function showNodeContextMenu(ev, id){
  closeNodeContextMenu();
  closeNodeHrefMenu();
  if(sel!==id || (multiSel && multiSel.size)){
    if(multiSel && multiSel.size && typeof clearMultiSelect==='function') clearMultiSelect();
    select(id);
  }
  const nodeEl=document.querySelector(`.node[data-id="${CSS.escape(id)}"]`);
  const p=document.createElement('div');
  p.className='rms-ctx node-menu';
  p.setAttribute('role','menu');
  p.style.left=((ev && ev.clientX) || 8)+'px';
  p.style.top=((ev && ev.clientY) || 8)+'px';
  p.innerHTML=nodeContextMenuItems(id).map(it=>it.sep
    ? '<div class="rms-ctx-sep" role="separator"></div>'
    : `<button type="button" role="menuitem" data-a="${it.a}"${it.off?' disabled':''}${it.danger?' class="danger"':''}><span>${escapeHtml(it.label)}</span>${it.kbd?`<kbd>${escapeHtml(it.kbd)}</kbd>`:''}</button>`
  ).join('');
  document.body.appendChild(p);
  const r=p.getBoundingClientRect();
  if(r.right>innerWidth-8) p.style.left=Math.max(8, innerWidth-r.width-8)+'px';
  if(r.bottom>innerHeight-8) p.style.top=Math.max(8, innerHeight-r.height-8)+'px';
  const buttons=[...p.querySelectorAll('button:not([disabled])')];
  let off=null;
  const close=()=>{
    p.remove();
    if(off) document.removeEventListener('mousedown', off, true);
  };
  p.addEventListener('mousedown', e=>{ e.stopPropagation(); if(e.target.closest('button')) e.preventDefault(); });
  p.addEventListener('click', e=>{
    const b=e.target.closest('button[data-a]');
    if(!b || b.disabled) return;
    e.stopPropagation();
    close();
    runNodeContextAction(b.dataset.a, id, nodeEl && nodeEl.isConnected ? nodeEl : b);
  });
  // Keyboard: ↑/↓/Home/End move, Enter/Space run (native button), Esc closes.
  p.addEventListener('keydown', e=>{
    const i=buttons.indexOf(document.activeElement);
    const go=j=>{ if(buttons.length){ buttons[(j+buttons.length)%buttons.length].focus(); } };
    if(e.key==='ArrowDown'){ go(i+1); }
    else if(e.key==='ArrowUp'){ go(i<0 ? buttons.length-1 : i-1); }
    else if(e.key==='Home'){ go(0); }
    else if(e.key==='End'){ go(buttons.length-1); }
    else if(e.key==='Escape' || e.key==='Tab'){ close(); }
    else if(e.key!=='Enter' && e.key!==' ') return;
    if(e.key!=='Enter' && e.key!==' ') e.preventDefault();
    e.stopPropagation();
  });
  if(buttons.length) buttons[0].focus({preventScroll:true});
  setTimeout(()=>{
    off=e=>{ if(!p.contains(e.target)) close(); };
    if(p.isConnected) document.addEventListener('mousedown', off, true);
  },0);
}
function onNodeContextMenu(e){
  if(typeof READONLY!=='undefined' && READONLY){
    const hid=nodeHrefContextId(e && e.target);
    if(hid){ if(e.stopPropagation) e.stopPropagation(); showNodeHrefMenu(e, hid); }
    return;
  }
  const id=nodeContextId(e && e.target);
  if(!id) return;
  if(e.stopPropagation) e.stopPropagation();
  showNodeContextMenu(e, id);
}
function isRmsWk(){
  return !!(typeof document!=='undefined' && document.documentElement
    && document.documentElement.classList
    && document.documentElement.classList.contains('rms-wk'));
}
function openExternalUrl(url){
  if(!url) return false;
  // Same rule as Markdown links: only http(s)/mailto are handed to the native opener.
  if(!isSafeLinkUrl(url)) return false;
  // WK: window.open(_blank) already goes through createWebViewWith →
  // NSWorkspace.open. createWebViewWith returns nil, so window.open is null
  // even though the page already opened. A fallback <a> click would open it
  // a second time via decidePolicyFor / createWebViewWith again.
  const opened=window.open(url, '_blank', 'noopener,noreferrer');
  if(opened || isRmsWk()) return true;
  const a=document.createElement('a');
  a.href=url; a.target='_blank'; a.rel='noopener noreferrer';
  document.body.appendChild(a); a.click(); a.remove();
  return true;
}
function openNodeUrl(id){
  const n=map.nodes[id]; if(!n) return;
  const url=normalizeNodeUrl(n.url);
  if(!url){ toast(rmsTr('tNoUrl','No valid URL on this node')); return; }
  openExternalUrl(url);
}
function setNodeUrl(id, raw){
  const n=map.nodes[id]; if(!n) return false;
  flushOpenEditToModel();
  const trimmed=String(raw==null?'':raw).trim();
  const url=normalizeNodeUrl(trimmed);
  if(trimmed && !url){ toast(rmsTr('tNeedUrl','Need a valid http(s) URL')); return false; }
  if(url) n.url=url; else delete n.url;
  n.updated=Date.now();
  pushHistory(); render(); autoLayout();
  return true;
}
function showHrefPicker(anchor, id){
  const n=map.nodes[id]; if(!n) return;
  if(READONLY) return;
  if(activePicker){ activePicker.remove(); activePicker=null; }
  const cur=n.url||'';
  const p=document.createElement('div');
  p.className='picker href-picker'; p._anchor=anchor;
  p.innerHTML=
    `<input class="href-in" type="text" inputmode="url" spellcheck="false" autocomplete="off" placeholder="https://…" value="${escapeHtml(cur)}">`+
    `<div class="href-actions">`+
      (cur?`<button type="button" class="href-open" title="${rmsTr('hrefOpen','Open in browser')}">↗ ${rmsTr('hrefOpen','Open in browser')}</button>`:'')+
      (cur?`<button type="button" class="href-clear">${rmsTr('hrefRemove','Remove')}</button>`:'')+
      `<button type="button" class="href-go primary">${rmsTr('hrefSave','Save')}</button>`+
    `</div>`;
  document.body.appendChild(p);
  positionPopup(p, anchor, {align:'left'});
  activePicker=p;
  const input=p.querySelector('.href-in');
  let off=null;
  const close=()=>{
    if(off) document.removeEventListener('mousedown',off);
    p.remove(); if(activePicker===p) activePicker=null;
  };
  const save=()=>{ if(setNodeUrl(id, input.value)) close(); else input.focus(); };
  p.addEventListener('mousedown',ev=>ev.stopPropagation());
  p.addEventListener('keydown',ev=>ev.stopPropagation());
  input.addEventListener('keydown',ev=>{
    if(ev.isComposing || ev.keyCode===229) return;
    if(ev.key==='Enter'){ ev.preventDefault(); save(); }
    else if(ev.key==='Escape'){ ev.preventDefault(); close(); }
  });
  p.querySelector('.href-go').onclick=ev=>{ ev.stopPropagation(); save(); };
  p.querySelector('.href-clear')?.addEventListener('click',ev=>{ ev.stopPropagation(); setNodeUrl(id, ''); close(); });
  p.querySelector('.href-open')?.addEventListener('click',ev=>{ ev.stopPropagation(); openNodeUrl(id); });
  setTimeout(()=>{
    input.focus();
    input.select();
    off=ev=>{
      if(!p.contains(ev.target)) close();
    };
    document.addEventListener('mousedown',off);
  },0);
}
function applyMdTable(id, raw){
  const n=map.nodes[id]; if(!n) return false;
  flushOpenEditToModel();
  const grid=parseMarkdownTable(raw);
  if(!grid) return false;
  n.html=markdownTableToHtml(grid);
  n.table=true;
  n.text=grid.headers.filter(Boolean).slice(0,4).join(' · ') || rmsTr('actMdTable','Markdown table');
  if(!n.width) n.width=480;
  if(!n.height) n.height=240;
  n.updated=Date.now();
  pushHistory(); render(); autoLayout();
  return true;
}
function clearMdTable(id){
  const n=map.nodes[id]; if(!n) return false;
  flushOpenEditToModel();
  delete n.html;
  delete n.table;
  n.updated=Date.now();
  pushHistory(); render(); autoLayout();
  return true;
}
function showMdTablePicker(anchor, id){
  const n=map.nodes[id]; if(!n) return;
  if(READONLY) return;
  if(activePicker){ activePicker.remove(); activePicker=null; }
  const cur=isTableNode(n) ? htmlTableToMarkdown(n.html||'') : '';
  const p=document.createElement('div');
  p.className='picker href-picker mdtable-picker'; p._anchor=anchor;
  p.innerHTML=
    `<div class="mdt-label">${rmsTr('actMdTableHint','Paste a Markdown table, or a table copied from somewhere else.')}</div>`+
    `<textarea class="mdt-in" rows="10" spellcheck="false" placeholder="${rmsTr('actMdTablePh','| A | B |')}">${escapeHtml(cur)}</textarea>`+
    `<div class="mdt-err" hidden></div>`+
    `<div class="href-actions">`+
      (cur?`<button type="button" class="href-clear">${rmsTr('hrefRemove','Remove')}</button>`:'')+
      `<button type="button" class="href-go primary">${rmsTr('hrefSave','Save')}</button>`+
    `</div>`;
  document.body.appendChild(p);
  positionPopup(p, anchor, {align:'left'});
  activePicker=p;
  const input=p.querySelector('.mdt-in');
  const err=p.querySelector('.mdt-err');
  let off=null;
  const close=()=>{
    if(off) document.removeEventListener('mousedown',off);
    p.remove(); if(activePicker===p) activePicker=null;
  };
  const fail=()=>{
    err.hidden=false;
    err.textContent=rmsTr('actMdTableErr','Couldn’t read that as a table');
    input.focus();
  };
  const save=()=>{ if(applyMdTable(id, input.value)) close(); else fail(); };
  p.addEventListener('mousedown',ev=>ev.stopPropagation());
  p.addEventListener('keydown',ev=>ev.stopPropagation());
  input.addEventListener('keydown',ev=>{
    if(ev.isComposing || ev.keyCode===229) return;
    if(ev.key==='Enter' && (ev.metaKey||ev.ctrlKey)){ ev.preventDefault(); save(); }
    else if(ev.key==='Escape'){ ev.preventDefault(); close(); }
  });
  p.querySelector('.href-go').onclick=ev=>{ ev.stopPropagation(); save(); };
  p.querySelector('.href-clear')?.addEventListener('click',ev=>{ ev.stopPropagation(); clearMdTable(id); close(); });
  setTimeout(()=>{
    input.focus();
    if(cur) input.select();
    off=ev=>{
      if(!p.contains(ev.target)) close();
    };
    document.addEventListener('mousedown',off);
  },0);
}
function cycleTask(id){
  const n=map.nodes[id]; if(!n) return;
  // Nodebar clicks do not blur-commit (so inline B/I/U keep their selection).
  // The live editor still has to land on the model before render() rebuilds
  // the node from n.text — otherwise "add todo" while typing wipes the draft.
  flushOpenEditToModel();
  const order=[null,'todo','doing','done'];
  const cur=order.indexOf(n.task||null);
  const next=order[(cur+1)%order.length];
  if(next) n.task=next; else delete n.task;
  pushHistory(); render();
}
// Count done / total task-bearing nodes within a subtree (excluding the node itself)
function taskProgress(id){
  let done=0,total=0;
  const walk=i=>childrenOf(i).forEach(c=>{
    const t=map.nodes[c].task;
    if(t){ total++; if(t==='done') done++; }
    walk(c);
  });
  walk(id);
  return {done,total};
}

/* ============================================================
   CITATION / REFERENCE NODES
   ============================================================ */
function formatCitation(c){
  if(!c) return '';
  if(typeof c==='string') return c;
  const parts=[];
  if(c.authors) parts.push(c.authors);
  if(c.year) parts.push('('+c.year+')');
  let s=parts.join(' ');
  // Appends a segment with the right separator — avoids a double period when the
  // preceding segment already ends in sentence punctuation (very common for
  // authors with abbreviated initials, e.g. "Smith, J.").
  const append = seg => { if(!s){ s=seg; return; } s += (/[.!?]$/.test(s) ? ' ' : '. ') + seg; };
  if(c.title) append(c.title);
  if(c.source) append(c.source);
  if(c.doi) append(/^https?:/.test(c.doi)?c.doi:'doi:'+c.doi);
  return s.trim();
}
// Layout config editor. A raw JSON textarea rather than a row of sliders: the
// point of externalising these constants was that a config can be written,
// saved and shared as text. Whatever is typed goes through
// validateLayoutConfig(), so an out-of-range or misspelled value is corrected
// rather than accepted — and the corrected result is what gets saved, which is
// the only way to discover the bounds without separate documentation.
// Import / manage layout presets. Shows the current map's layout as JSON so a
// user can copy it, tweak it, and paste it back as a new preset — which is the
// realistic way anyone produces one of these.
// Shared by the JSON import dialog and the shipped presets: validate, refuse a
// built-in id, save on this device (re-importing replaces). {preset} or {error}.
function importLayoutPreset(parsed){
  const preset = validateLayoutPreset(parsed);
  if(!preset){
    return {error:rmsTf('layoutErrUnusable','Not a usable layout. It needs an "id" (letters, digits and dashes), a "name", and an "engine" that is one of: %s.', LAYOUT_ENGINES.join(', '))};
  }
  if(BUILTIN_LAYOUTS.some(b=>b.id===preset.id)){
    return {error:rmsTf('layoutErrBuiltin','“%s” is a built-in layout name — please choose another id.', preset.id)};
  }
  const list = loadCustomLayouts().filter(c=>c.id!==preset.id);   // re-importing replaces
  list.push(preset);
  if(!saveCustomLayouts(list)) return {error:rmsTr('layoutErrStorage','Could not save — this browser’s storage may be full.')};
  return {preset};
}
// The layout presets shipped in public/layouts/ (listed by index.json). Loaded
// the first time the layout picker opens, then cached for the session.
let _shippedLayouts=null;
function loadShippedLayouts(){
  if(_shippedLayouts) return _shippedLayouts;
  const get=path=>fetch(path, {cache:'no-cache'}).then(r=>{ if(!r.ok) throw new Error('HTTP '+r.status); return r.json(); });
  _shippedLayouts=get('layouts/index.json').then(idx=>{
    const files=(idx && Array.isArray(idx.files) ? idx.files : []).filter(f=>/^[a-z0-9-]+\.json$/i.test(f));
    return Promise.all(files.map(f=>get('layouts/'+f).catch(()=>null)));
  }).then(list=>list.filter(raw=>raw && validateLayoutPreset(raw)))
    .catch(e=>{ _shippedLayouts=null; throw e; });
  return _shippedLayouts;
}
// Presets reuse the thumbnail of the layout family they tune.
function layoutThumbId(raw){
  if(!raw) return '';
  if(raw.engine) return raw.engine;
  const p=raw.params||{};
  return ({tree: p.axis==='y' ? 'down' : (p.dir===-1 ? 'left' : 'right'), chain:'timeline', radial:'radial', grid:'grid'})[raw.strategy] || raw.id;
}
function fillLayoutPresetRow(panel, curLayout){
  const row=panel && panel.querySelector('.tp-preset-row');
  if(!row) return;
  const importTile=`<button class="theme-opt tp-import" data-cat="layout-import" title="${escapeHtml(rmsTr('layoutImportTitle','Paste a layout as JSON'))}">
      <span class="style-thumb tp-import-thumb">\uFF0B</span><span class="theme-name">${escapeHtml(rmsTr('layoutImport','Import\u2026'))}</span>
    </button>`;
  const wire=()=>{
    const imp=row.querySelector('.tp-import');
    if(imp) imp.onclick=ev=>{ ev.stopPropagation(); closeThemePanel(); showLayoutImportForm(); };
  };
  loadShippedLayouts().then(list=>{
    if(!row.isConnected) return;
    const ids=new Set(list.map(raw=>raw.id));
    // A preset imported earlier would otherwise show twice.
    panel.querySelectorAll('.theme-opt[data-cat="layout"]').forEach(o=>{ if(ids.has(o.dataset.id)) o.remove(); });
    row.innerHTML=list.map(raw=>`
      <button class="theme-opt${raw.id===curLayout?' active':''}" data-cat="layout-preset" data-id="${escapeHtml(raw.id)}" title="${escapeHtml(layoutDesc(raw))}">
        ${buildLayoutThumb(layoutThumbId(raw))}<span class="theme-name">${escapeHtml(layoutName(raw))}</span>
      </button>`).join('')+importTile;
    row.querySelectorAll('.theme-opt[data-cat="layout-preset"]').forEach((opt,i)=>{
      opt.onclick=ev=>{
        ev.stopPropagation();
        if(!map || READONLY) return;
        const res=importLayoutPreset(list[i]);
        if(res.error){ toast(res.error, 6000); return; }
        applyMapLayout(res.preset.id);
        panel.querySelectorAll('.theme-opt[data-cat="layout"], .theme-opt[data-cat="layout-preset"]').forEach(o=>o.classList.remove('active'));
        opt.classList.add('active');
      };
    });
    wire();
    const act=row.querySelector('.theme-opt.active');
    if(act) act.scrollIntoView({block:'nearest', inline:'nearest'});
    row.dispatchEvent(new Event('scroll'));
  }).catch(()=>{
    if(!row.isConnected) return;
    row.innerHTML=`<span class="tp-hint tp-preset-msg">${escapeHtml(rmsTr('layoutPresetsFailed','Could not load the presets'))}</span>`+importTile;
    wire();
  });
}
function showLayoutImportForm(){
  document.querySelectorAll('.var-form').forEach(p=>p.remove());
  const cur = map ? (findLayout(map.layoutPreset || map.layout) || BUILTIN_LAYOUTS[0]) : BUILTIN_LAYOUTS[0];
  const sample = JSON.stringify({
    v:1, id:'my-timeline', name:'My timeline', desc:'Wider spacing',
    engine: cur.engine,
    options: validateLayoutConfig(map && map.layoutConfig),
  }, null, 2);
  const customs = loadCustomLayouts();
  const m=document.createElement('div'); m.className='var-form';
  m.innerHTML=`
    <div class="vf-backdrop"></div>
    <div class="vf-card">
      <button class="vf-close" aria-label="${rmsTh('close','Close')}">\u00d7</button>
      <h2>${rmsTh('liTitle','Import a layout')}</h2>
      <div class="vf-hint">${escapeHtml(rmsTf('liHint','A layout picks one of the built-in engines (%s) and tunes it — it cannot define a new algorithm. Imported layouts are saved on this device; the maps you apply them to stay readable for everyone.', LAYOUT_ENGINES.join(', ')))}</div>
      <div class="vf-fields">
        <textarea class="vf-input vf-json" rows="14" spellcheck="false">${escapeHtml(sample)}</textarea>
      </div>
      <div class="vf-err" hidden></div>
      ${customs.length ? `<div class="vf-hint" style="margin-top:10px">${rmsTh('liSaved','Saved layouts')}</div>
        <div class="li-list">${customs.map(c=>
          `<span class="li-chip">${escapeHtml(layoutName(c))}<button data-del="${escapeHtml(c.id)}" title="${rmsTh('dlgRemove','Remove')}">\u00d7</button></span>`
        ).join('')}</div>` : ''}
      <div class="vf-actions">
        <button class="vf-cancel">${rmsTh('cancel','Cancel')}</button>
        <button class="vf-go primary">${rmsTh('liImport','Import')}</button>
      </div>
    </div>`;
  document.body.appendChild(m);
  m.addEventListener('mousedown',e=>e.stopPropagation());
  const ta=m.querySelector('.vf-json'), err=m.querySelector('.vf-err');
  ta.focus();
  const close=()=>m.remove();
  const fail=msg=>{ err.hidden=false; err.textContent=msg; };
  m.querySelector('.vf-go').onclick=()=>{
    let parsed;
    try{ parsed = JSON.parse(ta.value); }
    catch(e){ return fail(rmsTf('errBadJson','Not valid JSON: %s', e.message)); }
    const res = importLayoutPreset(parsed);
    if(res.error) return fail(res.error);
    const preset = res.preset;
    close(); toast(rmsTf('tLayoutImported','Layout “%s” imported', layoutName(preset)));
    try{ $('#themeBtn').click(); }catch(_){}   // reopen so the new entry is visible
  };
  m.querySelectorAll('[data-del]').forEach(b=> b.onclick=()=>{
    const id=b.dataset.del;
    saveCustomLayouts(loadCustomLayouts().filter(c=>c.id!==id));
    // A map already using it keeps working: engine and options live on the map.
    close(); toast(rmsTr('tLayoutRemoved','Layout removed'));
    try{ $('#themeBtn').click(); }catch(_){}
  });
  m.querySelector('.vf-cancel').onclick=close;
  m.querySelector('.vf-close').onclick=close;
  m.querySelector('.vf-backdrop').onclick=close;
  m.addEventListener('keydown',e=>{ if(e.key==='Escape'){ e.preventDefault(); close(); } });
}
function showLayoutConfigForm(){
  if(!map || READONLY) return;
  document.querySelectorAll('.var-form').forEach(p=>p.remove());
  // Only the active engine's knobs — showing timeline's settings while
  // 'balanced' is selected was both confusing and inapplicable.
  const engine = map.layout || 'balanced';
  const current = JSON.stringify(layoutConfigFor(engine, map.layoutConfig), null, 2);
  const m=document.createElement('div'); m.className='var-form';
  m.innerHTML=`
    <div class="vf-backdrop"></div>
    <div class="vf-card">
      <button class="vf-close" aria-label="${rmsTh('close','Close')}">\u00d7</button>
      <h2>${escapeHtml(rmsTf('lcTitle','Layout settings — %s', layoutName(findLayout(map.layoutPreset||engine)||{name:engine})))}</h2>
      <div class="vf-hint">${rmsTh('lcHint','Saved with this map and included in share links. Out-of-range values are clamped and unknown keys ignored, so what you get back may differ from what you type.')}</div>
      <div class="vf-fields">
        <textarea class="vf-input vf-json" rows="14" spellcheck="false">${escapeHtml(current)}</textarea>
      </div>
      <div class="vf-err" hidden></div>
      <div class="vf-actions">
        <button class="vf-unref">${rmsTh('lcReset','Reset to defaults')}</button>
        <button class="vf-cancel">${rmsTh('cancel','Cancel')}</button>
        <button class="vf-go primary">${rmsTh('lcApply','Apply')}</button>
      </div>
    </div>`;
  document.body.appendChild(m);
  m.addEventListener('mousedown',e=>e.stopPropagation());
  const ta=m.querySelector('.vf-json'), err=m.querySelector('.vf-err');
  ta.focus();
  const close=()=>m.remove();
  const apply=section=>{
    // Merge, do not replace: the dialog only ever shows the ACTIVE engine's
    // section, so writing a whole fresh object would silently reset the
    // settings of every other layout the user had tuned.
    map.layoutConfig = { ...(map.layoutConfig || {}), ...section };
    // autoLayout re-places and schedules a save; scheduleSave() is called
    // directly too so the settings persist even if a future change makes that
    // path conditional.
    // Snapshot after the relayout: the history entry must hold both the new
    // config and the node positions it produced.
    render(); autoLayout(); pushHistory();
    try{ scheduleSave(); }catch(e){ console.warn('saving layout settings failed:', e.message); }
    close(); toast(rmsTr('tLayoutSaved','Layout settings saved'));
  };
  m.querySelector('.vf-go').onclick=()=>{
    let parsed;
    try{ parsed = JSON.parse(ta.value); }
    catch(e){ err.hidden=false; err.textContent=rmsTf('errBadJson','Not valid JSON: %s', e.message); return; }
    // Keep only the section for the engine being edited.
    apply(layoutConfigFor(engine, parsed));
  };
  m.querySelector('.vf-unref').onclick=()=>apply(layoutConfigFor(engine, null));
  m.querySelector('.vf-cancel').onclick=close;
  m.querySelector('.vf-close').onclick=close;
  m.querySelector('.vf-backdrop').onclick=close;
  m.addEventListener('keydown',e=>{ if(e.key==='Escape'){ e.preventDefault(); close(); } });
}
function showCitationForm(id){
  const n=map.nodes[id]; if(!n) return;
  document.querySelectorAll('.var-form').forEach(p=>p.remove());
  const c = (n.citation && typeof n.citation==='object') ? n.citation : {};
  const m=document.createElement('div'); m.className='var-form';
  m.innerHTML=`
    <div class="vf-backdrop"></div>
    <div class="vf-card">
      <button class="vf-close" aria-label="${rmsTh('close','Close')}">×</button>
      <h2>${rmsTh('citeTitle','Reference / citation')}</h2>
      <p class="vf-sub">${rmsTr('citeSubHtml','Fill the fields, or paste a full citation into “Authors”. The node will show the formatted reference and be included in <b>Export → References</b>.')}</p>
      <div class="vf-doi-lookup">
        <input class="vf-doi-in" placeholder="${rmsTh('citeDoiPh','Paste a DOI to autofill (e.g. 10.1109/TIM.2026.3659640)')}">
        <button class="vf-doi-go">${rmsTh('citeFetch','Fetch')}</button>
      </div>
      <div class="vf-fields">
        <label class="vf-row"><span class="vf-name">${rmsTh('citeAuthors','Authors')}</span><textarea class="vf-input" data-f="authors" rows="1" placeholder="Smith, J. & Doe, A.">${escapeHtml(c.authors||'')}</textarea></label>
        <label class="vf-row"><span class="vf-name">${rmsTh('citeTitleField','Title')}</span><textarea class="vf-input" data-f="title" rows="1" placeholder="${rmsTh('citeTitlePh','A study of …')}">${escapeHtml(c.title||'')}</textarea></label>
        <label class="vf-row"><span class="vf-name">${rmsTh('citeYear','Year')}</span><textarea class="vf-input" data-f="year" rows="1" placeholder="2026">${escapeHtml(c.year||'')}</textarea></label>
        <label class="vf-row"><span class="vf-name">${rmsTh('citeSource','Source / venue')}</span><textarea class="vf-input" data-f="source" rows="1" placeholder="${rmsTh('citeSourcePh','Journal / Conference')}">${escapeHtml(c.source||'')}</textarea></label>
        <label class="vf-row"><span class="vf-name">DOI / URL</span><textarea class="vf-input" data-f="doi" rows="1" placeholder="${rmsTh('citeDoiFieldPh','10.1109/… or https://…')}">${escapeHtml(c.doi||'')}</textarea></label>
      </div>
      <div class="vf-actions">
        ${n.ref?`<button class="vf-unref">${rmsTh('citeRemove','Remove reference')}</button>`:''}
        <button class="vf-cancel">${rmsTh('cancel','Cancel')}</button>
        <button class="vf-go primary">${rmsTh('citeSave','Save reference')}</button>
      </div>
    </div>`;
  document.body.appendChild(m);
  m.addEventListener('mousedown',e=>e.stopPropagation());
  m.querySelectorAll('.vf-input').forEach(ta=>{ const g=()=>{ta.style.height='auto';ta.style.height=Math.min(ta.scrollHeight,120)+'px';}; ta.addEventListener('input',g); g(); });
  m.querySelector('.vf-input')?.focus();
  const close=()=>m.remove();
  // DOI → Crossref autofill
  const doiGo=m.querySelector('.vf-doi-go'), doiIn=m.querySelector('.vf-doi-in');
  const setField=(f,val)=>{ const ta=m.querySelector(`.vf-input[data-f="${f}"]`); if(ta && val){ ta.value=val; ta.dispatchEvent(new Event('input')); } };
  const fetchDoi=async()=>{
    let doi=(doiIn.value||'').trim();
    if(!doi){ toast(rmsTr('tPasteDoi','Paste a DOI first')); return; }
    doi=doi.replace(/^https?:\/\/(dx\.)?doi\.org\//i,'').replace(/^doi:/i,'').trim();
    doiGo.disabled=true; const old=doiGo.textContent; doiGo.textContent='…';
    try{
      const r=await fetch('https://api.crossref.org/works/'+encodeURIComponent(doi),{headers:{'Accept':'application/json'}});
      if(!r.ok) throw new Error('HTTP '+r.status);
      const msg=(await r.json()).message||{};
      const authors=(msg.author||[]).map(a=>[a.family,a.given].filter(Boolean).join(', ')).join('; ');
      const title=Array.isArray(msg.title)?msg.title[0]:msg.title;
      const yr=(msg.issued&&msg.issued['date-parts']&&msg.issued['date-parts'][0]&&msg.issued['date-parts'][0][0]);
      const source=Array.isArray(msg['container-title'])?msg['container-title'][0]:(msg['container-title']||msg.publisher);
      if(authors) setField('authors',authors);
      if(title) setField('title',title);
      if(yr) setField('year',String(yr));
      if(source) setField('source',source);
      setField('doi', msg.DOI ? 'https://doi.org/'+msg.DOI : doi);
      toast(rmsTr('tCiteFilled','Citation autofilled'));
    }catch(e){ toast(rmsTr('tDoiFailed','DOI lookup failed — check the DOI or fill manually')); }
    finally{ doiGo.disabled=false; doiGo.textContent=old; }
  };
  doiGo.onclick=fetchDoi;
  doiIn.addEventListener('keydown',e=>{ if(e.key==='Enter'){ e.preventDefault(); fetchDoi(); } });
  m.querySelector('.vf-go').onclick=()=>{
    const cit={}; m.querySelectorAll('.vf-input').forEach(ta=>{ if(ta.value.trim()) cit[ta.dataset.f]=ta.value.trim(); });
    n.citation=cit; n.ref=true;
    const formatted=formatCitation(cit);
    if(formatted) n.text=formatted;
    pushHistory(); render(); close(); toast(rmsTr('tRefSaved','Reference saved'));
  };
  m.querySelector('.vf-unref')?.addEventListener('click',()=>{ delete n.ref; delete n.citation; pushHistory(); render(); close(); toast(rmsTr('tRefRemoved','Reference removed')); });
  m.querySelector('.vf-cancel').onclick=close;
  m.querySelector('.vf-close').onclick=close;
  m.querySelector('.vf-backdrop').onclick=close;
  m.addEventListener('keydown',e=>{ if(e.key==='Escape'){e.preventDefault();close();} });
}
// Collect every reference node and copy a formatted list to the clipboard.
function exportReferences(){
  if(!map) return;
  const refs=Object.values(map.nodes).filter(n=>n.ref).map(n=>formatCitation(n.citation)||nodeTextPlain(n.text));
  if(!refs.length){ toast(rmsTr('tNoRefs','No reference nodes yet — mark a node with 📖')); return; }
  refs.sort((a,b)=>a.localeCompare(b));
  const text='References\n\n'+refs.map((r,i)=>`[${i+1}] ${r}`).join('\n')+'\n';
  if(navigator.clipboard?.writeText){
    navigator.clipboard.writeText(text).then(()=>toast(rmsTf('tRefsCopied','%s references copied', refs.length)),
      ()=>{ download(new Blob([text],{type:'text/plain'}),(map.title||'references')+'.txt'); toast(rmsTr('tRefsDownloaded','Downloaded references')); });
  } else { download(new Blob([text],{type:'text/plain'}),(map.title||'references')+'.txt'); toast(rmsTr('tRefsDownloaded','Downloaded references')); }
}

/* ============================================================
   IMAGE ATTACHMENTS — files on disk, one folder per map
   ============================================================ */
function nodeImageSrc(n, mapObj){
  const src = n && n.image;
  if(!src) return '';
  if(/^(data:|blob:|https?:|\/\/)/i.test(src)) return src;
  if(src.charAt(0)==='/') return apiUrl(src);
  const mapId = (mapObj|| (typeof map!=='undefined' ? map : null));
  const id = mapId && mapId.id;
  if(!id) return src;
  return apiUrl('/api/maps/' + encodeURIComponent(id) + '/images/' + encodeURIComponent(src));
}
function attachImageToNode(id){
  const inp=document.createElement('input'); inp.type='file'; inp.accept='image/*';
  inp.onchange=()=>{ const f=inp.files[0]; if(f) readImageFile(f,id); };
  inp.click();
}
function commitImageData(id, data){
  if(!map || !map.nodes[id] || !data) return;
  map.nodes[id].image=data;
  delete map.nodes[id].imagePending;
  // autoLayout(), not just render(): the node grows to fit the image, and
  // its neighbours' positions were computed for the old, smaller size —
  // without a re-tidy the enlarged node overlaps them.
  pushHistory(); render(); autoLayout();
}
function eventOnNodeImage(target){
  return !!(target && target.closest && target.closest('.node-image'));
}
function nodeHasImage(n){
  return !!(n && n.image);
}
function shouldOpenImageOnPointer({ hasImage, wasSelected, isDoubleClick }){
  if(!hasImage) return false;
  return !!(isDoubleClick || wasSelected);
}
function imagePastingLabel(){
  if(typeof rmsT==='function') return rmsT('imgPasting');
  return 'Pasting…';
}
function openNodeImageLightbox(id){
  if(typeof map==='undefined' || !map || !map.nodes || !map.nodes[id] || !map.nodes[id].image) return false;
  openImageLightbox(nodeImageSrc(map.nodes[id]));
  return true;
}
let _pendingImageOpen=null;
function detachImageFromNode(id){
  if(!map || !map.nodes || !map.nodes[id] || map.nodes[id].image===undefined) return false;
  delete map.nodes[id].image;
  delete map.nodes[id].imageAlt;
  if(!String(map.nodes[id].text||'').trim()) map.nodes[id].text='Untitled';
  map.nodes[id].updated=Date.now();
  pushHistory(); render(); autoLayout();
  return true;
}
function failImageAttach(id){
  toast(rmsTr('tImgReadFail','Could not read image'));
  const n=map && map.nodes && map.nodes[id];
  if(!n || n.image) return;
  if(n.text && !n.imagePending) return;
  const parent=n.parent;
  delete map.nodes[id];
  if(sel===id) sel=parent||map.rootId;
  if(typeof render==='function') render();
  if(typeof autoLayout==='function') autoLayout();
}
function dataUrlToBlob(dataUrl){
  const m = String(dataUrl||'').match(/^data:([^;]+);base64,(.+)$/);
  if(!m) return null;
  const bin = atob(m[2]);
  const arr = new Uint8Array(bin.length);
  for(let i=0;i<bin.length;i++) arr[i]=bin.charCodeAt(i);
  return new Blob([arr], { type: m[1] });
}
async function uploadMapImage(blob, mime){
  if(!map || !map.id) throw new Error('no map');
  if(typeof fetch!=='function') throw new Error('no fetch');
  const r = await fetch(apiUrl('/api/maps/' + encodeURIComponent(map.id) + '/images'), {
    method: 'POST',
    headers: { 'Content-Type': mime || blob.type || 'application/octet-stream' },
    body: blob
  });
  let j=null;
  try{ j = await r.json(); }catch(_){ }
  if(!r.ok || !j || !j.name) throw new Error((j && j.error) || 'upload failed');
  return j.name;
}
function readImageFile(file,id){
  if(!file || !file.type || !file.type.startsWith('image/')){ toast(rmsTr('tNotImage','Not an image file')); return; }
  Promise.resolve(uploadMapImage(file, file.type)).then(
    name => commitImageData(id, name),
    () => failImageAttach(id)
  );
}
function readImageDataUrl(dataUrl,id){
  if(!dataUrl || !map || !map.nodes[id]) return;
  const blob = dataUrlToBlob(dataUrl);
  if(!blob){ failImageAttach(id); return; }
  Promise.resolve(uploadMapImage(blob, blob.type)).then(
    name => commitImageData(id, name),
    () => failImageAttach(id)
  );
}
function resolveImagePasteParentId(state){
  const editingId = state && Object.prototype.hasOwnProperty.call(state, 'editingId')
    ? state.editingId
    : (typeof document!=='undefined' && document.querySelector && document.querySelector('.node.editing') && document.querySelector('.node.editing').dataset.id);
  const selectedId = state && Object.prototype.hasOwnProperty.call(state, 'selectedId')
    ? state.selectedId
    : (typeof sel!=='undefined' ? sel : null);
  const nodes = state && Object.prototype.hasOwnProperty.call(state, 'nodes')
    ? state.nodes
    : (typeof map!=='undefined' && map ? map.nodes : null);
  const parentId = editingId || selectedId;
  if(!parentId || !nodes || !nodes[parentId]) return null;
  return parentId;
}
function beginImagePasteAsChild(parentId){
  if(typeof READONLY!=='undefined' && READONLY) return null;
  if(!parentId || !map || !map.nodes[parentId]) return null;
  if(typeof commitOpenEdit==='function') commitOpenEdit();
  const id=insertChildNode(parentId, {text:'', imagePending:true});
  if(typeof opLog==='function') opLog('addChild', {id, parent: parentId});
  sel=id;
  if(typeof render==='function') render();
  if(typeof autoLayout==='function') autoLayout();
  return id;
}
function pasteImageAsChild(file, dataUrl, fileName){
  if(typeof READONLY!=='undefined' && READONLY) return false;
  if(typeof overlayTextFieldOwnsClipboard==='function' && overlayTextFieldOwnsClipboard()) return false;
  if(typeof document!=='undefined' && typeof isAppTextField==='function' && isAppTextField(document.activeElement)
     && !(typeof openClipboardTarget==='function' && openClipboardTarget())) return false;
  const parentId=resolveImagePasteParentId();
  if(!parentId){ toast(rmsTr('tSelectForImage','Select a topic first, then paste the image')); return false; }
  const id=beginImagePasteAsChild(parentId);
  if(!id) return false;
  if(fileName) commitImageData(id, fileName);
  else if(file) readImageFile(file, id);
  else if(dataUrl) readImageDataUrl(dataUrl, id);
  else return false;
  return true;
}

/* ------------------------------------------------------------
   Drag-and-drop attaches an image onto the node under the pointer.
   Paste (Cmd+V / Edit → Paste) creates a child of the selected node
   and puts the image on that child.

   Both paths save the original file into the map's image folder and
   store only the filename on the node.

   Note these use the HTML5 drag events (dragover/drop), which are a
   completely separate channel from the mousedown/mousemove dragging
   used to reparent nodes — so file drops and node dragging cannot
   interfere with each other.
   ------------------------------------------------------------ */

// Which node, if any, is under these viewport coordinates?
function nodeIdAtPoint(clientX, clientY){
  const el = document.elementFromPoint(clientX, clientY);
  const nodeEl = el && el.closest ? el.closest('.node') : null;
  const id = nodeEl && nodeEl.dataset.id;
  return (id && map && map.nodes && map.nodes[id]) ? id : null;   // must be a live node
}

// Pull the first image out of a DataTransfer, whether it arrived as a
// dropped file or as a pasted clipboard item.
function firstImageFile(dt){
  if(!dt) return null;
  const files = dt.files && dt.files.length ? [...dt.files] : [];
  if(files.length) return files.find(f => f.type.startsWith('image/')) || null;
  // Clipboard images arrive as items with no entry in .files
  if(dt.items){
    for(const it of dt.items){
      if(it.kind === 'file'){
        const f = it.getAsFile();
        if(f && f.type.startsWith('image/')) return f;
      }
    }
  }
  return null;
}

let _fileDropEl = null;
function setFileDropTarget(el){
  if(_fileDropEl === el) return;
  if(_fileDropEl) _fileDropEl.classList.remove('file-drop');
  _fileDropEl = el;
  if(_fileDropEl) _fileDropEl.classList.add('file-drop');
}

if(stage){
  stage.addEventListener('dragover', e => {
    // Only claim the event for actual file drags — otherwise a text
    // selection drag would be hijacked too.
    if(READONLY || !e.dataTransfer || ![...e.dataTransfer.types].includes('Files')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    const id = nodeIdAtPoint(e.clientX, e.clientY);
    // A separate class from .drop-target on purpose: that one means
    // "nest as child" during node dragging, and reusing it here would
    // promise something this drop does not do.
    setFileDropTarget(id ? viewport.querySelector(`.node[data-id="${id}"]`) : null);
  });

  stage.addEventListener('dragleave', e => {
    if(e.target === stage || !stage.contains(e.relatedTarget)) setFileDropTarget(null);
  });

  stage.addEventListener('drop', e => {
    if(READONLY || !e.dataTransfer || ![...e.dataTransfer.types].includes('Files')) return;
    e.preventDefault();
    setFileDropTarget(null);
    const id = nodeIdAtPoint(e.clientX, e.clientY);
    if(!id){ toast(rmsTr('tDropOnCard','Drop an image onto a topic card to attach it')); return; }
    const file = firstImageFile(e.dataTransfer);
    if(!file){ toast(rmsTr('tOnlyImages','Only image files can be attached')); return; }
    if(e.dataTransfer.files && e.dataTransfer.files.length > 1) toast(rmsTr('tFirstImageOnly','Attaching the first image only'));
    // Same commit-first reasoning as the paste handler below.
    const editingEl = document.querySelector('.node.editing');
    if(editingEl){
      const te = editingEl.querySelector('.node-text') || editingEl;
      te.blur();
    }
    readImageFile(file, id);
  });
}

function handleImagePasteEvent(e){
  if(READONLY) return false;
  const file = firstImageFile(e && e.clipboardData);
  if(!file) return false;                 // ordinary text paste — leave it alone
  if(!pasteImageAsChild(file, null)) return false;
  if(e && e.preventDefault) e.preventDefault();
  return true;
}
window.addEventListener('paste', handleImagePasteEvent);

/* ------------------------------------------------------------
   Fullscreen image viewer — double-click a node image.
   Wheel zooms, drag pans, a click with no drag or Escape closes.
   ------------------------------------------------------------ */
const IMAGE_LIGHTBOX_CLICK_PX = 6;
const IMAGE_LIGHTBOX_CLICK_GUARD_MS = 1000;
let _imgLb = { open:false, scale:1, x:0, y:0, ptr:null, moved:0, openedAt:0 };
function imageLightboxZoomAt(state, clientX, clientY, nextScale, vw, vh){
  const scale = Math.min(16, Math.max(0.05, nextScale));
  const cx = clientX - vw/2;
  const cy = clientY - vh/2;
  const k = scale / (state.scale || 1);
  return { scale, x: cx - (cx - (state.x||0)) * k, y: cy - (cy - (state.y||0)) * k };
}
function imageLightboxShouldCloseOnPointerUp(movedPx, threshold){
  return (movedPx||0) < (threshold==null ? IMAGE_LIGHTBOX_CLICK_PX : threshold);
}
function imageLightboxClickCloseAllowed(now, openedAt, guardMs){
  const start = openedAt||0;
  const guard = guardMs==null ? IMAGE_LIGHTBOX_CLICK_GUARD_MS : guardMs;
  return (now||0) - start >= guard;
}
function isImageLightboxOpen(){
  return !!(_imgLb && _imgLb.open);
}
function applyImageLightboxTransform(){
  const img = typeof document!=='undefined' && document.getElementById && document.getElementById('imgLightboxPic');
  if(!img) return;
  img.style.transform = 'translate('+_imgLb.x+'px,'+_imgLb.y+'px) scale('+_imgLb.scale+')';
}
function closeImageLightbox(){
  const box = typeof document!=='undefined' && document.getElementById && document.getElementById('imgLightbox');
  if(box) box.hidden = true;
  if(box && box.classList) box.classList.remove('dragging');
  _imgLb.open = false;
  _imgLb.ptr = null;
  _imgLb.moved = 0;
}
function openImageLightbox(src){
  if(!src || typeof document==='undefined') return;
  const box = document.getElementById('imgLightbox');
  const img = document.getElementById('imgLightboxPic');
  if(!box || !img) return;
  img.style.transform = 'none';
  img.onload = ()=>{
    const vw = window.innerWidth || 1;
    const vh = window.innerHeight || 1;
    const nw = img.naturalWidth || 1;
    const nh = img.naturalHeight || 1;
    _imgLb.scale = Math.min(1, (vw*0.92)/nw, (vh*0.92)/nh);
    _imgLb.x = 0; _imgLb.y = 0;
    applyImageLightboxTransform();
  };
  img.src = src;
  box.hidden = false;
  _imgLb.open = true;
  _imgLb.ptr = null;
  _imgLb.moved = 0;
  _imgLb.openedAt = Date.now();
}
function armImageLightbox(){
  if(typeof document==='undefined') return;
  const box = document.getElementById('imgLightbox');
  const img = document.getElementById('imgLightboxPic');
  if(!box || !img || box.dataset.armed) return;
  box.dataset.armed = '1';
  img.addEventListener('dragstart', e=>e.preventDefault());
  box.addEventListener('wheel', e=>{
    if(!_imgLb.open) return;
    e.preventDefault();
    e.stopPropagation();
    const speed = typeof wheelSpeed!=='undefined' ? wheelSpeed : 40;
    const factor = typeof wheelZoomFactor==='function'
      ? wheelZoomFactor(e.deltaY, speed)
      : (e.deltaY > 0 ? 0.9 : 1.1);
    if(factor===1) return;
    const next = imageLightboxZoomAt(_imgLb, e.clientX, e.clientY, _imgLb.scale * factor, window.innerWidth, window.innerHeight);
    _imgLb.scale = next.scale; _imgLb.x = next.x; _imgLb.y = next.y;
    applyImageLightboxTransform();
  }, { passive:false });
  box.addEventListener('pointerdown', e=>{
    if(!_imgLb.open) return;
    e.preventDefault();
    e.stopPropagation();
    if(e.target !== img){
      if(imageLightboxClickCloseAllowed(Date.now(), _imgLb.openedAt)) closeImageLightbox();
      return;
    }
    _imgLb.ptr = { x:e.clientX, y:e.clientY };
    _imgLb.moved = 0;
    try{ img.setPointerCapture(e.pointerId); }catch(_){}
  });
  box.addEventListener('pointermove', e=>{
    if(!_imgLb.open || !_imgLb.ptr) return;
    const dx = e.clientX - _imgLb.ptr.x;
    const dy = e.clientY - _imgLb.ptr.y;
    _imgLb.ptr = { x:e.clientX, y:e.clientY };
    _imgLb.moved += Math.hypot(dx, dy);
    if(_imgLb.moved >= IMAGE_LIGHTBOX_CLICK_PX){
      _imgLb.x += dx; _imgLb.y += dy;
      box.classList.add('dragging');
      applyImageLightboxTransform();
    }
  });
  const endPtr = e=>{
    if(!_imgLb.open) return;
    const moved = _imgLb.moved;
    _imgLb.ptr = null;
    box.classList.remove('dragging');
    if(e && e.target === img && imageLightboxShouldCloseOnPointerUp(moved)
       && imageLightboxClickCloseAllowed(Date.now(), _imgLb.openedAt)) closeImageLightbox();
  };
  box.addEventListener('pointerup', endPtr);
  box.addEventListener('pointercancel', endPtr);
}
if(typeof document!=='undefined' && document.addEventListener){
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded', armImageLightbox);
  else armImageLightbox();
  window.addEventListener('keydown', e=>{
    if(!_imgLb.open) return;
    if(e.key==='Escape'){ e.preventDefault(); e.stopPropagation(); closeImageLightbox(); }
  }, true);
}

/* ============================================================
   SEARCH ACROSS ALL MAPS
   ============================================================ */
// Map contents keyed by id; reused while the index still reports the same
// `updated`, so retyping a query does not refetch every unchanged map.
const _searchMapCache=new Map();
const SEARCH_FETCH_CONCURRENCY=4;
// isStale(): true once a newer search has started — this run then stops and
// returns null instead of finishing work nobody will look at.
async function searchAllMaps(query, isStale){
  const q=(query||'').trim().toLowerCase();
  if(!q) return [];
  const stale=()=>typeof isStale==='function' && isStale();
  let idx=[]; try{ idx=await Store.list(); }catch(e){ idx=[]; }
  if(stale()) return null;
  idx=Array.isArray(idx)?idx:[];
  const live=new Set(idx.map(meta=>meta&&meta.id));
  for(const id of _searchMapCache.keys()) if(!live.has(id)) _searchMapCache.delete(id);
  const load=async meta=>{
    if(!meta) return null;
    if(meta.id===(map&&map.id)) return map;
    const hit=_searchMapCache.get(meta.id);
    if(hit && meta.updated!=null && hit.updated===meta.updated) return hit.m;
    let m=null;
    try{ m=await Store.get(meta.id); }catch(e){ return null; }
    if(m && meta.updated!=null) _searchMapCache.set(meta.id, {updated:meta.updated, m});
    return m;
  };
  const results=[];
  for(let b=0;b<idx.length;b+=SEARCH_FETCH_CONCURRENCY){
    const batch=await Promise.all(idx.slice(b, b+SEARCH_FETCH_CONCURRENCY).map(load));
    if(stale()) return null;
    for(const m of batch){
    if(!m||!m.nodes) continue;
    for(const n of Object.values(m.nodes)){
      const plain=nodeTextPlain(n.text||'').toLowerCase();
      const notes=(n.notes||'').replace(/<[^>]*>/g,' ').toLowerCase();
      const href=(n.url||'').toLowerCase();
      if(plain.includes(q) || notes.includes(q) || href.includes(q)){
        const src=plain.includes(q)?nodeTextPlain(n.text||''):notes.includes(q)?(n.notes||'').replace(/<[^>]*>/g,' '):(n.url||'');
        const at=src.toLowerCase().indexOf(q);
        const snippet=(at>30?'…':'')+src.slice(Math.max(0,at-30), at+q.length+40).trim()+'…';
        results.push({ mapId:m.id, mapTitle:m.title||rmsTr('untitled','Untitled map'), nodeId:n.id, snippet });
        if(results.length>=200) return results;
      }
    }
    }
  }
  return results;
}

// Debounced global search → render results panel
let _globalSearchT=null, _globalSearchSeq=0;
function runGlobalSearch(query){
  clearTimeout(_globalSearchT);
  const q=(query||'').trim();
  if(q.length<2){ hideGlobalResults(); return; }
  const seq=++_globalSearchSeq;
  _globalSearchT=setTimeout(async ()=>{
    const panel=ensureGlobalResults();
    panel.innerHTML='<div class="gs-status">'+rmsTr('searchingAll','Searching all maps…')+'</div>';
    const results=await searchAllMaps(q, ()=>seq!==_globalSearchSeq);
    if(!results || seq!==_globalSearchSeq) return;   // a newer search superseded this one
    renderGlobalResults(results, q);
  }, 220);
}
function ensureGlobalResults(){
  let panel=$('#globalResults');
  if(!panel){
    panel=document.createElement('div');
    panel.id='globalResults'; panel.className='global-results';
    panel.addEventListener('mousedown',e=>e.stopPropagation());
    document.body.appendChild(panel);
  }
  // Anchor under the search strip
  panel.style.display='block';
  positionPopup(panel, $('#searchWrap'), {align:'right'});
  return panel;
}
function hideGlobalResults(){ const p=$('#globalResults'); if(p) p.style.display='none'; }
function renderGlobalResults(results, q){
  const panel=ensureGlobalResults();
  if(!results.length){ panel.innerHTML=`<div class="gs-status">${rmsTr('noMatchesFor','No matches for “%s”.').replace('%s', escapeHtml(q))}</div>`; return; }
  // Group by map
  const byMap={};
  results.forEach(r=>{ (byMap[r.mapId]=byMap[r.mapId]||{title:r.mapTitle, items:[]}).items.push(r); });
  // Highlight on the PLAIN snippet, then escape each piece: running the regex over
  // already-escaped HTML could split an entity (&amp;) or match inside one.
  const ql=String(q||'').toLowerCase();
  const hl=snip=>{
    const s=String(snip||''), low=s.toLowerCase();
    if(!ql || low.length!==s.length) return escapeHtml(s);
    let out='', from=0, at;
    while((at=low.indexOf(ql, from))>=0){
      out+=escapeHtml(s.slice(from,at))+'<mark>'+escapeHtml(s.slice(at,at+ql.length))+'</mark>';
      from=at+ql.length;
    }
    return out+escapeHtml(s.slice(from));
  };
  panel.innerHTML=`<div class="gs-head">${(results.length===1?rmsTr('matchAcross','%s match across %s map'):rmsTr('matchesAcross','%s matches across %s maps')).replace('%s', results.length).replace('%s', Object.keys(byMap).length)}</div>`+
    Object.entries(byMap).map(([mid,g])=>`
      <div class="gs-group">
        <div class="gs-map">${escapeHtml(g.title)}${mid===(map&&map.id)?' <span class="gs-cur">(current)</span>':''}</div>
        ${g.items.slice(0,8).map(it=>`
          <button class="gs-item" data-map="${escapeHtml(String(mid))}" data-node="${escapeHtml(String(it.nodeId))}">
            ${hl(it.snippet)}
          </button>`).join('')}
        ${g.items.length>8?`<div class="gs-more">+${g.items.length-8} more…</div>`:''}
      </div>`).join('');
  panel.querySelectorAll('.gs-item').forEach(b=> b.onclick=async ()=>{
    const mid=b.dataset.map, nid=b.dataset.node;
    if(!map || map.id!==mid){ await loadMap(mid); }
    select(nid,false);
    centreOn(nid);
    hideGlobalResults();
  });
}

/* ---------- inline editing ---------- */
// Live markdown shortcuts while editing: typing the closing delimiter of
// **bold**, *italic*, or ~~strike~~ converts the span in place (Notion/Linear
// style). Runs on each input event; processes one completed pattern at a time.
function tryMarkdownShortcut(){
  const wsel = window.getSelection();
  if(!wsel || !wsel.rangeCount) return false;
  const range = wsel.getRangeAt(0);
  const node = range.startContainer;
  if(node.nodeType !== 3) return false;            // text nodes only
  const offset = range.startOffset;
  const upto = node.nodeValue.slice(0, offset);
  // Order matters: bold (**) must be tested before italic (*).
  const patterns = [
    [/\*\*([^*]+?)\*\*$/, 'b'],
    [/\*([^*]+?)\*$/,     'i'],
    [/~~([^~]+?)~~$/,     's'],
    [/`([^`]+?)`$/,       'code'],
  ];
  for(const [re, tag] of patterns){
    const m = upto.match(re);
    if(!m || !m[1].trim()) continue;
    const inner = m[1];
    const matchStart = offset - m[0].length;
    const before = node.nodeValue.slice(0, matchStart);
    const after  = node.nodeValue.slice(offset);
    const parent = node.parentNode;
    const frag = document.createDocumentFragment();
    if(before) frag.appendChild(document.createTextNode(before));
    const fmt = document.createElement(tag);
    fmt.textContent = inner;
    frag.appendChild(fmt);
    const afterNode = document.createTextNode(after.length ? after : '\u00A0');
    frag.appendChild(afterNode);
    parent.replaceChild(frag, node);
    // Put the cursor right after the formatted span so further typing is normal
    const nr = document.createRange();
    if(after.length){ nr.setStart(afterNode, 0); }
    else { nr.setStart(afterNode, 1); }   // past the nbsp placeholder
    nr.collapse(true);
    wsel.removeAllRanges(); wsel.addRange(nr);
    return true;
  }
  return false;
}

// Edit an imported block node (code block or table) in place: its rendered HTML is
// made contentEditable and, on commit, read back into n.html (code -> re-escaped
// <pre><code>; table -> sanitized <table>) so n.text is never corrupted. Blur / Esc /
// Ctrl+Enter finish; inside a code block Enter just adds a newline.
function captureBlockEditHTML(box, original){
  let html;
  if(/<pre[\s>]/i.test(original||'')){
    const pre=box.querySelector('pre');
    const tmp=(pre||box).cloneNode(true);
    tmp.querySelectorAll('br').forEach(br=>br.replaceWith(document.createTextNode('\n')));
    const code=(tmp.textContent||'').replace(/\n$/,'');
    html='<pre><code>'+code.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')+'</code></pre>';
  } else {
    const tbl=box.querySelector('table');
    html=sanitizeNotes(tbl?tbl.outerHTML:box.innerHTML);
  }
  return html && html.replace(/<[^>]+>/g,'').trim() ? html : original;
}
function startBlockEdit(id, el){
  const node=map.nodes[id]; const box=el.querySelector('.node-block'); if(!node||!box) return;
  const original=node.html;
  el.classList.add('editing','editing-block');
  _liveEditing=true;
  armEditorHost(box); box.focus();
  const finish=(commit)=>{
    _commitOpenEdit=null;
    _liveEditing=false;
    disarmEditorHost(box); el.classList.remove('editing','editing-block');
    if(blurTimer){ clearTimeout(blurTimer); blurTimer=0; }
    box.removeEventListener('blur',onBlur); box.removeEventListener('keydown',onKey);
    box.removeEventListener('compositionstart',onCompositionStart);
    box.removeEventListener('compositionend',onCompositionEnd);
    if(commit){
      const html=captureBlockEditHTML(box, original);
      map.nodes[id].html=html; pushHistory();
    }
    autoLayout();   // re-renders the node fresh from n.html (drops contentEditable cruft)
  };
  let composing=false, blurTimer=0;
  const onCompositionStart=()=>{ composing=true; box._rmsComposing=true; };
  const onCompositionEnd=()=>{ composing=false; box._rmsComposing=false; if(typeof markImeCompositionEnd==='function') markImeCompositionEnd(); };
  const onBlur=()=>{
    if(composing) return;
    clearTimeout(blurTimer);
    blurTimer=setTimeout(()=>{
      blurTimer=0;
      if(!el.classList.contains('editing-block')) return;
      if(!shouldCommitEditOnBlur({
        composing,
        activeInside: el.contains(document.activeElement) || isEditSessionChrome(document.activeElement),
        pointerOutside: consumeEditBlurCommit()
      })) return;
      finish(true);
    }, 120);
  };
  const onKey=e=>{
    if(clipboardEditAction(e)) return;
    if(isImeEvent(e) || composing || isImeSwitchEvent(e)) return;
    if(e.key==='Escape'){
      if(!shouldCommitEditOnEscape(e)) return;
      e.preventDefault(); e.stopPropagation(); finish(true); box.blur();
    }
    else if(e.key==='Enter' && (e.ctrlKey||e.metaKey)){ e.preventDefault(); e.stopPropagation(); finish(true); box.blur(); }
  };
  box.addEventListener('blur',onBlur); box.addEventListener('keydown',onKey);
  box.addEventListener('compositionstart',onCompositionStart);
  box.addEventListener('compositionend',onCompositionEnd);
  _commitOpenEdit=()=>finish(true);
}
// ---- Formula function autocomplete: Excel-style "=SU" suggests SUM(...) while typing ----
let _formulaAC = null;   // { el, matches, replaceStart, replaceEnd, activeIndex, textEl, nodeId }
function _caretTextOffset(el){
  const sel=window.getSelection();
  if(!sel.rangeCount) return (el.textContent||'').length;
  const range=sel.getRangeAt(0);
  const pre=range.cloneRange();
  pre.selectNodeContents(el);
  pre.setEnd(range.endContainer, range.endOffset);
  return pre.toString().length;
}
function _setCaretTextOffset(el, offset){
  const sel=window.getSelection();
  const range=document.createRange();
  let remaining=offset, node=null, foundOffset=0;
  const walker=document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
  while(walker.nextNode()){
    const tn=walker.currentNode;
    if(remaining<=tn.textContent.length){ node=tn; foundOffset=remaining; break; }
    remaining-=tn.textContent.length;
  }
  if(node) range.setStart(node, foundOffset);
  else { range.selectNodeContents(el); range.collapse(false); sel.removeAllRanges(); sel.addRange(range); return; }
  range.collapse(true);
  sel.removeAllRanges(); sel.addRange(range);
}
// Pure trigger-detection: are we, right now, in a position where a function name could
// start (right after "=", an operator, "(", "," or whitespace, inside a formula)? Returns
// the partial name typed so far and where to splice in the chosen suggestion.
function detectFormulaAutocompleteTrigger(text, caretOffset){
  if(!text.trimStart().startsWith('=')) return null;
  const before=text.slice(0, caretOffset);
  const m=before.match(/(?:^|[=+\-*/%^(,\s])([A-Za-z]{0,20})$/);
  if(!m) return null;
  const partial=m[1];
  return { partial, replaceStart:caretOffset-partial.length, replaceEnd:caretOffset };
}
function closeFormulaAutocomplete(){
  if(_formulaAC){ _formulaAC.el.remove(); _formulaAC=null; }
}
function _renderFormulaAcActive(){
  if(!_formulaAC) return;
  [..._formulaAC.el.children].forEach((row,i)=>row.classList.toggle('active', i===_formulaAC.activeIndex));
  const activeRow=_formulaAC.el.children[_formulaAC.activeIndex];
  if(activeRow) activeRow.scrollIntoView({block:'nearest'});
}
function _insertFormulaSuggestion(){
  if(!_formulaAC) return;
  const f=_formulaAC.matches[_formulaAC.activeIndex]; if(!f) return;
  const {textEl, replaceStart, replaceEnd, nodeId}=_formulaAC;
  const text=textEl.textContent||'';
  const insertion = f.name==='PI' ? f.name : f.name+'(';   // PI is a bare constant, no parens
  const newText = text.slice(0,replaceStart)+insertion+text.slice(replaceEnd);
  textEl.textContent=newText;
  _setCaretTextOffset(textEl, replaceStart+insertion.length);
  closeFormulaAutocomplete();
  textEl.focus();
  relayoutDuringEdit(nodeId);
}
function updateFormulaAutocomplete(textEl, nodeId){
  const text=textEl.textContent||'';
  const caret=_caretTextOffset(textEl);
  const trig=detectFormulaAutocompleteTrigger(text, caret);
  if(!trig){ closeFormulaAutocomplete(); return; }
  const partial=trig.partial.toUpperCase();
  const matches=FORMULA_FUNC_INFO.filter(f=>f.name.startsWith(partial)).slice(0,8);
  if(!matches.length){ closeFormulaAutocomplete(); return; }
  if(!_formulaAC){
    const pop=document.createElement('div'); pop.className='formula-ac';
    document.body.appendChild(pop);
    _formulaAC = { el:pop, matches:[], replaceStart:0, replaceEnd:0, activeIndex:0, textEl, nodeId };
  }
  _formulaAC.matches=matches; _formulaAC.replaceStart=trig.replaceStart; _formulaAC.replaceEnd=trig.replaceEnd; _formulaAC.activeIndex=0;
  _formulaAC.textEl=textEl; _formulaAC.nodeId=nodeId;
  _formulaAC.el.innerHTML='';
  matches.forEach(f=>{
    const row=document.createElement('div'); row.className='formula-ac-row';
    row.innerHTML='<span class="formula-ac-sig">'+f.sig+'</span><span class="formula-ac-desc">'+escapeHtml(rmsTr('fx_'+f.name, f.desc))+'</span>';
    row.addEventListener('mousedown', e=>{ e.preventDefault(); _insertFormulaSuggestion(); });
    _formulaAC.el.appendChild(row);
  });
  _renderFormulaAcActive();
  positionPopup(_formulaAC.el, textEl);
}
// Called first from the editing keydown handler; returns true if it handled the key
// (so the caller should stop — e.g. Enter selects a suggestion instead of finishing the edit).
function formulaAutocompleteKeydown(e){
  if(!_formulaAC) return false;
  if(isImeEvent(e)) return false;
  if(e.key==='ArrowDown'){ e.preventDefault(); _formulaAC.activeIndex=Math.min(_formulaAC.matches.length-1, _formulaAC.activeIndex+1); _renderFormulaAcActive(); return true; }
  if(e.key==='ArrowUp'){ e.preventDefault(); _formulaAC.activeIndex=Math.max(0, _formulaAC.activeIndex-1); _renderFormulaAcActive(); return true; }
  if(e.key==='Tab' || e.key==='Enter'){ e.preventDefault(); _insertFormulaSuggestion(); return true; }
  if(e.key==='Escape'){ closeFormulaAutocomplete(); return true; }
  return false;
}
// IME (Pinyin / 中文 etc.): the first keydown of a composition often has
// isComposing=false; keyCode 229 / key "Process" mark an active IME.
function isImeEvent(e){
  return !!(e && (e.isComposing || e.keyCode===229 || e.key==='Process'));
}
// Optional overrides injected by the Roc Mind Spark shell (window.__RMS_SHORTCUTS__).
// Absent in the plain browser — callers pass the original default as the last arg.
function specMatches(spec, e){
  if(!spec || !e) return false;
  const want = String(spec.key||'').toLowerCase();
  const code = spec.code||'';
  const key = e.key||'';
  const eCode = e.code||'';
  const keyOk = (code && eCode===code)
    || (want && key.toLowerCase()===want)
    || (want==='/' && key==='?')
    || ((want==='enter' || code==='Enter') && (key==='Enter' || eCode==='Enter' || eCode==='NumpadEnter'))
    || ((want===' ' || code==='Space') && (key===' ' || eCode==='Space'));
  if(!keyOk) return false;
  return !!spec.meta===!!e.metaKey
      && !!spec.ctrl===!!e.ctrlKey
      && !!spec.alt===!!e.altKey
      && !!spec.shift===!!e.shiftKey;
}
function rms(name, e, fallback){
  const spec = (typeof window!=='undefined' && window.__RMS_SHORTCUTS__) ? window.__RMS_SHORTCUTS__[name] : null;
  if(!spec) return !!fallback;
  const specs = Array.isArray(spec) ? spec : [spec];
  return specs.some(s => specMatches(s, e));
}
function rmsTr(key, fallback){
  if(typeof window!=='undefined' && typeof window.rmsT==='function'){
    const s=window.rmsT(key);
    if(s && s!==key) return s;
  }
  return fallback!=null ? fallback : key;
}
// rmsTr + fill each %s in order. A replacer function keeps `$&` etc. literal.
function rmsTf(key, fallback, ...args){
  let s=rmsTr(key, fallback);
  for(const a of args) s=s.replace('%s', ()=>String(a));
  return s;
}
// rmsTr, HTML-escaped — for dictionary strings dropped into template literals.
function rmsTh(key, fallback){ return escapeHtml(rmsTr(key, fallback)); }
// Built-in layouts / map styles / presets carry English name+desc as data.
function layoutName(l){ return l ? (l.id ? rmsTr('layoutName_'+l.id, l.name) : l.name) : ''; }
function layoutDesc(l){ return l ? (l.id ? rmsTr('layoutDesc_'+l.id, l.desc||'') : (l.desc||'')) : ''; }
function chordTitle(nameKey, chordId, fallback){
  const name=rmsTr(nameKey, fallback);
  const chord=(typeof window!=='undefined' && window.rmsChordLabel && chordId) ? window.rmsChordLabel(chordId) : '';
  return chord ? name+' ('+chord+')' : name;
}
// Bottom tips bar: keys come from the current (rebindable) chords.
function hintBarHtml(){
  const tpl=rmsTr('hintTpl', '<b>⌘+drag</b> box-select · <b>drag</b> move / nest / reorder · <b>{child}</b> child · <b>{sibling}</b> sibling · <b>↑↓←→</b> navigate · <b>{edit}</b>/dbl-click edit · <b>{link}</b> link · <b>{del}</b> remove · <b>{help}</b> all shortcuts');
  const kb=(id, def)=>{
    const label=(typeof window!=='undefined' && window.rmsChordLabel) ? window.rmsChordLabel(id) : '';
    return escapeHtml(label || def);
  };
  let html=tpl
    .replace('{child}', kb('addChild','Tab'))
    .replace('{sibling}', kb('addSibling','Enter'))
    .replace('{edit}', kb('editNode','F2'))
    .replace('{link}', kb('link','L'))
    .replace('{del}', kb('deleteNode','Del'))
    .replace('{help}', kb('help','?').replace(/^⇧ \/$/, '?'));
  const native=(typeof window!=='undefined' && window.__RMS_NATIVE__) || null;
  if(native && native.toggleDisplay){
    html+=rmsTr('hintToggle',' · <b>{toggle}</b> show / hide').replace('{toggle}', escapeHtml(native.toggleDisplay));
  }
  return html;
}
function renderHintBar(){
  const box=document.getElementById('hintText');
  if(box) box.innerHTML=hintBarHtml();
}
if(typeof window!=='undefined') window.rmsRenderHint=renderHintBar;
function refreshLocaleChrome(){
  if(typeof window.rmsApplyI18n==='function') window.rmsApplyI18n();
  renderHintBar();
  const save=$('#saveText');
  if(save) updateMapSaveStatus();
  if(typeof sel!=='undefined' && sel && typeof positionNodeBar==='function') positionNodeBar();
  if(typeof multiSel!=='undefined' && multiSel.size>=2 && typeof showBulkBar==='function') showBulkBar();
  if(typeof refreshList==='function' && $('#mapList')) refreshList();
  const search=$('#search');
  if(search && typeof globalSearchMode!=='undefined'){
    search.placeholder = globalSearchMode
      ? rmsTr('searchAllPlaceholder','Search ALL maps…')
      : rmsTr('findPlaceholder','Find in nodes…');
  }
  const exit=$('#focusExit');
  if(exit){
    exit.textContent='⛶ '+rmsTr('focusExit','Exit focus');
    exit.title=rmsTr('focusExitTitle','Exit focus mode (Esc)');
  }
  if(typeof ensureMdPane==='function' && document.getElementById('mdPane')) applyMdPaneI18n();
  document.querySelectorAll('.h-child').forEach(h=>{ h.title=chordTitle('handleChild','addChild','Add child'); });
  document.querySelectorAll('.h-sibling').forEach(h=>{ h.title=chordTitle('handleSibling','addSibling','Add sibling'); });
  document.querySelectorAll('.resize-grip').forEach(h=>{ h.title=rmsTr('dragResize','Drag to resize'); });
  if(typeof syncAddSiblingBtn==='function') syncAddSiblingBtn();
}
// IME confirm Enter often arrives AFTER compositionend, with isComposing
// already false. Swallow that one key; a later Enter is a real shortcut.
const IME_CONFIRM_MS=80;
let _imeConfirmUntil=0;
function nowMs(){
  return (typeof performance!=='undefined' && performance.now) ? performance.now() : Date.now();
}
function markImeCompositionEnd(){
  _imeConfirmUntil=nowMs()+IME_CONFIRM_MS;
}
function clearImeConfirmEnter(){
  _imeConfirmUntil=0;
}
function isImeConfirmEnter(e){
  if(!e || e.key!=='Enter') return false;
  return nowMs()<_imeConfirmUntil;
}
// Bare Enter saves and adds a sibling, unless the IME is confirming a candidate
// or the user asked for a newline with Shift+Enter.
function shouldFinishNodeEditOnEnter(e){
  if(!e || e.key!=='Enter' || e.shiftKey || e.altKey) return false;
  if(typeof isImeEvent==='function' && isImeEvent(e)) return false;
  if(isImeConfirmEnter(e)) return false;
  return true;
}
// While editing a node title:
//   Tab            -> commit, add a child, start editing it
//   Enter          -> commit, add a sibling, start editing it
//   Ctrl/⌘+Enter   -> same sibling action (kept as an alias)
// Shift+Enter stays a newline. IME Enter is not this function's job.
function editSessionCreateAction(e){
  if(!e) return null;
  if(typeof isImeEvent==='function' && isImeEvent(e)) return null;
  if(typeof isImeConfirmEnter==='function' && isImeConfirmEnter(e)) return null;
  const hit = (name, fallback) => (typeof rms==='function') ? rms(name, e, fallback) : !!fallback;
  if(hit('addChild', e.key==='Tab' && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey)) return 'child';
  if(hit('addSibling', e.key==='Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey)) return 'sibling';
  if(hit('addSiblingMod', e.key==='Enter' && (e.ctrlKey||e.metaKey) && !e.shiftKey && !e.altKey)) return 'sibling';
  return null;
}
// Caps Lock remapped to Hyper (⌘+Ctrl+Alt+Shift), then Space — and
// Ctrl/⌘/Alt+Space. Page handlers must not preventDefault these.
function isImeSwitchEvent(e){
  if(!e) return false;
  if(e.key==='CapsLock' || e.code==='CapsLock') return true;
  if(e.key==='Lang1' || e.key==='Lang2' || e.code==='Lang1' || e.code==='Lang2') return true;
  const space = e.key===' ' || e.code==='Space';
  if(space && (e.ctrlKey || e.metaKey || e.altKey)) return true;
  if(e.ctrlKey && e.metaKey && e.altKey && e.shiftKey) return true;
  return false;
}
// Other sites do not tear down the text field on a random blur. Only commit
// when the user actually pointed outside the editor, or a command asked us to.
let _editBlurShouldCommit=false;
function armEditBlurCommit(){ _editBlurShouldCommit=true; }
function consumeEditBlurCommit(){
  const v=_editBlurShouldCommit;
  _editBlurShouldCommit=false;
  return v;
}
function shouldCommitEditOnBlur({composing, activeInside, pointerOutside}){
  if(composing) return false;
  if(activeInside) return false;
  if(!pointerOutside) return false;
  return true;
}
// Clicking another node (or the canvas) must save the open editor. Toolbar /
// picker / the editor itself are not a click-away.
function shouldCommitEditOnPointerTarget(target, editingEl){
  if(!editingEl || !target) return false;
  if(typeof editingEl.contains==='function' && editingEl.contains(target)) return false;
  if(typeof isEditSessionChrome==='function' && isEditSessionChrome(target)) return false;
  return true;
}
function shouldCommitEditOnEscape(e){
  if(!e || e.key!=='Escape') return false;
  if(e.isComposing || e.keyCode===229) return false;
  return true;
}
let _commitOpenEdit=null;
function commitOpenEdit(){
  if(typeof _commitOpenEdit!=='function') return false;
  _commitOpenEdit();
  return true;
}
function isEditSessionChrome(ae){
  if(!ae || typeof ae.closest !== 'function') return false;
  if(typeof document!=='undefined' && (ae===document.body || ae===document.documentElement)) return false;
  return !!ae.closest('.node.editing, .edit-float, .nodebar, .formula-ac, .picker');
}
function editSessionUndoAction(e){
  if(!e || e.altKey) return null;
  if(!(e.metaKey || e.ctrlKey)) return null;
  const k=(e.key||'').toLowerCase();
  const code=e.code||'';
  if((k==='z' || code==='KeyZ') && e.shiftKey) return 'redo';
  if(k==='y' || code==='KeyY') return 'redo';
  if(k==='z' || code==='KeyZ') return 'undo';
  return null;
}
// Cmd/Ctrl+C/X/V/A must stay with the open editor. Native clipboard inside a
// contentEditable span under #viewport's CSS transform is unreliable in
// WKWebView, and dictation tools (Typeless) insert by synthesizing Cmd+V —
// often after their overlay has stolen focus from the node.
function clipboardEditAction(e){
  if(!e || e.altKey) return null;
  if(!(e.metaKey || e.ctrlKey)) return null;
  const k = (e.key || '').toLowerCase();
  const code = e.code || '';
  const is = (letter, keyCode) => k === letter || code === keyCode;
  if(is('c', 'KeyC') && !e.shiftKey) return 'copy';
  if(is('x', 'KeyX') && !e.shiftKey) return 'cut';
  if(is('v', 'KeyV')) return 'paste';
  if(is('a', 'KeyA') && !e.shiftKey) return 'selectAll';
  return null;
}
function shouldHandleEditorTextPaste({ imageFile, text }){
  if(imageFile) return false;
  return !!(text && String(text).length);
}
function clipboardPlainText(dt){
  if(!dt || typeof dt.getData !== 'function') return '';
  let plain = '';
  try{ plain = dt.getData('text/plain') || dt.getData('text') || ''; }catch(_){}
  if(plain) return plain;
  let html = '';
  try{ html = dt.getData('text/html') || ''; }catch(_){}
  if(!html || typeof DOMParser === 'undefined') return '';
  try{
    // Inert parse: a DOMParser document has no browsing context, so clipboard HTML
    // like <img src=x onerror=…> never loads or runs (a live <div> would).
    const doc = new DOMParser().parseFromString(html, 'text/html');
    return ((doc.body && doc.body.textContent) || '').replace(/\u00A0/g, ' ');
  }catch(_){ return ''; }
}
function nodeClipboardPlain(n){
  if(!n) return '';
  return String(n.text || '').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/\u00A0/g, ' ').trim();
}
function isAppTextField(ae){
  if(!ae) return false;
  if(ae.closest && ae.closest('.node.editing, .edit-float, .notes-popup')) return false;
  const tag = ae.tagName;
  if(tag === 'INPUT' || tag === 'TEXTAREA') return true;
  if(ae.isContentEditable) return true;
  return false;
}
function openOverlayTextField(){
  if(typeof document === 'undefined' || !document.querySelector) return null;
  const ae = document.activeElement;
  if(ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA')){
    if(ae.id === 'mapTitle') return ae;
    if(ae.closest && ae.closest('.picker, .var-form, .bp-panel, .rms-settings, .search-wrap')) return ae;
  }
  // WK overlay: native Cmd+V never focuses the field. A visible picker /
  // citation form still owns paste — not the selected node.
  return document.querySelector('.picker input, .picker textarea, .var-form input, .var-form textarea');
}
function overlayTextFieldOwnsClipboard(){
  if(openOverlayTextField()) return true;
  return !!focusedValueField();
}
function isValueTextField(el){
  if(!el) return false;
  if(el.id==='mdEditor') return true;
  const tag=el.tagName;
  return tag==='INPUT' || tag==='TEXTAREA';
}
function focusedValueField(){
  if(typeof document==='undefined') return null;
  const ae=document.activeElement;
  if(!ae || !isValueTextField(ae)) return null;
  if(typeof isAppTextField==='function' && !isAppTextField(ae)) return null;
  return ae;
}
function fieldSelectedText(el){
  if(!el) return '';
  if(isValueTextField(el)){
    const v=el.value||'';
    const a=el.selectionStart, b=el.selectionEnd;
    if(a!=null && b!=null && b>a) return v.slice(a, b);
    return '';
  }
  return typeof editorSelectedText==='function' ? editorSelectedText(el) : '';
}
function fieldCutSelected(el){
  if(!el || !isValueTextField(el)) return '';
  const text=fieldSelectedText(el);
  if(!text) return '';
  const v=el.value||'';
  const a=el.selectionStart, b=el.selectionEnd;
  el.value=v.slice(0, a)+v.slice(b);
  try{ el.setSelectionRange(a, a); }catch(_){}
  if(typeof emitEditorInput==='function') emitEditorInput(el);
  return text;
}
function insertFieldText(el, text){
  if(!el || el.readOnly) return false;
  const str = String(text == null ? '' : text);
  try{ if(typeof el.focus === 'function') el.focus(); }catch(_){}
  if(el.id!=='mdEditor' && el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA'){
    return typeof insertEditorText === 'function' ? insertEditorText(el, str, false) : false;
  }
  const v = el.value || '';
  let start = el.selectionStart;
  let end = el.selectionEnd;
  const unfocused = typeof document !== 'undefined' && document.activeElement !== el;
  if(start == null || end == null || (unfocused && start === end)){
    start = 0;
    end = v.length;
  }
  el.value = v.slice(0, start) + str + v.slice(end);
  const caret = start + str.length;
  try{ if(typeof el.setSelectionRange === 'function') el.setSelectionRange(caret, caret); }catch(_){}
  if(typeof emitEditorInput === 'function') emitEditorInput(el);
  return true;
}
function overlayFieldCopyPayload(el){
  if(!el) return '';
  const v = el.value || '';
  const start = el.selectionStart, end = el.selectionEnd;
  if(start != null && end != null && end > start) return v.slice(start, end);
  return v;
}
function openNotesEditorEl(){
  if(typeof document === 'undefined' || !document.querySelector) return null;
  return document.querySelector('.notes-popup .np-editor');
}
function openClipboardTarget(){
  return openNotesEditorEl() || ((typeof pendingNodeTyping==='function' && pendingNodeTyping()) ? null : openEditorTextEl());
}
function shouldTakeNodeClipboard(){
  if(typeof openOverlayTextField==='function' && openOverlayTextField()) return false;
  if(openClipboardTarget()) return true;
  if(typeof document !== 'undefined' && isAppTextField(document.activeElement)) return false;
  if(typeof multiSel!=='undefined' && multiSel && multiSel.size>=2
     && typeof map!=='undefined' && map && map.nodes) return true;
  if(typeof sel === 'undefined' || !sel) return false;
  if(typeof map === 'undefined' || !map || !map.nodes || !map.nodes[sel]) return false;
  return true;
}
function editorCopyPayload({ selectedText, allText, selectAllPending }){
  const picked = String(selectedText || '');
  if(picked) return picked;
  if(selectAllPending) return String(allText || '');
  return '';
}
function openEditorTextEl(){
  if(typeof _editFloat!=='undefined' && _editFloat) return editFloatLiveTextEl(_editFloat);
  if(typeof document === 'undefined' || !document.querySelector) return null;
  const el = document.querySelector('.node.editing');
  if(!el) return null;
  return (el.querySelector && (el.querySelector('.node-text') || el.querySelector('.node-block'))) || el;
}
// WKWebView maps mouse-to-caret through a CSS transform with a lag.
// Lift the editor onto #stage (outside #viewport) and size it by font/padding
// * view.k — never transform:scale the editor itself. Position is
// view.x/y + offset*k, the same matrix the viewport uses to paint the node.
let _liveEditing=false;
let _editFloat=null;
let _editTyped=false;
function _csPx(cs, key, k){
  const n=parseFloat(cs[key]);
  return (isFinite(n)?n:0)*(k||1);
}
function editFloatStagePos(viewObj, el){
  const v=viewObj||{x:0,y:0,k:1};
  const k=v.k||1;
  return {left:(v.x||0)+(el && el.offsetLeft || 0)*k, top:(v.y||0)+(el && el.offsetTop || 0)*k};
}
function editFloatStyleScale(){
  return (typeof view!=='undefined' && view && view.k)||1;
}
function editFloatViewportPos(el, scale){
  if(!el || typeof el.getBoundingClientRect!=='function') return {left:0, top:0};
  const r=el.getBoundingClientRect();
  const z=(scale!=null && scale>0)?scale:1;
  return {left:r.left*z, top:r.top*z};
}
function nodeEditMaxWidthPx(el, n){
  if(n && isFinite(n.width) && n.width>0) return n.width;
  if(el && typeof getComputedStyle==='function'){
    const cs=getComputedStyle(el);
    const m=parseFloat(cs.maxWidth);
    if(isFinite(m) && m>0) return m;
  }
  return 240;
}
function editFloatWidthStyle(usedPx, maxPx, k){
  const scale=(k!=null && k>0)?k:1;
  const cap=(Number(maxPx)||240)*scale;
  const used=Number(usedPx)||0;
  const maxMap=Number(maxPx)||240;
  if(used>=maxMap-0.5){
    return {width:cap+'px', maxWidth:cap+'px'};
  }
  return {width:'max-content', maxWidth:cap+'px'};
}
function styleEditFloat(el){
  if(!_editFloat || !el || typeof getComputedStyle!=='function') return;
  const k=editFloatStyleScale();
  const cs=getComputedStyle(el);
  const float=_editFloat;
  const lh=cs.lineHeight;
  const n=(typeof map!=='undefined' && map && map.nodes && el.dataset)
    ? map.nodes[el.dataset.id] : null;
  float.style.transform='none';
  float.style.background=cs.backgroundColor;
  float.style.color=cs.color;
  float.style.fontFamily=cs.fontFamily;
  float.style.fontSize=_csPx(cs,'fontSize',k)+'px';
  float.style.fontWeight=cs.fontWeight;
  float.style.lineHeight=(lh && lh!=='normal' && !lh.endsWith('%')) ? (parseFloat(lh)*k)+'px' : lh;
  float.style.textAlign=cs.textAlign;
  float.style.justifyContent=cs.justifyContent;
  float.style.paddingTop=_csPx(cs,'paddingTop',k)+'px';
  float.style.paddingRight=_csPx(cs,'paddingRight',k)+'px';
  float.style.paddingBottom=_csPx(cs,'paddingBottom',k)+'px';
  float.style.paddingLeft=_csPx(cs,'paddingLeft',k)+'px';
  float.style.borderRadius=cs.borderRadius;
  float.style.border=cs.border;
  float.style.whiteSpace=cs.whiteSpace || 'pre-wrap';
  float.style.wordBreak=cs.wordBreak || 'break-word';
  float.style.overflowWrap=cs.overflowWrap || cs.wordWrap || 'break-word';
  float.style.minWidth='0';
  float.style.boxSizing='border-box';
  const maxPx=nodeEditMaxWidthPx(el, n);
  const sized=editFloatWidthStyle(el.offsetWidth||0, maxPx, k);
  float.style.maxWidth=sized.maxWidth;
  float.style.width=sized.width;
}
function placeEditFloat(el){
  if(!_editFloat || !el) return;
  const pos=editFloatStagePos(typeof view!=='undefined' ? view : {x:0,y:0,k:1}, el);
  _editFloat.style.left=pos.left+'px';
  _editFloat.style.top=pos.top+'px';
}
function syncEditFloat(){
  if(!_editFloat) return;
  const id=_editFloat.dataset && _editFloat.dataset.nodeId;
  const el=(typeof document!=='undefined' && document.querySelector)
    ? ((id && document.querySelector(`.node[data-id="${id}"]`)) || document.querySelector('.node.editing'))
    : null;
  if(!el){ discardEditOverlay(); return; }
  styleEditFloat(el);
  placeEditFloat(el);
}
function discardEditOverlay(){
  if(_editFloat){
    try{ _editFloat.remove(); }catch(_){}
    _editFloat=null;
  }
  if(typeof document!=='undefined' && document.querySelectorAll){
    document.querySelectorAll('.edit-float').forEach(n=>{ try{n.remove();}catch(_){} });
    document.querySelectorAll('.node.edit-placeholder').forEach(n=>{
      if(n.classList && n.classList.remove) n.classList.remove('edit-placeholder');
    });
  }
  if(typeof closeFormulaAutocomplete==='function') closeFormulaAutocomplete();
  _liveEditing=false;
}
// Close an in-progress node edit without writing the draft. Used when ⌘Z
// should undo the map (add node, drop) rather than WebKit's editor stack.
function cancelOpenEdit(){
  _commitOpenEdit=null;
  const el = typeof document!=='undefined' && document.querySelector && document.querySelector('.node.editing');
  if(el){
    const textEl=el.querySelector('.node-text')||el.querySelector('.node-block');
    if(typeof discardEditOverlay==='function') discardEditOverlay();
    el.classList.remove('editing');
    if(textEl && typeof disarmEditorHost==='function') disarmEditorHost(textEl);
  } else if(typeof discardEditOverlay==='function'){
    discardEditOverlay();
  }
  _liveEditing=false;
  _editTyped=false;
  if(typeof clearEditReplaceAll==='function') clearEditReplaceAll();
}
function editFloatLiveTextEl(float){
  if(!float) return null;
  if(float.querySelector){
    const body=float.querySelector('.edit-float-text');
    if(body) return body;
  }
  return float;
}
function nodeEditChromeClone(el){
  const wrap=document.createElement('span');
  wrap.className='edit-float-chrome';
  wrap.setAttribute('contenteditable','false');
  wrap.setAttribute('aria-hidden','true');
  if(!el || !el.querySelectorAll) return wrap;
  el.querySelectorAll('.node-marker, .task-check').forEach(n=>{
    wrap.appendChild(n.cloneNode(true));
  });
  return wrap;
}
function mountEditFloat(el, textEl){
  if(!el || !textEl || typeof document==='undefined') return textEl;
  if(!document.documentElement.classList.contains('rms-wk')) return textEl;
  unmountEditFloat(el, textEl);
  const float=document.createElement('div');
  float.className='edit-float';
  float.dataset.nodeId=el.dataset.id||'';
  const chrome=nodeEditChromeClone(el);
  const body=document.createElement('span');
  body.className='edit-float-text node-text';
  body.innerHTML=textEl.innerHTML;
  if(chrome.childNodes.length) float.appendChild(chrome);
  float.appendChild(body);
  // Park on #stage, outside #viewport's camera transform. Font size carries
  // view.k so the clone matches the card without a CSS transform on the editor.
  (stage||document.body).appendChild(float);
  _editFloat=float;
  el.classList.add('edit-placeholder');
  styleEditFloat(el);
  placeEditFloat(el);
  armEditorHost(body);
  return body;
}
function unmountEditFloat(el, textEl){
  if(!_editFloat) return;
  const live=editFloatLiveTextEl(_editFloat);
  if(textEl && live) textEl.innerHTML=live.innerHTML;
  if(el && el.classList && el.classList.remove) el.classList.remove('edit-placeholder');
  discardEditOverlay();
}
let _editReplaceAll = false;
function armEditReplaceAll(){ _editReplaceAll = true; }
function peekEditReplaceAll(){ return _editReplaceAll; }
function clearEditReplaceAll(){ _editReplaceAll = false; }
function emitEditorInput(textEl){
  if(!textEl || typeof textEl.dispatchEvent !== 'function') return;
  try{ textEl.dispatchEvent(new Event('input', { bubbles: true })); }catch(_){}
}
function editorSelectedText(textEl){
  if(!textEl) return '';
  if(textEl.tagName==='TEXTAREA' || textEl.tagName==='INPUT'){
    const v=textEl.value||'';
    const a=textEl.selectionStart, b=textEl.selectionEnd;
    if(a!=null && b!=null && b>a) return v.slice(a, b);
    return '';
  }
  if(typeof window === 'undefined' || !window.getSelection) return '';
  const wsel = window.getSelection();
  if(!wsel || !wsel.rangeCount || wsel.isCollapsed) return '';
  if(!textEl.contains(wsel.anchorNode) && wsel.anchorNode !== textEl && !textEl.contains(wsel.focusNode)) return '';
  return wsel.toString();
}
function selectEditorContents(textEl){
  if(!textEl || typeof document === 'undefined') return;
  try{
    if(typeof textEl.focus === 'function') textEl.focus();
    if((textEl.tagName==='TEXTAREA' || textEl.tagName==='INPUT') && typeof textEl.select === 'function'){
      textEl.select();
      return;
    }
    const range = document.createRange();
    range.selectNodeContents(textEl);
    const wsel = window.getSelection();
    wsel.removeAllRanges();
    wsel.addRange(range);
  }catch(_){}
}
function writeClipboardText(text){
  const str = String(text == null ? '' : text);
  try{
    if(typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText){
      const p = navigator.clipboard.writeText(str);
      if(p && typeof p.catch === 'function') p.catch(()=>{});
      return true;
    }
  }catch(_){}
  return false;
}
function cutEditorSelection(textEl, replaceAll){
  if(!textEl) return;
  if(replaceAll){ textEl.textContent = ''; return; }
  if(typeof execCmd === 'function' && execCmd('delete')) return;
  try{
    const wsel = window.getSelection();
    if(wsel && wsel.rangeCount && !wsel.isCollapsed && wsel.deleteFromDocument) wsel.deleteFromDocument();
  }catch(_){}
}
function insertEditorText(textEl, text, replaceAll){
  if(!textEl) return false;
  const str = String(text == null ? '' : text);
  try{ if(typeof textEl.focus === 'function') textEl.focus(); }catch(_){}
  if(replaceAll) selectEditorContents(textEl);
  if(typeof execCmd === 'function' && execCmd('insertText', str)) return true;
  if(replaceAll){
    textEl.textContent = str;
    try{
      const range = document.createRange();
      range.selectNodeContents(textEl);
      range.collapse(false);
      const wsel = window.getSelection();
      wsel.removeAllRanges();
      wsel.addRange(range);
    }catch(_){}
    return true;
  }
  try{
    const wsel = window.getSelection();
    if(wsel && wsel.rangeCount){
      const range = wsel.getRangeAt(0);
      range.deleteContents();
      const node = document.createTextNode(str);
      range.insertNode(node);
      range.setStartAfter(node);
      range.collapse(true);
      wsel.removeAllRanges();
      wsel.addRange(range);
      return true;
    }
  }catch(_){}
  textEl.textContent = (textEl.textContent || '') + str;
  return true;
}
function onEditorClipboardKeydown(e){
  const act = clipboardEditAction(e);
  if(!act) return;
  if(typeof openOverlayTextField==='function' && openOverlayTextField()) return;
  const textEl = openEditorTextEl();
  // Never preventDefault copy/cut on keydown. That cancels the copy/cut
  // event; WKWebView then has nowhere to write. The copy/cut listeners
  // write clipboardData, which does not need navigator.clipboard.
  if(act === 'selectAll'){
    // A prepared-but-untouched WK typing host is not an open editor.
    if(!textEl || (typeof pendingNodeTyping==='function' && pendingNodeTyping())){
      if(typeof selectAllNodesOnCanvas==='function' && selectAllNodesOnCanvas()){
        e.preventDefault();
        e.stopPropagation();
      }
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    selectEditorContents(textEl);
    return;
  }
  if(act === 'copy' || act === 'cut'){
    if(textEl && act === 'copy' && peekEditReplaceAll()) selectEditorContents(textEl);
    return;
  }
  if(act === 'paste' && textEl){
    try{ if(typeof textEl.focus === 'function') textEl.focus(); }catch(_){}
    if(peekEditReplaceAll()) selectEditorContents(textEl);
  }
}
function editorClipboardPayload(textEl){
  if(textEl){
    if(typeof rememberNodeClip==='function') rememberNodeClip(null);
    return editorCopyPayload({
      selectedText: editorSelectedText(textEl),
      allText: textEl.value != null && textEl.tagName === 'TEXTAREA' ? textEl.value : (textEl.textContent || ''),
      selectAllPending: peekEditReplaceAll()
    });
  }
  if(typeof nodeSelectionClipboard==='function'){
    const c=nodeSelectionClipboard();
    if(c.text) return c.text;
  }
  if(typeof selectionMarkdownPayload==='function'){
    const md=selectionMarkdownPayload();
    if(md) return md;
  }
  if(typeof map !== 'undefined' && map && map.nodes && typeof sel !== 'undefined' && map.nodes[sel]){
    return nodeClipboardPlain(map.nodes[sel]);
  }
  return '';
}
function onEditorCopyCut(e, isCut){
  if(!shouldTakeNodeClipboard()) return;
  const textEl = openEditorTextEl();
  const payload = editorClipboardPayload(textEl);
  if(!payload) return;
  if(e.clipboardData){
    try{ e.clipboardData.setData('text/plain', payload); }catch(_){}
    if(!textEl && typeof lastNodeClipFor==='function'){
      const clip=lastNodeClipFor(payload);
      if(clip) try{ e.clipboardData.setData(NODE_CLIP_MIME, JSON.stringify(clip)); }catch(_){}
    }
    e.preventDefault();
  } else {
    writeClipboardText(payload);
    if(e && e.preventDefault) e.preventDefault();
  }
  if(isCut && textEl){
    cutEditorSelection(textEl, peekEditReplaceAll());
    clearEditReplaceAll();
    emitEditorInput(textEl);
  }
}
function onEditorPaste(e){
  if(typeof READONLY !== 'undefined' && READONLY) return;
  const overlay = typeof openOverlayTextField==='function' ? openOverlayTextField() : null;
  if(overlay){
    if(typeof document !== 'undefined' && document.activeElement === overlay) return;
    const dt = e && e.clipboardData;
    const text = clipboardPlainText(dt);
    if(!text) return;
    if(e && e.preventDefault) e.preventDefault();
    insertFieldText(overlay, text);
    return;
  }
  if(typeof document !== 'undefined' && isAppTextField(document.activeElement) && !openClipboardTarget()) return;
  const dt = e && e.clipboardData;
  const imageFile = typeof firstImageFile === 'function' ? firstImageFile(dt) : null;
  const text = clipboardPlainText(dt);
  if(!shouldHandleEditorTextPaste({ imageFile, text })) return;
  const textEl = openClipboardTarget();
  if(textEl){
    e.preventDefault();
    const inNotes = !!(textEl.closest && textEl.closest('.notes-popup'));
    insertEditorText(textEl, text, inNotes ? false : peekEditReplaceAll());
    if(!inNotes) clearEditReplaceAll();
    emitEditorInput(textEl);
    return;
  }
  if(typeof sel === 'undefined' || !sel || typeof map === 'undefined' || !map || !map.nodes || !map.nodes[sel]) return;
  if(typeof pasteNodesAsChildren === 'function'){
    let clip=null;
    try{ const raw=dt && dt.getData ? dt.getData(NODE_CLIP_MIME) : ''; if(raw) clip=JSON.parse(raw); }catch(_){ clip=null; }
    if(pasteNodesAsChildren(text, clip)){ e.preventDefault(); return; }
  }
  if(map.nodes[sel].hr || map.nodes[sel].html) return;
  e.preventDefault();
  if(typeof startEdit === 'function'){
    startEdit(sel);
    const te = openEditorTextEl();
    if(te){
      insertEditorText(te, text, true);
      clearEditReplaceAll();
      emitEditorInput(te);
      return;
    }
  }
  map.nodes[sel].text = String(text).trim() || map.nodes[sel].text;
  map.nodes[sel].updated = Date.now();
  if(typeof pushHistory === 'function') pushHistory();
  if(typeof autoLayout === 'function') autoLayout();
}
function rmsClipboardCopy(){
  const field = typeof openOverlayTextField==='function' ? openOverlayTextField() : null;
  if(field) return overlayFieldCopyPayload(field);
  const valueField = focusedValueField();
  if(valueField) return fieldSelectedText(valueField);
  const target = openClipboardTarget();
  if(target){
    if(typeof rememberNodeClip==='function') rememberNodeClip(null);
    const inNotes = !!(target.closest && target.closest('.notes-popup'));
    const selected = editorSelectedText(target);
    return editorCopyPayload({
      selectedText: selected,
      allText: target.textContent || '',
      selectAllPending: inNotes ? !selected : peekEditReplaceAll()
    }) || '';
  }
  if(typeof nodeSelectionClipboard==='function' && typeof multiSel!=='undefined' && multiSel && multiSel.size>=2){
    const c=nodeSelectionClipboard();
    if(c.text) return c.text;
  }
  if(typeof selectionMarkdownPayload==='function'){
    const md=selectionMarkdownPayload();
    if(md) return md;
  }
  if(!shouldTakeNodeClipboard()) return '';
  return editorClipboardPayload(null) || '';
}
function rmsClipboardCopyImageUrl(){
  if(typeof openClipboardTarget==='function' && openClipboardTarget()) return '';
  if(typeof shouldTakeNodeClipboard==='function' && !shouldTakeNodeClipboard()) return '';
  if(typeof map==='undefined' || !map || !map.nodes || typeof sel==='undefined') return '';
  const n = map.nodes[sel];
  if(!n || !n.image) return '';
  return typeof nodeImageSrc==='function' ? nodeImageSrc(n) : String(n.image);
}
function rmsClipboardCopyPayload(){
  return JSON.stringify({
    text: rmsClipboardCopy() || '',
    image: rmsClipboardCopyImageUrl() || ''
  });
}
function rmsClipboardCut(){
  const field = typeof openOverlayTextField==='function' ? openOverlayTextField() : null;
  if(field){
    const v = field.value || '';
    const start = field.selectionStart, end = field.selectionEnd;
    const hasSelection = start != null && end != null && end > start;
    // A focused field with only a caret: ⌘X cuts nothing, like any text box.
    // The whole-field cut is only for a field that is open but not focused.
    const focused = typeof document!=='undefined' && document.activeElement===field;
    if(!hasSelection && focused) return '';
    const text = overlayFieldCopyPayload(field);
    if(hasSelection){
      field.value = v.slice(0, start) + v.slice(end);
      try{ field.setSelectionRange(start, start); }catch(_){}
    } else {
      field.value = '';
    }
    if(typeof emitEditorInput==='function') emitEditorInput(field);
    return text;
  }
  const valueField = focusedValueField();
  if(valueField) return fieldCutSelected(valueField);
  const text = rmsClipboardCopy();
  const textEl = openClipboardTarget();
  if(textEl && text){
    const inNotes = !!(textEl.closest && textEl.closest('.notes-popup'));
    cutEditorSelection(textEl, inNotes ? false : peekEditReplaceAll());
    if(!inNotes) clearEditReplaceAll();
    emitEditorInput(textEl);
  }
  return text;
}
function rmsClipboardPasteImage(dataUrl){
  if(typeof READONLY !== 'undefined' && READONLY) return false;
  if(typeof overlayTextFieldOwnsClipboard==='function' && overlayTextFieldOwnsClipboard()) return false;
  const str = String(dataUrl == null ? '' : dataUrl);
  if(!str) return false;
  return pasteImageAsChild(null, str);
}
function rmsClipboardPasteImageFile(name){
  if(typeof READONLY !== 'undefined' && READONLY) return false;
  if(typeof overlayTextFieldOwnsClipboard==='function' && overlayTextFieldOwnsClipboard()) return false;
  const fileName = String(name == null ? '' : name);
  if(!fileName) return false;
  return pasteImageAsChild(null, null, fileName);
}
function rmsClipboardPaste(text){
  if(typeof READONLY !== 'undefined' && READONLY) return false;
  const str = String(text == null ? '' : text);
  if(!str) return false;
  const overlay = typeof openOverlayTextField==='function' ? openOverlayTextField() : null;
  if(overlay) return insertFieldText(overlay, str);
  const valueField = focusedValueField();
  if(valueField) return insertFieldText(valueField, str);
  if(typeof document !== 'undefined' && isAppTextField(document.activeElement) && !openClipboardTarget()) return false;
  const textEl = openClipboardTarget();
  if(textEl){
    const inNotes = !!(textEl.closest && textEl.closest('.notes-popup'));
    insertEditorText(textEl, str, inNotes ? false : peekEditReplaceAll());
    if(!inNotes) clearEditReplaceAll();
    emitEditorInput(textEl);
    return true;
  }
  if(typeof sel === 'undefined' || !sel || typeof map === 'undefined' || !map || !map.nodes || !map.nodes[sel]) return false;
  if(typeof pasteNodesAsChildren === 'function' && pasteNodesAsChildren(str, null)) return true;
  if(map.nodes[sel].hr || map.nodes[sel].html) return false;
  if(typeof startEdit === 'function'){
    startEdit(sel);
    const te = openEditorTextEl();
    if(te){
      insertEditorText(te, str, true);
      clearEditReplaceAll();
      emitEditorInput(te);
      return true;
    }
  }
  map.nodes[sel].text = str.trim() || map.nodes[sel].text;
  map.nodes[sel].updated = Date.now();
  if(typeof pushHistory === 'function') pushHistory();
  if(typeof autoLayout === 'function') autoLayout();
  return true;
}
function rmsClipboardSelectAll(){
  const field = typeof openOverlayTextField==='function' ? openOverlayTextField() : null;
  if(field){
    try{ if(typeof field.focus==='function') field.focus(); if(typeof field.select==='function') field.select(); }catch(_){}
    return true;
  }
  const valueField = focusedValueField();
  if(valueField){
    try{ if(typeof valueField.focus==='function') valueField.focus(); if(typeof valueField.select==='function') valueField.select(); }catch(_){}
    return true;
  }
  const textEl = openClipboardTarget();
  if(!textEl) return typeof selectAllNodesOnCanvas==='function' ? selectAllNodesOnCanvas() : false;
  selectEditorContents(textEl);
  return true;
}
function rmsClipboardUndo(){
  return performHistoryChord('undo');
}
function rmsClipboardRedo(){
  return performHistoryChord('redo');
}
if(typeof window !== 'undefined'){
  window.__rmsClipboardCopy = rmsClipboardCopy;
  window.__rmsClipboardCopyPayload = rmsClipboardCopyPayload;
  window.__rmsClipboardCopyImageUrl = rmsClipboardCopyImageUrl;
  window.__rmsClipboardCut = rmsClipboardCut;
  window.__rmsClipboardPaste = rmsClipboardPaste;
  window.__rmsClipboardPasteImage = rmsClipboardPasteImage;
  window.__rmsClipboardPasteImageFile = rmsClipboardPasteImageFile;
  window.__rmsClipboardSelectAll = rmsClipboardSelectAll;
  window.__rmsClipboardUndo = rmsClipboardUndo;
  window.__rmsClipboardRedo = rmsClipboardRedo;
  window.__rmsClipboardWantsText = overlayTextFieldOwnsClipboard;
}
function armEditorHost(textEl){
  if(!textEl) return;
  textEl.setAttribute('contenteditable', 'true');
  textEl.setAttribute('role', 'textbox');
  textEl.setAttribute('aria-multiline', 'true');
  textEl.setAttribute('spellcheck', 'false');
  armEditReplaceAll();
}
function disarmEditorHost(textEl){
  if(!textEl) return;
  textEl.removeAttribute('contenteditable');
  textEl.removeAttribute('role');
  textEl.removeAttribute('aria-multiline');
  clearEditReplaceAll();
}
// Toolbar chrome (the ☑ task button included) is excluded from the blur-commit
// path so B/I/U can keep the contentEditable selection. Anything that then
// re-renders the node must write the live editor back to the model first —
// otherwise the typed text dies with the torn-down DOM.
function captureNodeEditText(src){
  const html = String(src && (src.innerHTML != null ? src.innerHTML : src.html) || '').trim();
  let plain = String(src && (src.textContent != null ? src.textContent : src.text) || '').trim();
  const imgM = plain.match(/!\[([^\]]*)\]\(\s*([^)\s]+)[^)]*\)/);
  if(imgM) plain = plain.replace(imgM[0],'').replace(/\s{2,}/g,' ').trim();
  const hasFormatting = INLINE_HTML_RE.test(html) && !imgM;
  let text = '';
  if(plain){
    text = (hasFormatting && typeof sanitizeInlineHTML === 'function')
      ? sanitizeInlineHTML(html)
      : (hasFormatting ? html : plain);
  }
  if(text && text !== 'Untitled') text = text.replace(/&amp;(#\d+;|#x[0-9a-fA-F]+;|[a-zA-Z][a-zA-Z0-9]*;)/g, '&$1');
  return {
    text,
    image: imgM ? imgM[2] : null,
    imageAlt: imgM ? (imgM[1] || '') : '',
    clearImage: !imgM
  };
}
function applyNodeEditCapture(node, cap){
  if(!node || !cap) return node;
  // File-backed images live on the node, not in the caption. Typing a caption
  // must not wipe n.image just because the editor has no ![alt](src) markdown.
  if(cap.image){ node.image = cap.image; node.imageAlt = cap.imageAlt; }
  const isImg = node.image !== undefined;
  node.text = cap.text || (isImg ? '' : 'Untitled');
  node.updated = Date.now();
  return node;
}
function syncAutoTitleFromRoot(id){
  if(!map || id!==map.rootId || map.titleAuto!==true) return;
  const newText = (map.nodes[id] && map.nodes[id].text) || '';
  const titleText = String(newText).replace(/<[^>]+>/g,'').replace(/&nbsp;/g,' ').trim() || 'Untitled';
  map.title = titleText;
  if(typeof $ === 'function'){
    const titleInput = $('#mapTitle');
    if(titleInput) titleInput.value = titleText;
  }
  if(typeof refreshList === 'function') refreshList();
}
function flushOpenEditToModel({preserveEditor=false}={}){
  if(typeof document === 'undefined' || !map || !map.nodes) return null;
  const float = (typeof _editFloat!=='undefined') ? _editFloat : null;
  if(float && float.classList && float.classList.contains('input-ready')) return null;
  const el = document.querySelector ? document.querySelector('.node.editing') : null;
  const id = (float && float.dataset && float.dataset.nodeId) || (el && el.dataset && el.dataset.id);
  const n = id && map.nodes[id];
  if(!n) return null;
  if(el && el.classList && el.classList.contains('editing-block')){
    const box=el.querySelector('.node-block');
    if(box) n.html=captureBlockEditHTML(box, n.html);
    return id;
  }
  const textEl = (float && editFloatLiveTextEl(float)) || (el && ((el.querySelector && el.querySelector('.node-text')) || el));
  if(!textEl) return null;
  applyNodeEditCapture(n, captureNodeEditText(textEl));
  syncAutoTitleFromRoot(id);
  if(preserveEditor) return id;
  if(typeof unmountEditFloat==='function') unmountEditFloat(el, el && el.querySelector && el.querySelector('.node-text'));
  // Drop the class so the delayed blur handler will not finish() a session
  // that render() is about to replace.
  if(el && el.classList && el.classList.remove) el.classList.remove('editing');
  return id;
}
if(typeof document!=='undefined' && document.addEventListener){
  document.addEventListener('pointerdown', e=>{
    const editing=document.querySelector('.node.editing');
    if(!editing) return;
    if(!shouldCommitEditOnPointerTarget(e.target, editing)) return;
    armEditBlurCommit();
    // WK stage mousedown preventDefault keeps the editor focused, so blur
    // never commits. Save now, then the click can select the other node.
    commitOpenEdit();
  }, true);
  document.addEventListener('keydown', onEditorClipboardKeydown, true);
  document.addEventListener('paste', onEditorPaste, true);
  document.addEventListener('copy', e => onEditorCopyCut(e, false), true);
  document.addEventListener('cut', e => onEditorCopyCut(e, true), true);
  window.addEventListener('focus', ()=>{
    if(typeof openOverlayTextField==='function' && openOverlayTextField()) return;
    const textEl = openEditorTextEl();
    if(!textEl) return;
    const ae = document.activeElement;
    if(ae === textEl || (textEl.contains && textEl.contains(ae))) return;
    if(ae && (ae.tagName==='INPUT' || ae.tagName==='TEXTAREA')) return;
    try{ textEl.focus(); }catch(_){}
    if(peekEditReplaceAll()) selectEditorContents(textEl);
  });
}
// Give the selected node a real text-input destination before the first key.
// IMEs decide whether to compose before JavaScript receives keydown; focusing
// only after that event turns the first Pinyin letter into literal Latin text.
function pendingNodeTyping(){
  return !!(_editFloat && _editFloat.classList.contains('input-ready'));
}
function prepareNodeTyping(id){
  if(READONLY || !document.documentElement.classList.contains('rms-wk') || document.querySelector('.node.editing')) return;
  if(pendingNodeTyping() && _editFloat.dataset.nodeId===id) return;
  discardEditOverlay();
  const node=map?.nodes[id];
  const el=node && document.querySelector(`.node[data-id="${id}"]`);
  if(!el || node.hr || node.html) return;
  const textEl=el.querySelector('.node-text')||el;
  const host=mountEditFloat(el,textEl);
  const raw=node.text||'';
  if(INLINE_HTML_RE.test(raw)) host.innerHTML=sanitizeInlineHTML(raw);
  else host.textContent=raw;
  _editFloat.classList.add('input-ready');
  el.classList.remove('edit-placeholder');
  const activate=e=>{
    host.removeEventListener('beforeinput',activate);
    host.removeEventListener('compositionstart',activate);
    host.removeEventListener('input',activate);
    delete host._activateNodeInput;
    host._rmsComposing=e.type==='compositionstart' || !!e.isComposing;
    startEdit(id);
  };
  host._activateNodeInput=activate;
  host.addEventListener('beforeinput',activate);
  host.addEventListener('compositionstart',activate);
  host.addEventListener('input',activate);
  selectEditorContents(host);
}
function startEdit(id){
  if(READONLY) return;
  const already=typeof document!=='undefined' && document.querySelector && document.querySelector('.node.editing');
  if(already && already.dataset.id===id && _liveEditing) return;
  if(_liveEditing || (already && already.dataset.id && already.dataset.id!==id)) commitOpenEdit();
  consumeEditBlurCommit();
  opLog('editStart', {id});
  if(_nodeBarTimer){ clearTimeout(_nodeBarTimer); _nodeBarTimer=0; }
  if(map.nodes[id] && map.nodes[id].hr) return;   // dividers aren't editable
  const el=document.querySelector(`.node[data-id="${id}"]`); if(!el) return;
  if(map.nodes[id] && map.nodes[id].html){ startBlockEdit(id, el); return; }   // edit code/table in place
  const textEl=el.querySelector('.node-text')||el;
  const prepared=pendingNodeTyping() && _editFloat.dataset.nodeId===id;
  const raw = map.nodes[id]?.text || '';
  // ⇧Esc puts these back: the text as it was when editing began.
  const orig = map.nodes[id] ? { text:map.nodes[id].text, image:map.nodes[id].image, imageAlt:map.nodes[id].imageAlt, updated:map.nodes[id].updated } : null;
  // Preserve any inline formatting (bold/italic/etc.) for the user to edit
  if(INLINE_HTML_RE.test(raw)) textEl.innerHTML = sanitizeInlineHTML(raw);
  else textEl.textContent = raw;
  el.classList.add('editing');
  _liveEditing=true;
  _editTyped=false;
  armEditorHost(textEl);
  const host=prepared ? editFloatLiveTextEl(_editFloat) : mountEditFloat(el, textEl);
  if(prepared){
    if(host._activateNodeInput){
      for(const name of ['beforeinput','compositionstart','input']) host.removeEventListener(name,host._activateNodeInput);
      delete host._activateNodeInput;
    }
    _editFloat.classList.remove('input-ready');
    el.classList.add('edit-placeholder');
    clearEditReplaceAll();
  } else {
    host.focus();
    selectEditorContents(host);
  }
  let _editRAF=0;
  let composing=!!host._rmsComposing, blurTimer=0;
  const onCompositionStart=()=>{
    composing=true;
    host._rmsComposing=true;
    if(document.activeElement===host || (host.contains && host.contains(document.activeElement))) clearEditReplaceAll();
    // A layout rAF from the previous keystroke will move the node and
    // dismiss the IME candidate window — that race is why 中文 fails only sometimes.
    if(_editRAF){ cancelAnimationFrame(_editRAF); _editRAF=0; }
  };
  const onCompositionEnd=()=>{
    composing=false;
    host._rmsComposing=false;
    _editTyped=true;
    if(typeof markImeCompositionEnd==='function') markImeCompositionEnd();
    tryMarkdownShortcut();
    updateFormulaAutocomplete(host, id);
    if(_editRAF) cancelAnimationFrame(_editRAF);
    _editRAF=requestAnimationFrame(()=>{ _editRAF=0; relayoutDuringEdit(id); });
  };
  const finish=(commit)=>{
    _commitOpenEdit=null;
    closeFormulaAutocomplete();
    if(commit){
      applyNodeEditCapture(map.nodes[id], captureNodeEditText(host));
      syncAutoTitleFromRoot(id);
      opLog('edit', {id, text:(map.nodes[id]&&map.nodes[id].text)||''});
      pushHistory();
    } else if(host!==textEl){
      host.textContent=map.nodes[id].text;
    }
    unmountEditFloat(el, textEl);
    _liveEditing=false;
    disarmEditorHost(host);
    if(host!==textEl) disarmEditorHost(textEl);
    el.classList.remove('editing');
    if(blurTimer){ clearTimeout(blurTimer); blurTimer=0; }
    host.removeEventListener('blur',onBlur); host.removeEventListener('keydown',onKey);
    host.removeEventListener('input',onInput);
    host.removeEventListener('mousedown',onPointer);
    host.removeEventListener('compositionstart',onCompositionStart);
    host.removeEventListener('compositionend',onCompositionEnd);
    _editTyped=false;
    // Tidy the branch so the (grown/shrunk) node and its siblings stay neatly
    // laid out after editing — mirrors GitMind, which keeps the map tidy both
    // during and after typing. autoLayout() re-renders internally.
    if(_editRAF){ cancelAnimationFrame(_editRAF); _editRAF=0; }
    autoLayout();
  };
  const onBlur=()=>{
    if(composing) return;
    clearTimeout(blurTimer);
    // 120ms: compositionstart / OS input-source UI usually arrive after the
    // blur. setTimeout(0) was too short — that's the intermittent miss.
    blurTimer=setTimeout(()=>{
      blurTimer=0;
      if(!el.classList.contains('editing')) return;
      if(!shouldCommitEditOnBlur({
        composing,
        activeInside: el.contains(document.activeElement) || isEditSessionChrome(document.activeElement),
        pointerOutside: consumeEditBlurCommit()
      })) return;
      finish(true);
    }, 120);
  };
  const onInput=()=>{
    if(composing) return;
    _editTyped=true;
    // macOS IME fires input BEFORE compositionstart on the first pinyin key.
    // A same-frame layout move dismisses the candidate window. Wait one extra
    // frame so compositionstart can cancel this.
    tryMarkdownShortcut();
    updateFormulaAutocomplete(host, id);
    if(_editRAF) cancelAnimationFrame(_editRAF);
    _editRAF=requestAnimationFrame(()=>{
      _editRAF=requestAnimationFrame(()=>{
        _editRAF=0;
        if(composing || !el.classList.contains('editing')) return;
        relayoutDuringEdit(id);
      });
    });
  };
  const onKey=e=>{
    if(clipboardEditAction(e)) return;
    const undoAct=editSessionUndoAction(e);
    if(undoAct){ e.preventDefault(); e.stopPropagation(); performHistoryChord(undoAct); return; }
    if(!e.ctrlKey && !e.metaKey && !e.altKey && e.key && e.key.length===1) clearEditReplaceAll();
    if(isImeEvent(e) || composing || isImeSwitchEvent(e) || isImeConfirmEnter(e)) return;
    if(formulaAutocompleteKeydown(e)) return;   // popup open: let it handle nav/select/dismiss first
    // Standard contentEditable shortcuts: Ctrl/Cmd+B / I / U toggle inline
    if((e.ctrlKey||e.metaKey) && !e.shiftKey){
      const k=e.key.toLowerCase();
      if(k==='b'||k==='i'||k==='u'){ e.preventDefault(); e.stopPropagation(); execCmd(k==='b'?'bold':k==='i'?'italic':'underline'); return; }
    }
    const createAction=editSessionCreateAction(e);
    if(createAction){
      e.preventDefault();e.stopPropagation();
      finish(true);
      addNode(id, createAction==='sibling');
      return;
    }
    if(e.key==='Escape'){
      if(!shouldCommitEditOnEscape(e)) return;
      e.preventDefault();e.stopPropagation();
      if(e.shiftKey) cancelEdit(); else finish(true);
      host.blur();
    }
  };
  // ⇧Esc: leave the editor and restore the text from before this edit.
  const cancelEdit=()=>{
    const n=map.nodes[id];
    const changed=!!(n && orig && (n.text!==orig.text || n.image!==orig.image));
    if(n && orig){
      n.text=orig.text;
      for(const k of ['image','imageAlt','updated']){ if(orig[k]===undefined) delete n[k]; else n[k]=orig[k]; }
    }
    finish(false);
    opLog('editCancel', {id});
    if(changed){ syncAutoTitleFromRoot(id); pushHistory(); }
  };
  const onPointer=()=>{ clearEditReplaceAll(); };
  host.addEventListener('mousedown', onPointer);
  host.addEventListener('blur',onBlur); host.addEventListener('keydown',onKey);
  host.addEventListener('input',onInput);
  host.addEventListener('compositionstart',onCompositionStart);
  host.addEventListener('compositionend',onCompositionEnd);
  _commitOpenEdit=()=>finish(true);
  positionNodeBar();
}

/* ---------- node context toolbar ---------- */
const FONT_SIZES = [12,14,15,16,18,20,24,28,32];
const TEXT_COLORS = ['#23201b','#5b5447','#b8451f','#c98a1a','#5a7d3a','#2f6f6a','#3a6ea5','#9b4f96'];
const HILITES = ['#fff59d','#ffcdd2','#c8e6c9','#b3e5fc','#e1bee7','#ffe0b2'];
function themeCssColor(name){
  try{ return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }catch(_){ return ''; }
}
// Dark theme = the node card background is dark (#23201b ink would vanish on it).
function isDarkNodeTheme(){
  const bg=themeCssColor('--node-bg');
  return /^#[0-9a-f]{6}$/i.test(bg) && pickContrast(bg)==='#ffffff';
}
// On dark themes the first ("ink") swatch is the theme's own node ink.
function textColorSwatches(){
  if(!isDarkNodeTheme()) return TEXT_COLORS;
  const ink=safeColor(themeCssColor('--node-ink'));
  return ink ? [ink].concat(TEXT_COLORS.slice(1)) : TEXT_COLORS;
}
let activePicker = null;

function showPicker(anchor, kind, current, onPick){
  // Toggle off if the same anchor's picker is already open
  if(activePicker && activePicker._anchor===anchor){
    activePicker.remove(); activePicker=null; return;
  }
  if(activePicker){ activePicker.remove(); activePicker=null; }
  document.querySelectorAll('.tpl-pop, .export-pop').forEach(p=>{ try{p.remove();}catch(_){} });
  try{ if(typeof closeThemePanel==='function') closeThemePanel(); }catch(_){}
  const p=document.createElement('div');
  p.className='picker '+kind; p._anchor=anchor;
  if(kind==='size'){
    p.innerHTML=FONT_SIZES.map(s=>
      `<button data-v="${s}" class="${s==current?'on':''}">${s}</button>`).join('');
  }else if(kind==='align'){
    const opts=[
      {v:'left',  ic:'⫷', t:rmsTr('actAlignLeft','Align left')},
      {v:'center',ic:'≡', t:rmsTr('actAlignCentre','Align centre')},
      {v:'right', ic:'⫸', t:rmsTr('actAlignRight','Align right')}
    ];
    p.innerHTML=opts.map(o=>
      `<button data-v="${o.v}" class="${o.v===current?'on':''}" title="${o.t}"><span class="align-icon align-${o.v}">${o.ic}</span></button>`).join('');
  }else{
    const list = kind==='text' ? textColorSwatches() : HILITES;
    const label = kind==='text' ? rmsTr('actDefault','Default') : rmsTr('actNone','None');
    p.innerHTML =
      `<button class="p-default" data-v="">${label}</button>`+
      list.map(c=>`<button class="p-sw ${c==current?'on':''}" data-v="${c}" style="background:${c}" title="${c}"></button>`).join('');
  }
  document.body.appendChild(p);
  positionPopup(p, anchor);
  activePicker=p;
  p.addEventListener('mousedown',e=>e.stopPropagation());
  p.querySelectorAll('button').forEach(b=>{
    // Keep contentEditable selection alive while picking
    b.addEventListener('mousedown', e => e.preventDefault());
    b.addEventListener('click',e=>{
      e.stopPropagation();
      const v=b.dataset.v;
      onPick(kind==='size' ? parseInt(v) : (v||null));
      p.remove(); if(activePicker===p) activePicker=null;
    });
  });
}
// global click closes any open picker
document.addEventListener('click',e=>{
  if(activePicker && !activePicker.contains(e.target) && !e.target.closest('.fmt-btn')){
    activePicker.remove(); activePicker=null;
  }
});

// Where the node bar *would* sit if there were no viewport edges to worry
// about: horizontally centred under the node, with a constant ~12px
// on-screen gap below it regardless of zoom (a world-space gap would shrink
// when zoomed out).
function nodeBarBasePosition(n){
  return {
    left: n.x+(n.w||0)/2,
    top:  n.y+(n.h||40)+12/view.k
  };
}

// Keeps the (already-appended) node bar fully inside the visible canvas
// area, nudging it back on-screen if the node it belongs to sits near an
// edge. Always recomputes from the canonical base position first, so
// corrections never accumulate/drift across repeated calls (e.g. while
// panning or zooming with a node selected).
function positionAndClampNodeBar(bar, n){
  const pos=nodeBarBasePosition(n);
  bar.style.left=pos.left+'px';
  bar.style.top=pos.top+'px';
  bar.style.transformOrigin='top center';
  // The bar lives inside the zoomable viewport, so counter-scale it by 1/zoom
  // to keep it a constant on-screen size no matter how far the map is zoomed.
  bar.style.transform=`translateX(-50%) scale(${1/view.k})`;
  if(!stage) return;
  const z=_uiZ();   // getBoundingClientRect() below scales with the UI-level display size too, not just canvas zoom — same correction _stageSize()/_stagePoint() already apply
  // _prevStageRect is kept fresh by _markStage() at gesture-settle points, not every
  // frame — the stage's own bounds can't change mid-gesture, so reusing it here saves
  // one of the two forced-reflow getBoundingClientRect() calls this function used to
  // make on every single pan/zoom/drag frame.
  const bounds=(_prevStageRect && _prevStageRect.width>1) ? _prevStageRect : stage.getBoundingClientRect();
  const margin=8*z;   // keep the comparison in the same raw space as bounds/rect rather than mixing a CSS-px margin into it
  // The stage includes the fixed top toolbar. Its controls occupy real space,
  // even though the rest of that overlay is pointer-transparent.
  const topbar=stage.querySelector('.topbar')?.getBoundingClientRect();
  const minTop=Math.max(bounds.top+margin, topbar?.height ? topbar.bottom+margin : bounds.top+margin);
  const maxTop=bounds.bottom-margin;
  const minLeft=bounds.left+margin, maxLeft=bounds.right-margin;
  const node=document.querySelector('.node.sel')?.getBoundingClientRect();
  // Do not leave an orphan toolbar pinned to the edge when its node is offscreen.
  bar.style.visibility=node && (node.right<=minLeft || node.left>=maxLeft || node.bottom<=minTop || node.top>=maxTop)
    ? 'hidden' : '';
  // A narrow canvas (e.g. beside Markdown) must still contain every action.
  // Horizontal scrolling preserves the compact toolbar without covering chrome.
  bar.style.maxWidth=Math.max(0,(maxLeft-minLeft)/z)+'px';
  const rect=bar.getBoundingClientRect();
  const k=view.k||1;
  let dx=0, dy=0;
  if(rect.right>maxLeft) dx=maxLeft-rect.right;
  if(rect.left+dx<minLeft) dx=minLeft-rect.left;   // bar wider than the stage: pin to the left edge rather than overflow both sides
  if(rect.bottom>maxTop) dy=maxTop-rect.bottom;
  if(rect.top+dy<minTop) dy=minTop-rect.top;
  if(rect.height>maxTop-minTop) bar.style.visibility='hidden';
  if(dx||dy){
    bar.style.left=(pos.left+dx/(k*z))+'px';
    bar.style.top=(pos.top+dy/(k*z))+'px';
  }
}

const NODE_DBLCLICK_MS=450;
let _nodeBarTimer=0;
function scheduleNodeBar(){
  if(_nodeBarTimer) clearTimeout(_nodeBarTimer);
  _nodeBarTimer=setTimeout(()=>{
    _nodeBarTimer=0;
    positionNodeBar();
  }, NODE_DBLCLICK_MS);
}

// Cheap alternative to positionNodeBar() for continuous gestures (dragging a node,
// relayout-while-typing) where the toolbar's CONTENT never changes mid-gesture —
// only the node's position does. positionNodeBar() tears the bar down and rebuilds
// ~20 buttons' worth of innerHTML plus re-attaches a listener on every one of them;
// doing that on every drag-move frame was the single biggest cost in the whole
// pan/zoom/drag path. This just repositions the bar that's already there.
function repositionNodeBar(){
  const bar=document.getElementById('nodebar');
  if(bar){ if(sel && map && map.nodes[sel]) positionAndClampNodeBar(bar, map.nodes[sel]); }
  else positionNodeBar();   // no bar yet (shouldn't normally happen mid-gesture) — build it properly
}

function positionNodeBar(){
  $('#nodebar')?.remove();
  if(READONLY) return;            // version-history preview shows no editing toolbar
  if(activePicker){ activePicker.remove(); activePicker=null; }
  // When 2+ nodes are multi-selected, the bottom bulk bar takes over — don't
  // also show the single-node toolbar.
  if(typeof multiSel !== 'undefined' && multiSel.size >= 2) return;
  if(!sel||!map.nodes[sel]) return;
  const el=document.querySelector(`.node[data-id="${sel}"]`); if(!el) return;
  const n=map.nodes[sel];
  const isRoot=sel===map.rootId;
  const hasKids=childrenOf(sel).length>0;
  const fs = n.fontSize || (isRoot?19:15);
  const tc = safeColor(n.textColor) || (isRoot?'#ffffff':'var(--node-ink)');
  const hl = safeColor(n.highlight) || 'transparent';
  const hlInk = hl==='transparent' ? 'inherit' : (safeColor(n.textColor) || '#23201b');

  const bar=document.createElement('div'); bar.className='nodebar'; bar.id='nodebar';
  bar.innerHTML=`
    <div class="nb-group">
      <button data-a="child" title="${chordTitle('scAddChild','addChild','Add child')}">＋</button>
      ${!isRoot?'<button data-a="sibling" title="'+chordTitle('scAddSibling','addSibling','Add sibling')+'">⤵</button>':''}
      ${hasKids?`<button data-a="collapse" title="${chordTitle('scCollapse','collapse','Collapse / expand')}">${map.nodes[sel].collapsed?'⊕':'⊖'}</button>`:''}
      <button data-a="edit" title="${chordTitle('scEditNode','editNode','Edit node')}">✎</button>
      <button data-a="notes" class="${(n.notes||'').trim()?'on':''}" title="${(n.notes||'').trim()?rmsTr('actNotesEdit','Edit notes'):rmsTr('actNotesAdd','Add notes')}">📝</button>
      <button data-a="task" class="${n.task?'on':''}" title="${rmsTr('actTask','Todo state')}">☑</button>
      <button data-a="marker" class="${n.marker?'on':''}" title="${n.marker?rmsTr('actMarkerChange','Change marker'):rmsTr('actMarkerAdd','Add a marker')}">${n.marker?escapeHtml(String(n.marker)):'\u2B50'}</button>
      <button data-a="cite" class="${n.ref?'on':''}" title="${rmsTr('actCite','Cite')}">📖</button>
      <button data-a="href" class="${n.url?'on':''}" title="${n.url?rmsTr('actHrefEdit','Edit hyperlink'):rmsTr('actHrefAdd','Add hyperlink')}">🔗</button>
      <button data-a="image" class="${n.image?'on':''}" title="${rmsTr('actImage','Image')}">🖼</button>
      <button data-a="mdtable" class="${isTableNode(n)?'on':''}" title="${rmsTr('actMdTable','Markdown table')}">▦</button>
      ${!isRoot?'<button data-a="del" title="'+chordTitle('scDeleteNode','deleteNode','Delete node')+'">🗑</button>':''}
    </div>
    <div class="nb-div"></div>
    <div class="nb-group">
      <button data-a="size" class="fmt-btn size-btn" title="${rmsTr('actSize','Font size')}"><span>${fs}</span><span class="caret">▾</span></button>
      <button data-a="bold" class="${n.bold?'on':''}" title="${rmsTr('actBold','Bold')}"><b>B</b></button>
      <button data-a="italic" class="${n.italic?'on':''}" title="${rmsTr('actItalic','Italic')}"><i>I</i></button>
      <button data-a="strike" class="${n.strike?'on':''}" title="${rmsTr('actStrike','Strikethrough')}"><s>S</s></button>
      <button data-a="underline" class="${n.underline?'on':''}" title="${rmsTr('actUnderline','Underline')}"><u>U</u></button>
      <button data-a="ul" class="${n.listType==='ul'?'on':''}" title="${rmsTr('actUl','Bulleted list')}">•≡</button>
      <button data-a="ol" class="${n.listType==='ol'?'on':''}" title="${rmsTr('actOl','Numbered list')}">1≡</button>
      <button data-a="align" class="fmt-btn align-btn" title="${rmsTr('actAlign','Text alignment')}"><span class="align-icon align-${n.align||'center'}">≡</span><span class="caret">▾</span></button>
      <button data-a="textColor" class="fmt-btn color-btn" title="${rmsTr('actTextColor','Text color')}"><span class="A-mark" style="border-bottom:3px solid ${tc}">A</span><span class="caret">▾</span></button>
      <button data-a="highlight" class="fmt-btn color-btn" title="${rmsTr('actHighlight','Highlight')}"><span class="A-mark" style="background:${hl};color:${hlInk};padding:0 2px;border-radius:2px">A</span><span class="caret">▾</span></button>
    </div>
    <div class="nb-div"></div>
    <span class="swatches" title="${rmsTr('actCardColor','Card color')}">${(isRoot?PALETTE:NODE_COLORS).map(c=>`<span class="sw" data-c="${c}" style="background:${c};${c==='#ffffff'?'border-color:var(--line)':''}"></span>`).join('')}</span>`;
  viewport.appendChild(bar);
  // Position after appending so we can measure the bar's real on-screen size
  // and clamp it to stay fully inside the visible canvas, however close to
  // an edge the node is.
  positionAndClampNodeBar(bar, n);
  bar.addEventListener('mousedown',e=>e.stopPropagation());
  // Prevent toolbar clicks from stealing focus from a node being edited,
  // so the contentEditable text-selection survives execCommand calls.
  bar.querySelectorAll('button').forEach(b => b.addEventListener('mousedown', e => e.preventDefault()));

  // Inline formatting when a node is in edit mode → applies to the current
  // text selection via execCommand. Outside edit mode → falls back to the
  // node-wide toggle (existing behaviour, kept for back-compat).
  const editingNode = () => {
    const ed = document.querySelector('.node.editing');
    return (ed && ed.dataset.id === sel) ? ed : null;
  };
  const inlineOrToggle = (prop, cmd) => {
    const ed = editingNode();
    if(ed){
      execCmd(cmd);
      // WK edits in .edit-float, not the hidden .node-text placeholder.
      const host=(typeof openEditorTextEl==='function' && openEditorTextEl()) || ed.querySelector('.node-text');
      host?.focus();
    } else {
      map.nodes[sel][prop] = !map.nodes[sel][prop];
      map.nodes[sel].updated = Date.now();
      pushHistory(); render();
    }
  };
  const toggleList = (kind) => {
    const ed = editingNode();
    if(ed){
      // Selection-aware list: split the selection on <br>/newlines and turn
      // each line into its own <li>. We can't use the browser's built-in
      // execCommand here — Chrome/WebKit collapse multi-line selections into
      // a single <li>, which isn't what the user wants.
      applyListToSelection(kind);
      if(map.nodes[sel].listType) map.nodes[sel].listType = null;
      const host=(typeof openEditorTextEl==='function' && openEditorTextEl()) || ed.querySelector('.node-text');
      host?.focus();
    } else {
      // Whole-node toggle (legacy behaviour, kept for users who haven't entered edit mode)
      const cur = map.nodes[sel].listType;
      map.nodes[sel].listType = (cur===kind ? null : kind);
      map.nodes[sel].updated = Date.now();
      pushHistory(); render();
    }
  };
  bar.querySelectorAll('button').forEach(b=>{
    b.onclick=(ev)=>{
      ev.stopPropagation();
      if(shouldIgnoreTransientToolbarClick(ev.detail, Date.now(), _nodeClickStamp && _nodeClickStamp.t, NODE_DBLCLICK_MS)) return;
      const a=b.dataset.a;
      if(a==='child') addNode(sel,false);
      else if(a==='sibling') addNode(sel,true);
      else if(a==='edit') startEdit(sel);
      else if(a==='del') deleteNode(sel);
      else if(a==='collapse'){ map.nodes[sel].collapsed=!map.nodes[sel].collapsed; opLog(map.nodes[sel].collapsed?'collapse':'expand', {id:sel}); pushHistory(); autoLayout(); }
      else if(a==='bold')      inlineOrToggle('bold',      'bold');
      else if(a==='italic')    inlineOrToggle('italic',    'italic');
      else if(a==='strike')    inlineOrToggle('strike',    'strikeThrough');
      else if(a==='underline') inlineOrToggle('underline', 'underline');
      else if(a==='ul') toggleList('ul');
      else if(a==='ol') toggleList('ol');
      else if(a==='notes') showNotesEditor(sel, { sticky:true });
      else if(a==='task') cycleTask(sel);
      else if(a==='marker'){ showMarkerPicker(b, sel); return; }   // return: keep the bar open behind the picker
      else if(a==='cite') showCitationForm(sel);
      else if(a==='href'){ showHrefPicker(b, sel); return; }
      else if(a==='image'){
        if(map.nodes[sel].image){
          const imgId=sel;
          rmsConfirm(rmsTr('confirmRemoveImage','Remove this image?'),
                     { okLabel:rmsTr('dlgRemove','Remove'), danger:true })
            .then(ok=>{ if(ok && map && map.nodes[imgId] && map.nodes[imgId].image) detachImageFromNode(imgId); });
        } else attachImageToNode(sel);
      }
      else if(a==='mdtable'){ showMdTablePicker(b, sel); return; }
      else if(a==='size') showPicker(b,'size',fs,v=>{ map.nodes[sel].fontSize=v; pushHistory(); render(); });
      else if(a==='align') showPicker(b,'align',n.align||'center',v=>{ map.nodes[sel].align=v; pushHistory(); render(); });
      else if(a==='textColor') showPicker(b,'text',n.textColor,v=>{ map.nodes[sel].textColor=v; pushHistory(); render(); });
      else if(a==='highlight') showPicker(b,'hilite',n.highlight,v=>{ map.nodes[sel].highlight=v; pushHistory(); render(); });
    };
  });
  bar.querySelectorAll('.sw').forEach(s=>s.onclick=(ev)=>{
    ev.stopPropagation();
    if(isRoot) map.color=s.dataset.c; else map.nodes[sel].color=s.dataset.c;
    pushHistory(); render();
  });
}

/* ============================================================
   INTERACTION — pan / zoom / drag
   ============================================================ */
let dragNode=null,dragStart=null,panning=false,panStart=null,moved=false;
let dragRoots=null;    // move-roots for the active drag (group or single)
let marquee=null;      // ⌘/Ctrl box-select gesture
let resizing=null;     // {id, sx, sy, sw, sh}
let dropTarget=null;   // id of node currently hovered as a reparent target
let _nodeClickStamp={id:null,t:0};

function cancelNodeDrag(){
  document.body.classList.remove('node-dragging');
  if(typeof setDropTarget==='function') setDropTarget(null);
  dragNode=null;
  dragRoots=null;
  moved=false;
  if(typeof clearDragGhosts==='function') clearDragGhosts();
}

// Snapshot positions of `id` and all its descendants so the whole subtree
// can move together during a drag, then reset cleanly on cancel.
function beginSubtreeDrag(idOrIds, mx, my){
  document.body.classList.add('node-dragging');   // suspend the position transition below while actively dragging (must track the pointer 1:1, not ease into place)
  clearCanvasTextSelection();
  const roots=Array.isArray(idOrIds) ? idOrIds : [idOrIds];
  const subtree={};
  withChildIndex(()=>{
    const collect = i => {
      if(!map.nodes[i] || subtree[i]) return;
      subtree[i] = { x: map.nodes[i].x, y: map.nodes[i].y };
      childrenOf(i).forEach(collect);
    };
    roots.forEach(collect);
  });
  document.querySelectorAll('.node.drag-ghost').forEach(n=>n.classList.remove('drag-ghost'));
  // Cache each element once here: applySubtreeDelta runs every mousemove.
  for(const id in subtree){
    const el=document.querySelector(`.node[data-id="${id}"]`);
    subtree[id].el=el||null;
    if(el) el.classList.add('drag-ghost');
  }
  return { mx, my, root:roots[0], roots, subtree };
}
// Apply (dx,dy) delta to the whole subtree captured in start.subtree.
function applySubtreeDelta(start, dx, dy){
  for(const id in start.subtree){
    const base = start.subtree[id];
    const n = map.nodes[id]; if(!n) continue;
    n.x = base.x + dx; n.y = base.y + dy;
    let el = base.el;
    if(el && !el.isConnected){   // a render() mid-drag replaced the element
      el = base.el = document.querySelector(`.node[data-id="${id}"]`);
    }
    if(el){ el.style.left = n.x+'px'; el.style.top = n.y+'px'; }
  }
}

// Used by render() to attach mousedown to the resize grip
function startResize(id, ev){
  const n=map.nodes[id];
  const pt=_evtXY(ev);
  resizing={id, sx:pt.x, sy:pt.y, sw:n.width||n.w||120, sh:n.height||n.h||40};
}
// Walks up parents; true if `id` is a descendant of `ancestorId` (or equal)
function isDescendant(id, ancestorId){
  let cur=id;
  while(cur){ if(cur===ancestorId) return true; cur=map.nodes[cur]?.parent; }
  return false;
}
// Find the node under (x,y) that's a valid drop target for the currently-dragged node.
function findDropTarget(x,y, rawX, rawY){
  const roots=(dragRoots && dragRoots.length) ? dragRoots : (dragNode ? [dragNode] : []);
  if(!roots.length) return null;
  // Dragged subtrees have pointer-events disabled, so they won't be returned here.
  // WK elementFromPoint wants the same space as raw clientX; getBoundingClientRect is visual.
  let els=document.elementsFromPoint(rawX!=null?rawX:x, rawY!=null?rawY:y);
  if(!_elsHaveNode(els) && rawX!=null && (rawX!==x || rawY!==y)){
    els=document.elementsFromPoint(x,y);
  }
  for(const el of els){
    const node=el.closest && el.closest('.node');
    if(node && node.dataset && node.dataset.id){
      const tid=node.dataset.id;
      if(roots.includes(tid)) continue;
      // Don't allow dropping a node onto its own subtree (would create a cycle)
      if(roots.some(r=>isDescendant(tid, r))) continue;
      // Hovering the centre of a node nests as a child; hovering its top/bottom
      // edge inserts as a sibling before/after it (reorder). Root only accepts
      // nesting (it has no siblings).
      let mode='on';
      if(tid!==map.rootId){
        const r=node.getBoundingClientRect();
        const rel=(y-r.top)/(r.height||1);
        if(rel<0.30) mode='before';
        else if(rel>0.70) mode='after';
      }
      return {id:tid, mode};
    }
  }
  return null;
}
function _elsHaveNode(els){
  if(!els) return false;
  for(const el of els){ if(el.closest && el.closest('.node')) return true; }
  return false;
}
function setDropTarget(dt){
  const id=dt&&dt.id, mode=(dt&&dt.mode)||'on';
  if(dropTarget && dt && dropTarget.id===id && dropTarget.mode===mode) return;
  document.querySelectorAll('.node.drop-target,.node.drop-before,.node.drop-after')
    .forEach(n=>n.classList.remove('drop-target','drop-before','drop-after'));
  dropTarget=dt||null;
  if(id){
    const el=document.querySelector(`.node[data-id="${id}"]`);
    if(el) el.classList.add(mode==='on'?'drop-target':(mode==='before'?'drop-before':'drop-after'));
  }
}
// Insert `dragId` as a sibling of `refId`, immediately before or after it,
// reparenting if needed. This both reorders siblings and inserts between them.
function insertSibling(dragId, refId, mode){
  return applySelectionMove([dragId], refId, mode);
}
// Move `id` up or down among its siblings (reordering sibling order).
// Sibling order is map.nodes key order, which feeds childrenOf, layout, and Markdown.
// Only the two sibling keys are swapped. Descendants stay attached via parent
// pointers — they are often NOT stored as a contiguous block (later-added
// grandchildren get appended), so moving a "subtree slice" would jump past
// later siblings.
function moveSibling(id, dir){
  if(typeof READONLY !== 'undefined' && READONLY) return false;
  if(!map || !map.nodes || !map.nodes[id] || id === map.rootId) return false;
  const node = map.nodes[id];
  const parentId = node.parent;
  if(parentId == null || !map.nodes[parentId]) return false;

  const allSiblings = childrenOf(parentId);
  const layout = map.layout || 'balanced';
  const isBalancedRoot = (parentId === map.rootId && layout === 'balanced');
  const sameSide = sid => (map.nodes[sid]?.side === 'left' ? 'left' : 'right') === (node.side === 'left' ? 'left' : 'right');
  const targetSiblings = isBalancedRoot ? allSiblings.filter(sameSide) : allSiblings;

  const idx = targetSiblings.indexOf(id);
  if(idx < 0) return false;

  const isUp = (dir === 'up' || dir === -1);
  const isDown = (dir === 'down' || dir === 1);
  if(!isUp && !isDown) return false;

  const targetIdx = isUp ? idx - 1 : idx + 1;
  if(targetIdx < 0 || targetIdx >= targetSiblings.length) return false;

  const targetId = targetSiblings[targetIdx];
  const reordered = {};
  for(const k in map.nodes){
    if(k === id) reordered[targetId] = map.nodes[targetId];
    else if(k === targetId) reordered[id] = map.nodes[id];
    else reordered[k] = map.nodes[k];
  }
  map.nodes = reordered;
  opLog('reorder', {id, dir, parent:parentId});
  pushHistory();
  autoLayout();
  if(typeof mdMode !== 'undefined' && mdMode && typeof mdHighlightNode === 'function'){
    mdHighlightNode(id);
  }
  return true;
}
// Re-parent a node and propagate the new side down its subtree
function reparent(childId, newParentId){
  const did=applySelectionMove([childId], newParentId, 'on');
  if(did) toast(rmsTf('tReparented','Moved under “%s”', nodeTextPlain(map.nodes[newParentId].text)||'…'));
  return did;
}
function applySelectionMove(dragIds, targetId, mode){
  if(typeof READONLY!=='undefined' && READONLY) return false;
  if(!map) return false;
  const roots=selectionMoveRoots(dragIds, map.nodes, map.rootId);
  const did=computeSelectionMove(map, roots, targetId, mode);
  if(!did) return false;
  opLog('move', {id:roots[0], to:targetId, mode, text:String(roots.length)});
  pushHistory();
  autoLayout();
  return true;
}
// Reposition an existing subtree to sit cleanly as a child of `parentId`,
// shifting the whole subtree rigidly (preserves its internal arrangement).
function placeReparentedSubtree(childId, parentId){
  const child=map.nodes[childId], parent=map.nodes[parentId];
  if(!child||!parent) return;
  const layout=map.layout||'balanced';
  const sibs=childrenOf(parentId).filter(c=>c!==childId && map.nodes[c].side===child.side);
  const cw=child.w||120, ch=child.h||40;
  let tx, ty;
  if(layout==='down'){
    const childY=parent.y+(parent.h||40)+DOWN_VGAP;
    if(sibs.length){
      let maxRight=-Infinity, y=childY;
      sibs.forEach(s=>{ const sn=map.nodes[s]; maxRight=Math.max(maxRight,sn.x+(sn.w||120)); y=sn.y; });
      tx=maxRight+DOWN_HGAP; ty=y;
    } else { tx=parent.x+((parent.w||120)-cw)/2; ty=childY; }
  } else {
    const dir=child.side==='left'?-1:1;
    if(sibs.length){
      let maxBottom=-Infinity, colX=null;
      sibs.forEach(s=>{ const sn=map.nodes[s]; const b=sn.y+(sn.h||40); if(b>maxBottom)maxBottom=b; colX=sn.x; });
      ty=maxBottom+VGAP;
      tx=(colX!=null)?colX:(dir>0?parent.x+(parent.w||120)+HGAP:parent.x-cw-HGAP);
    } else {
      tx=dir>0?parent.x+(parent.w||120)+HGAP:parent.x-cw-HGAP;
      ty=parent.y+((parent.h||40)-ch)/2;
    }
  }
  shiftSubtreeBy(childId, tx-child.x, ty-child.y);
}

function clientToMap(cx, cy){
  const p=_stagePoint(cx, cy);
  return {x:(p.x-view.x)/view.k, y:(p.y-view.y)/view.k};
}
function updateMarqueeEl(m){
  let el=$('#marquee');
  if(!el){
    el=document.createElement('div');
    el.id='marquee'; el.className='marquee';
    document.body.appendChild(el);
  }
  el.style.left=Math.min(m.x0,m.x1)+'px';
  el.style.top=Math.min(m.y0,m.y1)+'px';
  el.style.width=Math.abs(m.x1-m.x0)+'px';
  el.style.height=Math.abs(m.y1-m.y0)+'px';
  return el;
}
// Runs at most once per frame while ⌘-dragging a marquee. Node rects are
// cached on the marquee and re-read only when the camera has moved.
let _marqueeRAF=0;
function applyMarqueeFrame(){
  _marqueeRAF=0;
  const m=marquee;
  if(!m || !m.moved || !map) return;
  const camKey=view.x+','+view.y+','+view.k;
  if(!m.rects || m.rectsCam!==camKey){
    m.rects=marqueeRectsFromEls(viewport.querySelectorAll('.node'));   // reads first…
    m.rectsCam=camKey;
  }
  updateMarqueeEl(m);                                                 // …then writes
  const hits=nodesInMarqueeRects(m.rects, mapRectFromCorners(m.x0, m.y0, m.x1, m.y1));
  const key=hits.join('\n');
  m.hits=hits;
  if(key!==m.hitsKey){ m.hitsKey=key; paintMarqueeHits(hits); }
}
function paintMarqueeHits(ids){
  const set=new Set(ids||[]);
  viewport.querySelectorAll('.node').forEach(n=>n.classList.toggle('marquee-hit', set.has(n.dataset.id)));
}
function endMarquee(cancel){
  if(_marqueeRAF){
    cancelAnimationFrame(_marqueeRAF); _marqueeRAF=0;
    if(!cancel) applyMarqueeFrame();   // commit the final pointer position's hits
  }
  document.body.classList.remove('marquee-selecting');
  $('#marquee')?.remove();
  document.querySelectorAll('.node.marquee-hit').forEach(n=>n.classList.remove('marquee-hit'));
  const m=marquee; marquee=null;
  if(!m || cancel || !map) return;
  if(!m.moved){
    if(m.startId) toggleMultiSelect(m.startId);
    return;
  }
  const hits=(m.hits||[]).filter(id=>map.nodes[id]);
  if(m.additive){
    hits.forEach(id=>multiSel.add(id));
    if(sel) multiSel.add(sel);
    if(multiSel.size<=1){
      const only=hits[0] || sel;
      multiSel.clear();
      if(only) select(only, false);
      updateMultiSelUI();
      return;
    }
    if(!sel || !multiSel.has(sel)) select(hits[0]||[...multiSel][0], false);
    updateMultiSelUI();
    return;
  }
  if(hits.length===0){
    clearMultiSelect();
    return;
  }
  if(hits.length===1){
    clearMultiSelect();
    select(hits[0], false);
    return;
  }
  multiSel=new Set(hits);
  if(!sel || !multiSel.has(sel)) select(hits[0], false);
  updateMultiSelUI();
}
function clearDragGhosts(){
  document.querySelectorAll('.node.drag-ghost').forEach(n=>n.classList.remove('drag-ghost'));
}
function finishNodeDrop(){
  if(typeof _liveEditing!=='undefined' && _liveEditing){
    cancelNodeDrag();
    return;
  }
  const roots=(dragRoots && dragRoots.length) ? dragRoots : (dragNode && dragNode!==map.rootId ? [dragNode] : []);
  let did=false;
  if(dropTarget && roots.length){
    did=applySelectionMove(roots, dropTarget.id, dropTarget.mode);
    if(!did && moved) autoLayout();
    if(did){
      if(roots.length>1) toast(rmsTf('tMovedTopics','Moved %s topics', roots.length));
      else if(dropTarget.mode==='on') toast(rmsTf('tReparented','Moved under “%s”', nodeTextPlain(map.nodes[dropTarget.id].text)||'…'));
    }
  } else if(moved){
    autoLayout();
  } else if(dragNode && multiSel.size>=2 && multiSel.has(dragNode)){
    // Click without drag on a member of a group: make it the sole selection.
    clearMultiSelect();
    select(dragNode, false);
  }
  setDropTarget(null);
  dragNode=null;
  dragRoots=null;
  clearDragGhosts();
}

if(typeof window!=='undefined' && window.addEventListener){
  window.addEventListener('dragstart', e=>{
    // WKWebView starts a native HTML5 drag on nodes; mouseup never reaches us,
    // so nest / reorder looks like it "disappeared". Chrome respects user-select.
    if(e.target && e.target.closest && e.target.closest('.node, #stage, #viewport')){
      e.preventDefault();
    }
  }, true);
  window.addEventListener('selectstart', e=>{
    const editing = e.target && e.target.closest && e.target.closest('.node.editing, .edit-float');
    if(editing) return;
    if(canvasGestureBlocksTextSelection({dragNode, marquee, resizing, panning})
       || document.body.classList.contains('node-dragging')
       || document.body.classList.contains('marquee-selecting')){
      e.preventDefault();
    }
  }, true);
}
stage.addEventListener('mousedown',e=>{
  // Don't intercept clicks on the chrome / overlay UI.
  if(e.target.closest('.topbar, .zoombar, .hint, .toast, .nodebar, .empty, .search-wrap, .save-pill, .tb-group, .side, .picker, .minimap, .breadcrumb, .wheel-speed, .bulk-bar, .edit-float')) return;
  const nodeEl=e.target.closest('.node');
  // If the click lands inside a node that's currently being edited, let
  // contentEditable handle it natively (text selection, cursor placement).
  // Stage MUST NOT start panning here — that would clear the selection and
  // tear down the format toolbar.
  if(nodeEl && nodeEl.classList.contains('editing')) return;
  const pt=_evtXY(e);
  // ⌘/Ctrl held: box-select (or click-toggle). Never pan, never start a node drag.
  if(isBoxSelectModifier(e) && e.button===0 && !linkMode && !reparentMode){
    e.preventDefault();
    marquee={
      x0:e.clientX, y0:e.clientY, x1:e.clientX, y1:e.clientY,
      additive:!!e.shiftKey,
      startId:nodeEl ? nodeEl.dataset.id : null,
      moved:false,
      hits:[]
    };
    document.body.classList.add('marquee-selecting');
    return;
  }
  if(nodeEl){
    const id=nodeEl.dataset.id;
    // Link mode: the next node click completes (or toggles) a cross-link
    if(linkMode && !e.shiftKey){
      completeLink(id);
      return;
    }
    // Re-parent mode: the next plain node click chooses the new parent
    if(reparentMode && !e.shiftKey){
      bulkReparent(id);
      return;
    }
    // Shift-click toggles multi-selection (no drag, keep primary sel intact)
    if(e.shiftKey){
      toggleMultiSelect(id);
      return;
    }
    const wasSelected = sel===id;
    const inGroup = multiSel.size && (multiSel.has(id) || id===sel);
    const now=Date.now();
    const dbl=isNodeDoubleClick(_nodeClickStamp, id, now, NODE_DBLCLICK_MS);
    const imgNode=nodeHasImage(map.nodes[id]);
    if(imgNode && dbl){
      _nodeClickStamp={id:null,t:0};
      _pendingImageOpen=null;
      e.preventDefault();
      cancelNodeDrag();
      openNodeImageLightbox(id);
      return;
    }
    if(!inGroup){
      if(multiSel.size) clearMultiSelect();
      select(id,false,true);
    } else {
      select(id,false,true);
    }
    if(dbl){
      _nodeClickStamp={id:null,t:0};
      e.preventDefault();
      cancelNodeDrag();
      if(!READONLY) startEdit(id);
      return;
    }
    _pendingImageOpen = (imgNode && wasSelected) ? {id} : null;
    _nodeClickStamp={id,t:now};
    if(READONLY) return;          // view-only: allow selection, no dragging/editing
    if(!shouldStartNodeDrag(e.detail)){
      e.preventDefault();
      cancelNodeDrag();
      return;
    }
    e.preventDefault();           // WK otherwise starts a text selection across every card
    clearCanvasTextSelection();
    dragNode=id; moved=false;
    if(id===map.rootId) dragRoots=[];
    else if(inGroup){
      dragRoots=selectionMoveRoots([...multiSel], map.nodes, map.rootId);
      if(!dragRoots.length) dragRoots=[id];
    } else {
      dragRoots=[id];
    }
    // Defer staging the subtree-drag until the pointer actually moves. Staging it
    // here walks the node's whole subtree, which makes selecting a large branch
    // (e.g. the root of a big map) slow — a plain click should be instant.
    dragStart={ mx:pt.x, my:pt.y, rawX:pt.rawX, rawY:pt.rawY, root:id, subtree:null };
  } else {
    if(reparentMode){ reparentMode=false; hideBulkBar(); updateMultiSelUI(); }
    if(linkMode) cancelLinkMode();
    e.preventDefault();
    clearCanvasTextSelection();
    panning=true; panStart={x:pt.x,y:pt.y,vx:view.x,vy:view.y};
    if(sel){
      sel=null;
      if(pendingNodeTyping()) discardEditOverlay();
      document.querySelectorAll('.node.sel').forEach(n=>n.classList.remove('sel'));
      $('#nodebar')?.remove();
    }
    if(multiSel.size) clearMultiSelect();
  }
});
// Drag/resize do O(n) work (rebuild all edges, find a drop target) per move.
// Mouse moves can fire faster than the screen refreshes, so we coalesce the heavy
// work to one update per animation frame and reuse the hidden-set for the whole
// gesture (it can't change mid-drag). Keeps drag smooth on big maps / low-end.
let _moveRAF=0, _movePt=null, _dragHidden=null;
function _applyMove(){
  _moveRAF=0;
  const e=_movePt; if(!e) return;
  const hidden = _dragHidden || (_dragHidden = hiddenSet());
  if(resizing){
    const sc=view.k*_uiZ();
    const dx=(e.x-resizing.sx)/sc, dy=(e.y-resizing.sy)/sc;
    const n=map.nodes[resizing.id];
    n.width=Math.max(60, Math.round(resizing.sw+dx));
    n.height=Math.max(30, Math.round(resizing.sh+dy));
    const el=document.querySelector(`.node[data-id="${resizing.id}"]`);
    if(el){ el.style.width=n.width+'px'; el.style.maxWidth='none'; el.style.height=n.height+'px'; n.w=n.width; n.h=n.height; }
    drawEdges(hidden);
    repositionNodeBar();
  } else if(dragNode && moved){
    const sc=view.k*_uiZ();
    const dx=(e.x-dragStart.mx)/sc, dy=(e.y-dragStart.my)/sc;
    // Stage the subtree the first time a real drag begins (not on click).
    const grab=(dragRoots && dragRoots.length) ? dragRoots : dragNode;
    if(!dragStart.subtree) dragStart=beginSubtreeDrag(grab, dragStart.mx, dragStart.my);
    applySubtreeDelta(dragStart, dx, dy);
    drawEdges(hidden);
    repositionNodeBar();
    // Detect a drop target under the cursor (only after a real drag has started)
    if(dragRoots && dragRoots.length) setDropTarget(findDropTarget(e.x, e.y, e.rawX, e.rawY));
    else if(dragNode!==map.rootId) setDropTarget(findDropTarget(e.x, e.y, e.rawX, e.rawY));
  }
}
window.addEventListener('mousemove',e=>{
  if(!marquee && !panning && !resizing && !dragNode) return;
  const pt=_evtXY(e);
  if(marquee){
    e.preventDefault();
    marquee.x1=e.clientX; marquee.y1=e.clientY;
    if(Math.abs(marquee.x1-marquee.x0)+Math.abs(marquee.y1-marquee.y0)>4) marquee.moved=true;
    if(marquee.moved && map && !_marqueeRAF) _marqueeRAF=requestAnimationFrame(applyMarqueeFrame);
    return;
  }
  if(panning){
    e.preventDefault();
    const z=_uiZ();
    view.x=panStart.vx+(pt.x-panStart.x)/z; view.y=panStart.vy+(pt.y-panStart.y)/z;
    beginCamGesture();
    scheduleView();
    return;
  }
  if(!resizing && !dragNode) return;
  e.preventDefault();
  // Move-threshold check stays on the raw event so a tiny nudge still registers.
  if(dragNode && !moved){
    const sc=view.k*_uiZ();
    const dx=(pt.x-dragStart.mx)/sc, dy=(pt.y-dragStart.my)/sc;
    if(Math.abs(dx)+Math.abs(dy)>2) moved=true;
  }
  _movePt={x:pt.x, y:pt.y, rawX:pt.rawX, rawY:pt.rawY};
  if(!_moveRAF) _moveRAF=requestAnimationFrame(_applyMove);   // coalesce to one update / frame
});
window.addEventListener('mouseup',e=>{
  document.body.classList.remove('node-dragging');
  if(_moveRAF){ cancelAnimationFrame(_moveRAF); _moveRAF=0; _applyMove(); }
  _movePt=null; _dragHidden=null;
  if(marquee){ endMarquee(false); }
  if(resizing){
    const resizedId=resizing.id;
    resizing = null;
    // Re-tidy so the resized node's new footprint doesn't overlap its
    // neighbours. Needs an explicit render() first, not just autoLayout()
    // alone: during the drag, n.w/n.h were set directly to match the
    // dragged width/height (not measured from the DOM), and the node's
    // height was held to that exact value while actively dragging. But
    // min-height (not a hard cap — see the node rendering code) means the
    // element can actually render TALLER than that dragged value once a
    // normal render() runs, if the content needs more room than what was
    // dragged to. autoLayout() only force-remeasures nodes with NO
    // measurement at all, not ones with a stale one from the drag itself —
    // so without this render() first, it would compute positions (and
    // reserve neighbour spacing) from the stale, too-small dragged size,
    // and the node could then visually overlap a neighbour once it renders
    // at its true, larger size.
    opLog('resize', {id:resizedId});
    render();
    autoLayout();
    pushHistory();
  }
  if(dragNode){
    if((e.detail|0)>=2){
      _pendingImageOpen=null;
      cancelNodeDrag();
    } else {
      const pending=_pendingImageOpen;
      const dropped=dragNode;
      const didMove=moved;
      finishNodeDrop();
      if(pending && pending.id===dropped && !didMove) openNodeImageLightbox(dropped);
      _pendingImageOpen=null;
    }
  }
  if(panning){ panning=false; endCamGesture(); }
});

/* ============================================================
   TOUCH SUPPORT — mirrors the mouse handlers, plus pinch-zoom.
   Single finger: pan the canvas, or drag a node, or tap to select.
   Two fingers: pinch to zoom.
   ============================================================ */
let pinch=null;  // {d0, k0, cx, cy} while pinch-zooming
function tPt(t){ return {clientX:t.clientX, clientY:t.clientY}; }

stage.addEventListener('touchstart', e=>{
  if(!e.touches) return;
  // Pinch starts: two fingers down anywhere on the stage
  if(e.touches.length===2){
    const a=e.touches[0], b=e.touches[1];
    const dx=b.clientX-a.clientX, dy=b.clientY-a.clientY;
    pinch={ d0:Math.hypot(dx,dy), k0:view.k, cx:(a.clientX+b.clientX)/2, cy:(a.clientY+b.clientY)/2 };
    dragNode=null; panning=false; resizing=null;
    e.preventDefault();
    return;
  }
  if(e.touches.length!==1) return;
  const t=e.touches[0];
  // Don't intercept taps on the chrome / overlay UI
  if(t.target && t.target.closest && t.target.closest('.topbar, .zoombar, .hint, .toast, .nodebar, .empty, .search-wrap, .save-pill, .tb-group, .side, .picker, .notes-popup, .theme-panel, .minimap, .breadcrumb, .wheel-speed, .edit-float')) return;
  const nodeEl=t.target.closest?.('.node');
  // Don't pan / drag when tapping inside a node that's being edited —
  // contentEditable needs to handle the touch for caret placement and selection.
  if(nodeEl && nodeEl.classList.contains('editing')) return;
  if(nodeEl){
    const id=nodeEl.dataset.id;
    const wasSelected = sel===id;
    const inGroup = multiSel.size && (multiSel.has(id) || id===sel);
    if(!inGroup && multiSel.size) clearMultiSelect();
    select(id,false);
    _pendingImageOpen = (nodeHasImage(map.nodes[id]) && wasSelected) ? {id} : null;
    panning=false;                       // drop any stale pan state from an interrupted gesture
    dragNode=id; moved=false;
    if(id===map.rootId) dragRoots=[];
    else if(inGroup){
      dragRoots=selectionMoveRoots([...multiSel], map.nodes, map.rootId);
      if(!dragRoots.length) dragRoots=[id];
    } else dragRoots=[id];
    // Defer the subtree walk until the finger actually moves, so a plain tap stays
    // instant even on a large map. (The mouse path does the same; walking eagerly on
    // every touch froze selection on big maps / low-end Android.)
    dragStart={ mx:t.clientX, my:t.clientY, root:id, subtree:null };
  } else {
    dragNode=null;                       // drop any stale drag state from an interrupted gesture
    panning=true; panStart={x:t.clientX,y:t.clientY,vx:view.x,vy:view.y};
    if(sel){ sel=null; if(pendingNodeTyping()) discardEditOverlay(); document.querySelectorAll('.node.sel').forEach(n=>n.classList.remove('sel')); $('#nodebar')?.remove(); }
  }
}, {passive:false});

window.addEventListener('touchmove', e=>{
  if(!e.touches) return;
  if(pinch && e.touches.length===2){
    const a=e.touches[0], b=e.touches[1];
    const d=Math.hypot(b.clientX-a.clientX, b.clientY-a.clientY);
    const k=Math.min(3, Math.max(0.1, pinch.k0 * (d/pinch.d0)));
    const p=_stagePoint(pinch.cx, pinch.cy);
    const px=p.x, py=p.y;
    const old=view.k;
    view.x = px-(px-view.x)*(k/old); view.y = py-(py-view.y)*(k/old); view.k = k; userZoom=k;
    beginCamGesture();
    scheduleView();
    e.preventDefault(); return;
  }
  if(e.touches.length!==1) return;
  const t=e.touches[0];
  if(dragNode){
    const sc=view.k*_uiZ();
    const dx=(t.clientX-dragStart.mx)/sc, dy=(t.clientY-dragStart.my)/sc;
    if(Math.abs(dx)+Math.abs(dy)>2) moved=true;
    _movePt={clientX:t.clientX, clientY:t.clientY};
    if(!_moveRAF) _moveRAF=requestAnimationFrame(_applyMove);   // coalesce to one update/frame + reuse the cached hidden-set, same as the mouse path — touch can sample well above 60Hz
    e.preventDefault();
  } else if(panning){
    const z=_uiZ();
    view.x=panStart.vx+(t.clientX-panStart.x)/z; view.y=panStart.vy+(t.clientY-panStart.y)/z;
    beginCamGesture();
    scheduleView();
    e.preventDefault();
  }
}, {passive:false});

window.addEventListener('touchend', e=>{
  const remaining = e.touches ? e.touches.length : 0;
  if(pinch && remaining<2){ pinch=null; }
  if(remaining>0) return;              // still touching
  document.body.classList.remove('node-dragging');
  if(_moveRAF){ cancelAnimationFrame(_moveRAF); _moveRAF=0; _applyMove(); }
  _movePt=null; _dragHidden=null;
  if(dragNode){
    const pending=_pendingImageOpen;
    const dropped=dragNode;
    const didMove=moved;
    finishNodeDrop();
    if(pending && pending.id===dropped && !didMove) openNodeImageLightbox(dropped);
    _pendingImageOpen=null;
  }
  if(panning){ panning=false; endCamGesture(); }
  else if(_camLive) endCamGesture();
});

// Android (esp. 16) fires touchcancel whenever the system/browser reclaims a gesture
// (scroll takeover, navigation, app switch, etc.). Without this, touchend never runs,
// so dragNode/panning/pinch stay set and every later touch is mis-read as a continuing
// drag — the canvas looks frozen. Reset all gesture state defensively.
function syncMarqueeCursor(e){
  const on=isBoxSelectModifier(e) && !document.querySelector('.node.editing');
  document.body.classList.toggle('marquee-ready', on && !marquee);
}
window.addEventListener('keydown', syncMarqueeCursor);
window.addEventListener('keyup', syncMarqueeCursor);
window.addEventListener('blur', ()=>document.body.classList.remove('marquee-ready'));

window.addEventListener('touchcancel', ()=>{
  document.body.classList.remove('node-dragging');
  if(_moveRAF){ cancelAnimationFrame(_moveRAF); _moveRAF=0; }
  _movePt=null; _dragHidden=null;
  if(dragNode){ setDropTarget(null); dragNode=null; dragRoots=null; clearDragGhosts(); }
  if(marquee) endMarquee(true);
  if(panning){ panning=false; endCamGesture(); }
  pinch=null; resizing=null; moved=false;
});

// Double-tap to edit (since dblclick doesn't fire reliably on touch)
let lastTap=0, lastTapId=null;
stage.addEventListener('touchend', e=>{
  const t=e.changedTouches?.[0]; if(!t) return;
  const nodeEl=t.target.closest?.('.node');
  if(!nodeEl) { lastTap=0; return; }
  const id=nodeEl.dataset.id, now=Date.now();
  if(id===lastTapId && now-lastTap<350){
    lastTap=0;
    if(nodeHasImage(map.nodes[id])){
      openNodeImageLightbox(id);
      return;
    }
    startEdit(id);
  }
  else { lastTap=now; lastTapId=id; }
});

// 100% matches the historical per-tick factors (1.12 in / 0.89 out).
// 0% leaves the camera still so the IME / trackpad can settle.
const WHEEL_ZOOM_IN=1.12, WHEEL_ZOOM_OUT=0.89;
const WHEEL_SPEED_KEY='mindspark:wheelSpeed';
const WHEEL_SPEED_DEFAULT=40;
function clampWheelSpeed(n){
  if(!Number.isFinite(n)) return WHEEL_SPEED_DEFAULT;
  return Math.max(0, Math.min(100, Math.round(n)));
}
function wheelZoomFactor(deltaY, speedPct){
  const s=clampWheelSpeed(speedPct)/100;
  if(deltaY<0) return 1+(WHEEL_ZOOM_IN-1)*s;
  return 1-(1-WHEEL_ZOOM_OUT)*s;
}
function readWheelSpeed(){
  try{
    const v=parseFloat(localStorage.getItem(WHEEL_SPEED_KEY));
    if(Number.isFinite(v)) return clampWheelSpeed(v);
  }catch(e){}
  return WHEEL_SPEED_DEFAULT;
}
let wheelSpeed=readWheelSpeed();

function wheelConsumedByScrollable(e){
  const box=e.target && e.target.closest && e.target.closest('.table-node .node-block, .node.has-md-table .node-text');
  if(!box) return false;
  const dy=e.deltaY||0, dx=e.deltaX||0;
  if(Math.abs(dy)>=Math.abs(dx)){
    if(dy<0 && box.scrollTop>0) return true;
    if(dy>0 && box.scrollTop+box.clientHeight<box.scrollHeight-1) return true;
  } else {
    if(dx<0 && box.scrollLeft>0) return true;
    if(dx>0 && box.scrollLeft+box.clientWidth<box.scrollWidth-1) return true;
  }
  return false;
}
stage.addEventListener('wheel',e=>{
  if(e.target && e.target.closest && e.target.closest('.wheel-speed')) return;
  if(wheelConsumedByScrollable(e)) return;
  e.preventDefault();
  const p=_stagePointCam(e.clientX, e.clientY);
  const px=p.x, py=p.y;
  const old=view.k;
  const factor=wheelZoomFactor(e.deltaY, wheelSpeed);
  if(factor===1) return;
  const k=Math.min(3,Math.max(.1, view.k*factor));
  if(k===old) return;
  view.x=px-(px-view.x)*(k/old); view.y=py-(py-view.y)*(k/old); view.k=k; userZoom=k;
  beginCamGesture();
  scheduleView();
  if(_wheelIdle) clearTimeout(_wheelIdle);
  _wheelIdle=setTimeout(()=>{ _wheelIdle=0; endCamGesture(); }, 140);
},{passive:false});

function zoom(f){ const {w,h}=_stageSize();const px=w/2,py=h/2;const old=view.k;
  const k=Math.min(3,Math.max(.1,view.k*f));
  const tx=px-(px-view.x)*(k/old), ty=py-(py-view.y)*(k/old);
  userZoom=k;
  animateViewTo({x:tx,y:ty,k}, 160, saveMapView);
}
function setZoom(percent){
  const {w,h}=_stageSize();const px=w/2,py=h/2;const old=view.k;
  const k=Math.min(3,Math.max(.1, percent/100));
  const tx=px-(px-view.x)*(k/old), ty=py-(py-view.y)*(k/old);
  userZoom=k;
  animateViewTo({x:tx,y:ty,k}, 160, saveMapView);
}
function computeFitView(){   // pure calculation — does not touch `view` or the DOM
  if(!map) return null;
  const xs=[],ys=[],xe=[],ye=[];
  const hidden=hiddenSet();
  for(const id in map.nodes){ if(hidden.has(id))continue; const n=map.nodes[id];xs.push(n.x);ys.push(n.y);xe.push(n.x+(n.w||120));ye.push(n.y+(n.h||40)); }
  if(!xs.length) return null;
  const minx=Math.min(...xs),miny=Math.min(...ys),maxx=Math.max(...xe),maxy=Math.max(...ye);
  const {w:SW,h:SH}=_stageSize();
  // If the stage hasn't been laid out yet (e.g. fit() called during initial boot
  // before first paint), bail rather than computing a view that throws the map
  // off-screen — the caller should re-fit once layout settles.
  if(!(SW>1) || !(SH>1)) return null;
  const cw=Math.max(1,maxx-minx), ch=Math.max(1,maxy-miny);
  // Scale the map's bounding box to fit the viewport with a margin. Cap at 100%
  // so a tiny map isn't magnified; this is what makes a big map auto-shrink to
  // fit a smaller screen instead of overflowing at full size.
  const margin=64;
  const availW=Math.max(120, SW - margin*2);
  const availH=Math.max(120, SH - margin*2);
  const k=Math.max(0.1, Math.min(availW/cw, availH/ch, 1));
  return { x: SW/2 - (minx+cw/2)*k, y: SH/2 - (miny+ch/2)*k, k };
}
function fit(){
  const t=computeFitView(); if(!t) return;
  view.x=t.x; view.y=t.y; view.k=t.k;
  applyView(); _markStage();
}
// Smoothly tweens the canvas pan/zoom to a target view over `duration` ms — used where an
// instant fit()/recenter() snap would read as a jarring jump right after something else (like
// the Markdown pane's own CSS width transition) already animated smoothly. Same easing curve
// family as the pane's `cubic-bezier(.4,0,.2,1)` transition, so the two motions read as one
// continuous, cohesive movement rather than "slide, then snap".
let _viewAnimRAF=0;
function animateViewTo(target, duration, onDone){
  if(!target) return;
  cancelAnimationFrame(_viewAnimRAF);
  if(typeof window!=='undefined' && window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches){
    view.x=target.x; view.y=target.y; view.k=target.k; applyView(); _markStage(); if(onDone) onDone(); return;
  }
  const start={x:view.x, y:view.y, k:view.k};
  const t0=(typeof performance!=='undefined' ? performance.now() : Date.now());
  const ease=p=>1-Math.pow(1-p,3);   // ease-out cubic
  const step=(now)=>{
    const p=Math.min(1, (now-t0)/duration);
    const e=ease(p);
    view.x=start.x+(target.x-start.x)*e;
    view.y=start.y+(target.y-start.y)*e;
    view.k=start.k+(target.k-start.k)*e;
    applyViewTransform();
    if(p<1) _viewAnimRAF=requestAnimationFrame(step);
    else { applyView(); _markStage(); if(onDone) onDone(); }
  };
  _viewAnimRAF=requestAnimationFrame(step);
}
// Centre the map's bounding box in the current stage viewport WITHOUT changing
// zoom — used when the viewport size changes (e.g. entering/leaving focus mode)
// so the map doesn't appear to jump sideways.
function computeRecenterView(){   // pure calculation — does not touch `view` or the DOM
  if(!map) return null;
  const hidden=hiddenSet();
  let minx=Infinity,miny=Infinity,maxx=-Infinity,maxy=-Infinity;
  for(const id in map.nodes){
    if(hidden.has(id)) continue;
    const n=map.nodes[id];
    minx=Math.min(minx,n.x); miny=Math.min(miny,n.y);
    maxx=Math.max(maxx,n.x+(n.w||120)); maxy=Math.max(maxy,n.y+(n.h||40));
  }
  if(!isFinite(minx)) return null;
  const {w:SW,h:SH}=_stageSize();
  const cx=(minx+maxx)/2, cy=(miny+maxy)/2;
  return { x: SW/2 - cx*view.k, y: SH/2 - cy*view.k, k: view.k };
}
function recenter(){
  const t=computeRecenterView(); if(!t) return;
  view.x=t.x; view.y=t.y;
  applyView(); _markStage();
}

/* ============================================================
   KEYBOARD
   ============================================================ */
// Navigate from `id` in the direction of an arrow key, respecting current layout.
function navTarget(id, key){
  if(!map||!map.nodes[id]) return null;
  const n=map.nodes[id];
  const layout=map.layout||'balanced';
  const kids=childrenOf(id);
  const parent=n.parent;
  const siblings=parent ? childrenOf(parent) : [];
  const idxInSiblings=siblings.indexOf(id);
  const firstVisible=cs=>(cs.length && !n.collapsed) ? cs[0] : null;
  const sibAt=delta=>{
    const i=idxInSiblings+delta;
    return (i>=0 && i<siblings.length) ? siblings[i] : null;
  };
  if(layout==='down'){
    if(key==='ArrowDown')  return firstVisible(kids) || sibAt(1);
    if(key==='ArrowUp')    return parent || sibAt(-1);
    if(key==='ArrowLeft')  return sibAt(-1);
    if(key==='ArrowRight') return sibAt(1);
  } else {
    const side=n.side; // 'root', 'left', 'right'
    if(key==='ArrowLeft'){
      if(id===map.rootId){
        const lk=kids.filter(k=>map.nodes[k].side==='left');
        if(lk.length && !n.collapsed) return lk[0];
      }
      if(side==='right'||side==='root') return parent;
      if(side==='left') return firstVisible(kids);
    }
    if(key==='ArrowRight'){
      if(id===map.rootId){
        const rk=kids.filter(k=>map.nodes[k].side!=='left');
        if(rk.length && !n.collapsed) return rk[0];
      }
      if(side==='left'||side==='root') return parent;
      if(side==='right') return firstVisible(kids);
    }
    if(key==='ArrowUp')   return sibAt(-1);
    if(key==='ArrowDown') return sibAt(1);
  }
  return null;
}

// ---- Modal keyboard isolation ----
// While a dialog-like surface is open the canvas takes no keys: Backspace,
// Tab or a letter would otherwise edit the map hidden behind it.
function topModalEl(){
  if(typeof document==='undefined' || !document.querySelectorAll) return null;
  const all=document.querySelectorAll('.var-form, .kb-help, .hist-panel');
  if(!all.length) return null;
  return document.querySelector('.var-form.rms-dialog') || all[all.length-1];
}
function closeModalOnEscape(m){
  if(!m) return false;
  // rms-settings.js owns Escape there (it also cancels shortcut recording).
  if(m.classList.contains('rms-settings')) return false;
  if(m.classList.contains('hist-panel')){
    const x=m.querySelector('.hist-x');
    if(x) x.click(); else m.remove();
    return true;
  }
  const btn=m.querySelector('.vf-cancel, .vf-close, .kb-close')
    || (m.classList.contains('rms-dialog') ? m.querySelector('.vf-go') : null);
  if(btn) btn.click(); else m.remove();
  return true;
}
// Esc closes the topmost transient surface: context/row menus, pickers,
// template/export/theme menus, then the diff panel. True if it closed one.
function closeTransientOnEscape(){
  const menuSel='.rms-ctx, .tpl-pop, .export-pop, .row-pop, .picker';
  const hasMenu=!!document.querySelector(menuSel)
    || (typeof themePanel!=='undefined' && !!themePanel);
  if(hasMenu){
    closeAllMenus();
    if(typeof closeNodeHrefMenu==='function') closeNodeHrefMenu();
    if(typeof closeTextEditContextMenu==='function') closeTextEditContextMenu();
    document.querySelectorAll(menuSel).forEach(p=>p.remove());
    return true;
  }
  const diff=document.querySelector('.diff-panel');
  if(diff){ diff.remove(); return true; }
  return false;
}

// Reorder must run in capture: Option/Alt+arrows are often swallowed by the OS,
// Raycast, or the browser before bubble listeners see e.key === 'ArrowDown'.
// e.code is the physical key, which stays ArrowUp/Down even when Option remaps e.key.
// Fallback: Ctrl/⌘+Shift+↑↓ when Alt is taken.
window.addEventListener('keydown', e=>{
  if(clipboardEditAction(e)) return;
  if(isImeEvent(e)) return;
  if(topModalEl()) return;
  if(document.querySelector('.node.editing')) return;
  if(e.target && e.target.isContentEditable && !pendingNodeTyping()) return;
  if(e.target && e.target.closest && e.target.closest('#mdPane')) return;
  const dir = (e.code==='ArrowUp' || e.key==='ArrowUp') ? 'up'
            : (e.code==='ArrowDown' || e.key==='ArrowDown') ? 'down'
            : null;
  if(!dir) return;
  const up = dir==='up';
  const altDefault = e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey;
  const chordDefault = e.shiftKey && (e.ctrlKey || e.metaKey) && !e.altKey;
  const hit = up
    ? (rms('moveSiblingUp', e, altDefault) || rms('moveSiblingUpAlt', e, chordDefault))
    : (rms('moveSiblingDown', e, altDefault) || rms('moveSiblingDownAlt', e, chordDefault));
  if(!hit) return;
  if(!sel || !map) return;
  e.preventDefault();
  e.stopPropagation();
  moveSibling(sel, dir);
}, true);

window.addEventListener('keydown',e=>{
  if(isImageLightboxOpen()){
    if(e.key==='Escape'){ e.preventDefault(); e.stopPropagation(); closeImageLightbox(); }
    return;
  }
  if(clipboardEditAction(e)) return;
  const modal=topModalEl();
  if(modal){
    // Only Escape, and only to close something; nothing reaches the canvas.
    // rms-settings.js handles its own Escape (settings and shortcut recording).
    if(e.key==='Escape' && !e.defaultPrevented && !isImeEvent(e) && !modal.classList.contains('rms-settings')){
      if(closeTransientOnEscape() || closeModalOnEscape(modal)) e.preventDefault();
    }
    return;
  }
  if(['INPUT','TEXTAREA'].includes(e.target.tagName)||(e.target.isContentEditable && !pendingNodeTyping())||document.querySelector('.node.editing')) return;
  if(isImeEvent(e)){
    if(sel && map && !READONLY && !e.metaKey && !e.ctrlKey && !e.altKey) startEdit(sel);
    return;
  }
  if(rms('undo', e, (e.ctrlKey||e.metaKey)&&!e.shiftKey&&e.key.toLowerCase()==='z')){e.preventDefault();performHistoryChord('undo');return;}
  if(rms('redo', e, (e.ctrlKey||e.metaKey)&&e.shiftKey&&e.key.toLowerCase()==='z') || ((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='y')){e.preventDefault();performHistoryChord('redo');return;}
  if(e.key==='Escape'){
    if(closeTransientOnEscape()){ e.preventDefault(); return; }
    if(marquee){ e.preventDefault(); endMarquee(true); return; }
    if(linkMode){ e.preventDefault(); cancelLinkMode(); return; }
    if(multiSel.size){ e.preventDefault(); clearMultiSelect(); return; }
  }
  if(!sel||!map) return;
  if((e.metaKey||e.ctrlKey) && e.shiftKey && !e.altKey && (e.code==='KeyA' || (e.key||'').toLowerCase()==='a')){
    if(selectSiblingsOnCanvas()) e.preventDefault();
    return;
  }
  if(rms('addChild', e, e.key==='Tab' && !e.metaKey && !e.ctrlKey && !e.altKey)){e.preventDefault();addNode(sel,false);}
  else if(rms('addSibling', e, e.key==='Enter' && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey)
       || rms('addSiblingMod', e, e.key==='Enter' && (e.metaKey||e.ctrlKey) && !e.shiftKey && !e.altKey)){
    e.preventDefault();addNode(sel,true);
  }
  else if(rms('deleteNode', e, e.key==='Backspace') || rms('deleteForward', e, e.key==='Delete')){
    e.preventDefault();
    if(multiSel.size>=2) bulkDelete();
    else deleteNode(sel);
  }
  else if(rms('editNode', e, e.key==='F2')){e.preventDefault();startEdit(sel);}
  else if(rms('collapse', e, e.key===' ' && !e.ctrlKey && !e.metaKey && !e.altKey)){e.preventDefault();const n=map.nodes[sel];if(childrenOf(sel).length){n.collapsed=!n.collapsed;opLog(n.collapsed?'collapse':'expand',{id:sel});pushHistory();autoLayout();}}
  else if(e.key==='ArrowLeft'||e.key==='ArrowRight'||e.key==='ArrowUp'||e.key==='ArrowDown'){
    e.preventDefault();
    const next=navTarget(sel, e.key);
    if(next) select(next, false);
  }
  else if(rms('link', e, e.key==='l'||e.key==='L')){
    e.preventDefault();
    startLinkMode(sel);
  }
  else if(e.key.length===1&&!e.ctrlKey&&!e.metaKey){
    if(pendingNodeTyping() && e.target===openEditorTextEl()) return;
    if(isImeSwitchEvent(e) || e.altKey) return;
    e.preventDefault();
    startEdit(sel);
    const host=openEditorTextEl();
    if(!host) return;
    insertEditorText(host, e.key, true);
    clearEditReplaceAll();
    emitEditorInput(host);
  }
});
stage.addEventListener('dblclick',e=>{
  const nEl=e.target.closest('.node');
  if(!nEl) return;
  e.preventDefault();
  cancelNodeDrag();
  if(nodeHasImage(map.nodes[nEl.dataset.id])){
    openNodeImageLightbox(nEl.dataset.id);
    return;
  }
  if(!READONLY) startEdit(nEl.dataset.id);
});
// The stage clips overflow, but the browser can still programmatically scroll it
// to bring a focused/oversized node's caret into view (e.g. after pasting a large
// block while editing). Panning is done entirely via the #viewport transform, so
// the stage must never scroll — any scroll would drag the absolutely-positioned
// topbar and hint out of place (the fixed zoombar is unaffected). Lock it.
stage.addEventListener('scroll',()=>{ if(stage.scrollLeft||stage.scrollTop){ stage.scrollLeft=0; stage.scrollTop=0; } },{passive:true});

/* ============================================================
   SEARCH
   ============================================================ */
let searchMatches=[], searchPos=-1;
let searchReveal=null;
let searchAutoExpanded=new Set();

// node -> {raw, plain}. The raw text is the validity key: an edited node
// misses and is re-stripped; untouched nodes skip the HTML parse per keystroke.
const _searchTextCache=new WeakMap();
function nodeSearchText(n){
  if(!n) return '';
  const raw = n.text || '';
  if(typeof hasInlineMarkup==='function' && hasInlineMarkup(raw) && typeof nodeTextPlain==='function'){
    const hit=_searchTextCache.get(n);
    if(hit && hit.raw===raw) return hit.plain;
    const plain=nodeTextPlain(raw);
    _searchTextCache.set(n, {raw, plain});
    return plain;
  }
  return raw;
}
function searchWalkIds(){
  const ids=[];
  if(!map || !map.rootId || !map.nodes) return ids;
  const walk=id=>{
    if(!id || !map.nodes[id]) return;
    ids.push(id);
    const kids = typeof childrenOf==='function' ? childrenOf(id) : [];
    for(let i=0;i<kids.length;i++) walk(kids[i]);
  };
  walk(map.rootId);
  return ids;
}
function collectSearchMatches(q){
  q=String(q||'').trim().toLowerCase();
  if(!q || !map || !map.nodes) return [];
  const hits=[];
  const ids=searchWalkIds();
  for(let i=0;i<ids.length;i++){
    const id=ids[i];
    const plain=nodeSearchText(map.nodes[id]);
    if(String(plain).toLowerCase().includes(q)) hits.push(id);
  }
  return hits;
}
function searchCollapsedAncestors(id){
  const out=[];
  let p=map && map.nodes && map.nodes[id] ? map.nodes[id].parent : null;
  while(p){
    const n=map.nodes[p];
    if(!n) break;
    if(n.collapsed) out.push(p);
    p=n.parent;
  }
  return out;
}
function searchExpandAncestors(id){
  const opened=searchCollapsedAncestors(id);
  for(let i=0;i<opened.length;i++){
    const n=map.nodes[opened[i]];
    if(n) n.collapsed=false;
  }
  return opened;
}
function searchIsDescendantOf(id, anc){
  let p=map && map.nodes && map.nodes[id] ? map.nodes[id].parent : null;
  while(p){
    if(p===anc) return true;
    p=map.nodes[p] ? map.nodes[p].parent : null;
  }
  return false;
}
function searchNodeFingerprint(id){
  const n=map && map.nodes ? map.nodes[id] : null;
  if(!n) return null;
  const kids = typeof childrenOf==='function' ? childrenOf(id) : [];
  return JSON.stringify({
    text:n.text||'',
    html:n.html||'',
    notes:n.notes||'',
    parent:n.parent||null,
    task:n.task||'',
    marker:n.marker||'',
    kids
  });
}
function searchNodeWasModified(id, fingerprint){
  if(!id || fingerprint==null) return false;
  return searchNodeFingerprint(id)!==fingerprint;
}
function searchIdsToRestore(autoExpanded, nextId, modified, currentId){
  const skip=new Set();
  if(modified && currentId){
    let p=map && map.nodes && map.nodes[currentId] ? map.nodes[currentId].parent : null;
    while(p){ skip.add(p); p=map.nodes[p] ? map.nodes[p].parent : null; }
  }
  const out=[];
  const list=autoExpanded || [];
  for(let i=0;i<list.length;i++){
    const aid=list[i];
    if(skip.has(aid)) continue;
    if(nextId && searchIsDescendantOf(nextId, aid)) continue;
    out.push(aid);
  }
  return out;
}
function findChordShouldClose(wrapIsOpen, withReplace){
  return !!wrapIsOpen && !withReplace;
}

function openSearch(withReplace){
  const w=$('#searchWrap');
  w.classList.add('open');
  if(withReplace) w.classList.add('replace-mode');
  $('#search').focus(); $('#search').select();
}
function closeSearch(){
  const foldChanged=searchLeaveCurrent(null);
  searchAutoExpanded.clear();
  searchReveal=null;
  if(foldChanged) autoLayout(false, {persist:false});
  const w=$('#searchWrap');
  w.classList.remove('open','replace-mode','all-mode');
  $('#search').value=''; $('#replace').value='';
  $('#searchCount').textContent='';
  $('#allMapsToggle')?.classList.remove('on');
  globalSearchMode=false;
  hideGlobalResults();
  doSearch('');
  if(sel && !mdMode && multiSel.size<2) prepareNodeTyping(sel);
}
let globalSearchMode=false;
$('#allMapsToggle')?.addEventListener('click', ()=>{
  globalSearchMode = !globalSearchMode;
  const w=$('#searchWrap');
  w.classList.toggle('all-mode', globalSearchMode);
  $('#allMapsToggle').classList.toggle('on', globalSearchMode);
  $('#search').placeholder = globalSearchMode ? rmsTr('searchAllPlaceholder','Search ALL maps…') : rmsTr('findPlaceholder','Find in nodes…');
  $('#search').focus();
  if(globalSearchMode){ runGlobalSearch($('#search').value); }
  else { hideGlobalResults(); doSearch($('#search').value); }
});
$('#searchBtn').onclick=()=>{
  const w=$('#searchWrap');
  if(w.classList.contains('open')) closeSearch(); else openSearch(false);
};
$('#replaceToggle').onclick=()=>{ $('#searchWrap').classList.toggle('replace-mode'); $('#replace').focus(); };
$('#search').addEventListener('input',e=>{
  if(globalSearchMode){ runGlobalSearch(e.target.value); return; }
  // Small maps search on every keystroke (feels instant). Large maps
  // debounce so a fast typist does not rescan thousands of nodes per key.
  clearTimeout(_searchInputT); _searchInputT=0;
  if(!map || Object.keys(map.nodes).length<SEARCH_DEBOUNCE_MIN_NODES){ doSearch(); return; }
  _searchInputT=setTimeout(()=>{ _searchInputT=0; doSearch(); }, 80);
});
$('#search').addEventListener('keydown',e=>{
  if(isImeEvent(e)) return;   // Enter/Esc confirm or cancel the IME candidate
  if(e.key==='Escape'){ e.preventDefault(); closeSearch(); }
  if(e.key==='Enter'){ e.preventDefault(); focusNextMatch(e.shiftKey ? -1 : 1); }
});
$('#replace').addEventListener('keydown',e=>{
  if(isImeEvent(e)) return;
  if(e.key==='Escape'){ e.preventDefault(); closeSearch(); }
  if(e.key==='Enter'){ e.preventDefault(); e.shiftKey ? replaceAll() : replaceNext(); }
});
$('#replaceOne').onclick=replaceNext;
$('#replaceAll').onclick=replaceAll;

// Global shortcuts: Ctrl/⌘+F toggles find (second press closes), Ctrl/⌘+H opens find+replace.
// Registered separately so they fire even when a node is being edited.
window.addEventListener('keydown', e=>{
  if(clipboardEditAction(e)) return;
  if(isImeEvent(e) || isImeSwitchEvent(e)) return;
  if(rms('find', e, (e.ctrlKey||e.metaKey) && !e.altKey && !(e.ctrlKey && e.metaKey) && e.key.toLowerCase()==='f')){
    e.preventDefault();
    armEditBlurCommit();
    document.querySelector('.node.editing .node-text')?.blur();
    if(findChordShouldClose($('#searchWrap')?.classList.contains('open'), false)) closeSearch();
    else openSearch(false);
    return;
  }
  if(rms('findReplace', e, (e.ctrlKey||e.metaKey) && !e.altKey && !(e.ctrlKey && e.metaKey) && e.key.toLowerCase()==='h')){
    e.preventDefault();
    armEditBlurCommit();
    document.querySelector('.node.editing .node-text')?.blur();
    openSearch(true);
  }
}, true);  // capture phase — beat the browser's native find on Ctrl/⌘+F

function searchLeaveCurrent(nextId){
  if(!searchReveal && !searchAutoExpanded.size) return false;
  const currentId=searchReveal ? searchReveal.id : null;
  const modified=!!(searchReveal && searchNodeWasModified(searchReveal.id, searchReveal.fingerprint));
  const toCollapse=searchIdsToRestore([...searchAutoExpanded], nextId, modified, currentId);
  let changed=false;
  for(let i=0;i<toCollapse.length;i++){
    const aid=toCollapse[i];
    if(map.nodes[aid] && !map.nodes[aid].collapsed){
      map.nodes[aid].collapsed=true;
      changed=true;
    }
    searchAutoExpanded.delete(aid);
  }
  if(modified && currentId){
    let p=map.nodes[currentId] ? map.nodes[currentId].parent : null;
    while(p){ searchAutoExpanded.delete(p); p=map.nodes[p] ? map.nodes[p].parent : null; }
  }
  searchReveal=null;
  return changed;
}
function searchEnterExpand(id){
  const opened=searchExpandAncestors(id);
  for(let i=0;i<opened.length;i++) searchAutoExpanded.add(opened[i]);
  return opened.length>0;
}
function paintSearchHits(){
  const q=($('#search')?.value||'').trim();
  const matchSet=new Set(searchMatches);
  const current=searchPos>=0 ? searchMatches[searchPos] : null;
  document.querySelectorAll('.node').forEach(el=>{
    el.classList.remove('dim','match','match-current');
    if(!q) return;
    if(matchSet.has(el.dataset.id)){
      el.classList.add('match');
      if(el.dataset.id===current) el.classList.add('match-current');
    } else el.classList.add('dim');
  });
}
function keepSearchFocus(){
  const input=$('#search');
  const wrap=$('#searchWrap');
  if(!input || !wrap || !wrap.classList.contains('open')) return;
  if(document.activeElement!==input) input.focus({preventScroll:true});
}
let _searchInputT=0;   // pending debounced doSearch from typing
const SEARCH_DEBOUNCE_MIN_NODES=400;
function doSearch(q){
  if(_searchInputT){ clearTimeout(_searchInputT); _searchInputT=0; }
  const raw=q==null ? ($('#search')?.value||'') : q;
  searchMatches=collectSearchMatches(raw);
  searchPos=-1;
  paintSearchHits();
  const cnt=$('#searchCount');
  const needle=String(raw||'').trim();
  if(cnt) cnt.textContent = needle ? (searchMatches.length ? rmsTr('searchFound','%s found').replace('%s', searchMatches.length) : rmsTr('searchNone','none')) : '';
}
function focusNextMatch(dir=1){
  if(_searchInputT) doSearch();   // Enter right after typing: use the current query
  if(!searchMatches.length){ keepSearchFocus(); return; }
  if(typeof flushOpenEditToModel==='function') flushOpenEditToModel();
  const len=searchMatches.length;
  // Shift+Enter from "no current match" lands on the last one.
  const nextPos=dir<0 ? (searchPos<0 ? len-1 : (searchPos-1+len)%len) : (searchPos+1)%len;
  const nextId=searchMatches[nextPos];
  const foldChanged=searchLeaveCurrent(nextId);
  const opened=searchEnterExpand(nextId);
  searchPos=nextPos;
  if(foldChanged || opened) autoLayout(false, {persist:false});
  searchReveal={ id:nextId, fingerprint:searchNodeFingerprint(nextId) };
  paintSearchHits();
  _searchNavigating=true;
  try{
    select(nextId,false);
    centreOn(nextId);
  } finally {
    _searchNavigating=false;
  }
  const cnt=$('#searchCount');
  if(cnt) cnt.textContent = `${searchPos+1} / ${searchMatches.length}`;
  keepSearchFocus();
}
// Replace in a single node's text, HTML-aware (operates on the plain text, then
// re-stores; if the node had inline HTML we replace within text nodes only).
function replaceInNode(id, find, repl){
  const n=map.nodes[id]; if(!n) return 0;
  const flags='gi';
  const re=new RegExp(find.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'), flags);
  let count=0;
  // Same test nodeSearchText() uses to decide the text is HTML: tags OR
  // entities. `Tom &amp; Jerry` must be edited as "Tom & Jerry", never as its
  // source, or searching "&" would corrupt the entity.
  if(hasInlineMarkup(n.text||'')){
    // Walk text nodes only, preserving tags — parse inertly via <template>.
    const tpl=document.createElement('template'); tpl.innerHTML=n.text||'';
    const walker=document.createTreeWalker(tpl.content, NodeFilter.SHOW_TEXT);
    const texts=[]; let t; while((t=walker.nextNode())) texts.push(t);
    texts.forEach(tn=>{
      if(re.test(tn.nodeValue||'')){ re.lastIndex=0; tn.nodeValue=tn.nodeValue.replace(re, ()=>{count++;return repl;}); }
    });
    if(count){ const d=document.createElement('div'); d.appendChild(tpl.content); n.text=d.innerHTML; }
  } else {
    const out=(n.text||'').replace(re, ()=>{count++; return repl;});
    if(count) n.text=out;
  }
  return count;
}
function replaceNext(){
  if(READONLY || _historyPreview) return;
  const find=$('#search').value.trim(); const repl=$('#replace').value;
  if(!find || !searchMatches.length) return;
  if(searchPos<0) searchPos=0;
  const id=searchMatches[searchPos] || searchMatches[0];
  const c=replaceInNode(id, find, repl);
  if(c){ pushHistory(); render(); toast(rmsTf('tReplacedOne','Replaced %s in 1 node', c)); }
  else toast(rmsTr('replaceNone','Nothing to replace'));
  doSearch(find);            // refresh matches (node may no longer match)
}
function replaceAll(){
  if(READONLY || _historyPreview) return;
  const find=$('#search').value.trim(); const repl=$('#replace').value;
  if(!find) return;
  let total=0, nodes=0;
  // Only the nodes the search found — the same set the user sees highlighted.
  [...searchMatches].forEach(id=>{ const c=replaceInNode(id, find, repl); if(c){ total+=c; nodes++; } });
  if(total){ pushHistory(); render(); toast(rmsTf('tReplacedN','Replaced %s occurrence(s) in %s node(s)', total, nodes)); }
  else toast(rmsTr('replaceNone','Nothing to replace'));
  doSearch(find);
}
// Centre the viewport on a node (used by find-next)
function centreOn(id){
  const n=map.nodes[id]; if(!n) return;
  const {w:SW,h:SH}=_stageSize();
  view.x = SW/2 - (n.x + (n.w||120)/2)*view.k;
  view.y = SH/2 - (n.y + (n.h||40)/2)*view.k;
  applyView();
}

/* ============================================================
   MINIMAP — scaled overview, click to jump
   ============================================================ */
const MM_W=168, MM_H=120;
function updateMinimap(){
  const mm=$('#minimap'); if(!mm) return;
  if(!map){ mm.innerHTML=''; mm._t=null; mm.style.display='none'; return; }
  const hidden=hiddenSet();
  const ids=Object.keys(map.nodes).filter(id=>!hidden.has(id));
  if(!ids.length){ mm.innerHTML=''; mm._t=null; mm.style.display='none'; return; }
  mm.style.display='';
  let minx=Infinity,miny=Infinity,maxx=-Infinity,maxy=-Infinity;
  ids.forEach(id=>{ const n=map.nodes[id];
    minx=Math.min(minx,n.x); miny=Math.min(miny,n.y);
    maxx=Math.max(maxx,n.x+(n.w||120)); maxy=Math.max(maxy,n.y+(n.h||40));
  });
  const pad=24; minx-=pad; miny-=pad; maxx+=pad; maxy+=pad;
  const cw=Math.max(1,maxx-minx), ch=Math.max(1,maxy-miny);
  const scale=Math.min(MM_W/cw, MM_H/ch);
  const ox=(MM_W-cw*scale)/2, oy=(MM_H-ch*scale)/2;
  mm._t={minx,miny,scale,ox,oy};
  const rects=ids.map(id=>{
    const n=map.nodes[id];
    const x=ox+(n.x-minx)*scale, y=oy+(n.y-miny)*scale;
    const w=Math.max(2,(n.w||120)*scale), h=Math.max(2,(n.h||40)*scale);
    const nc = safeColor(n.color);
    const col = id===map.rootId ? (safeColor(map.color)||'#e0613a')
      : (nc && nc!=='#fff' && nc!=='#ffffff') ? nc : 'var(--line-2)';
    return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" rx="1.5" fill="${col}" ${id===sel?'class="mm-sel"':''}/>`;
  }).join('');
  mm.innerHTML=`<svg viewBox="0 0 ${MM_W} ${MM_H}" width="${MM_W}" height="${MM_H}">${rects}<rect id="mmView" fill="none"/></svg>`;
  updateMinimapViewport();
}
function updateMinimapViewport(){
  const mm=$('#minimap'); if(!mm||!mm._t) return;
  const v=mm.querySelector('#mmView'); if(!v) return;
  const {minx,miny,scale,ox,oy}=mm._t;
  // _prevStage is kept fresh by _markStage() at gesture-settle points (resize, sidebar
  // toggle, animation end, ...) rather than every frame — reusing it here avoids forcing
  // a synchronous layout reflow (stage.getBoundingClientRect()) on every single pan/zoom/
  // drag frame, since the stage's own size can't actually change mid-gesture.
  const {w:SW,h:SH} = (_prevStage && _prevStage.w>1 && _prevStage.h>1) ? _prevStage : _stageSize();
  const wx=-view.x/view.k, wy=-view.y/view.k, ww=SW/view.k, wh=SH/view.k;
  v.setAttribute('x',(ox+(wx-minx)*scale).toFixed(1));
  v.setAttribute('y',(oy+(wy-miny)*scale).toFixed(1));
  v.setAttribute('width', Math.max(4,ww*scale).toFixed(1));
  v.setAttribute('height',Math.max(4,wh*scale).toFixed(1));
}
function minimapJump(clientX, clientY){
  const mm=$('#minimap'); if(!mm||!mm._t) return;
  const rect=mm.getBoundingClientRect();
  const z=_uiZ();
  const {minx,miny,scale,ox,oy}=mm._t;
  const wx=minx+(((clientX-rect.left)/z)-ox)/scale;
  const wy=miny+(((clientY-rect.top)/z)-oy)/scale;
  const {w:SW,h:SH}=_stageSize();
  view.x=SW/2 - wx*view.k;
  view.y=SH/2 - wy*view.k;
  applyView();
}

/* ============================================================
   BREADCRUMB — clickable path from root to the selected node
   ============================================================ */
function updateBreadcrumb(){
  const bc=$('#breadcrumb'); if(!bc) return;
  if(!map || !sel || !map.nodes[sel]){ bc.style.display='none'; return; }
  const path=[]; let cur=sel, guard=0;
  while(cur && guard++<200){ path.unshift(cur); cur=map.nodes[cur]?.parent; }
  if(path.length<=1){ bc.style.display='none'; return; }   // nothing to show at the root
  bc.style.display='flex';
  bc.innerHTML=path.map((id,i)=>{
    const label=nodeTextPlain(map.nodes[id].text||'')||rmsTr('untitledNode','(untitled)');
    const short=label.length>22 ? label.slice(0,22)+'…' : label;
    const crumb=`<button class="bc-crumb${id===sel?' current':''}" data-id="${escapeHtml(String(id))}" title="${escapeHtml(label)}">${escapeHtml(short)}</button>`;
    return crumb + (i<path.length-1 ? '<span class="bc-sep">›</span>' : '');
  }).join('');
  bc.querySelectorAll('.bc-crumb').forEach(b=>b.onclick=()=>{ select(b.dataset.id,false); centreOn(b.dataset.id); });
}

/* ============================================================
   MAPS — list / create / load / delete
   ============================================================ */
// Per-map "⋮" menu (Duplicate / Delete) for the sidebar — one open at a time,
// closes on outside click / scroll / blur. Frees row width for the map title.
let _rowPop=null, _rowPopOut=null, _mapLoadGeneration=0, _listGeneration=0;
function closeRowMenu(){
  if(_rowPop){ try{ _rowPop.remove(); }catch(_){} _rowPop=null; }
  if(_rowPopOut){
    document.removeEventListener('mousedown', _rowPopOut, true);
    window.removeEventListener('scroll', closeRowMenu, true);
    window.removeEventListener('blur', closeRowMenu);
    _rowPopOut=null;
  }
}
function openRowMenu(btn, m){
  if(_rowPop && _rowPop._for===m.id){ closeRowMenu(); return; }   // toggle off
  if(typeof closeAllMenus==='function') closeAllMenus();
  closeRowMenu();
  const pop=document.createElement('div'); pop.className='row-pop'; pop._for=m.id;
  pop.innerHTML='<button data-a="pin"><span class="rp-ic">\uD83D\uDCCC</span>'+(m.pinned?rmsTr('unpin','Unpin'):rmsTr('pin','Pin'))+'</button>'+
                '<button data-a="dup"><span class="rp-ic">\u2398</span>'+rmsTr('duplicate','Duplicate')+'</button>'+
                '<button data-a="del" class="danger"><span class="rp-ic">\uD83D\uDDD1</span>'+rmsTr('deleteMap','Delete')+'</button>';
  const row = btn.closest('.map-item') || btn.parentElement;
  row.appendChild(pop);                 // anchored to the row via CSS (position:absolute) — zoom-proof
  // flip above only if there isn't room below (ratio check; zoom cancels out)
  const rb = btn.getBoundingClientRect();
  // Same raw-vs-logical mismatch class as elsewhere: rb (getBoundingClientRect) scales
  // with UI-level zoom, offsetHeight's behaviour under it is unverified, and
  // window.innerHeight does not scale with it — measuring the popup via the same API as
  // rb and dividing the raw side by _uiZ() keeps this an apples-to-apples comparison
  // regardless of Display Size.
  const _z=_uiZ();
  if((rb.bottom + pop.getBoundingClientRect().height)/_z + 10 > window.innerHeight){ pop.classList.add('flip-up'); }
  pop.querySelector('[data-a="pin"]').onclick=ev=>{ ev.stopPropagation(); closeRowMenu(); togglePin(m.id); };
  pop.querySelector('[data-a="dup"]').onclick=ev=>{ ev.stopPropagation(); closeRowMenu(); duplicateMap(m.id); };
  pop.querySelector('[data-a="del"]').onclick=async ev=>{ ev.stopPropagation(); closeRowMenu();
    if(!(await rmsConfirm(rmsTr('confirmDeleteMap','Delete “%s”?').replace('%s', m.title||rmsTr('untitled','Untitled')), { okLabel:rmsTr('dlgDelete','Delete'), danger:true }))) return;
    ++_mapLoadGeneration;
    try{ await _mapSaves.remove(m.id,id=>Store.remove(id)); }
    catch(e){ toast(rmsTr('deleteMapFailed','Could not delete the map. Please retry.')); return; }
    _mapSaveStates.delete(m.id); _saveErrorNotified.delete(m.id);
    if((map && map.id===m.id) || (_historyPreview && _historyPreview.original && _historyPreview.original.id===m.id)){
      // Drop a history preview first, or "Back to current" would resurrect the deleted map.
      cancelHistoryPreview(); document.querySelectorAll('.hist-panel,.diff-panel').forEach(p=>p.remove());
      mdClearDragSel(); clearTimeout(_mdTimer); _mdTimer=0;
      map=null; render();
      const ed=document.getElementById('mdEditor'); if(ed) ed.value='';
    }
    refreshList(); toast(rmsTr('mapDeleted','Map deleted'));
    try{ localStorage.removeItem('mindspark:vars:'+m.id); }catch(_){}
  };
  _rowPop=pop;
  _rowPopOut=(e)=>{ if(_rowPop && (!e || e.type!=='mousedown' || !_rowPop.contains(e.target))) closeRowMenu(); };
  setTimeout(()=>{
    document.addEventListener('mousedown', _rowPopOut, true);
    window.addEventListener('scroll', closeRowMenu, true);
    window.addEventListener('blur', closeRowMenu);
  },0);
}
async function refreshList(){
  const generation=++_listGeneration;
  let idx;
  try{ idx=await Store.list(); }
  catch(e){ console.warn('Could not refresh map list:',e); return; }
  if(generation!==_listGeneration) return;
  // Merge the current in-memory map so title edits / new maps appear immediately
  // (don't wait for the debounced save to hit the database).
  if(map){
    // Pin state comes from the server list for every row (togglePin saves
    // before refreshing); only a not-yet-saved map uses its in-memory flag.
    const local={id:map.id, title:map.title, color:map.color, updated:map.updated||Date.now()};
    const at=idx.findIndex(m=>m.id===map.id);
    if(at>=0) idx[at]={...idx[at], ...local};
    else idx.unshift({...local, pinned:!!map.pinned});
  }
  // Pinned maps first, then most-recently-updated.
  idx.sort((a,b)=> (b.pinned?1:0)-(a.pinned?1:0) || (b.updated||0)-(a.updated||0));
  const list=$('#mapList'); list.innerHTML='';
  (idx||[]).forEach(m=>{
    const el=document.createElement('div');
    el.className='map-item'+(map&&m.id===map.id?' active':'')+(m.pinned?' pinned':'');
    el.innerHTML=`<span class="dot" style="background:${safeColor(m.color)||'#e0613a'}"></span><span class="nm">${escapeHtml(m.title||rmsTr('untitled','Untitled'))}</span><button class="row-menu" title="${rmsTr('more','More')}" aria-haspopup="true" aria-label="${rmsTr('moreActions','More actions')}">\u22ee</button>`;
    el.style.cursor='pointer';
    el.onclick=()=>{ if(!map || map.id!==m.id) loadMap(m.id); };
    el.querySelector('.row-menu').onclick=ev=>{ ev.stopPropagation(); openRowMenu(ev.currentTarget, m); };
    list.appendChild(el);
  });
}
function escapeHtml(s){return (s||'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));}

// Pin/unpin a map so it stays at the top of the sidebar (works on any map, not
// only the open one). Pin state lives on the map and is mirrored into the index.
async function togglePin(id){
  const target = (map && map.id===id) ? map : await Store.get(id);
  if(!target){ toast(rmsTr('couldNotOpenMap','Could not open map')); return; }
  const now = !target.pinned;
  if(now) target.pinned = true; else delete target.pinned;
  try{ await saveMapNow(target); }
  catch(e){ toast(rmsTr('tPinFailed','Could not update pin')); return; }
  if(map && map.id===id){ if(now) map.pinned=true; else delete map.pinned; }
  refreshList();
  toast(now ? rmsTr('pinnedToTop','Pinned to top') : rmsTr('unpinned','Unpinned'));
}

/* ---------- Rich-text Notes editor popup ---------- */
let _notesSticky=false, _notesHoverTimer=0;
function shouldCloseNotesOnPointerLeave(sticky){
  return !sticky;
}
function pinNotesPopup(popup){
  _notesSticky=true;
  const editor=popup && popup.querySelector && popup.querySelector('.np-editor');
  if(editor && typeof document!=='undefined' && document.activeElement!==editor){
    try{ editor.focus(); }catch(_){}
  }
}
function closeNotesPopup(){
  _notesSticky=false;
  clearTimeout(_notesHoverTimer); _notesHoverTimer=0;
  if(typeof document!=='undefined' && document.querySelectorAll){
    document.querySelectorAll('.notes-popup').forEach(p=>p.remove());
  }
  if(typeof scheduleSaveStatePost==='function') scheduleSaveStatePost();
}
function closeNotesPreview(){
  if(!shouldCloseNotesOnPointerLeave(_notesSticky)) return;
  closeNotesPopup();
}
function scheduleCloseNotesPreview(){
  clearTimeout(_notesHoverTimer);
  _notesHoverTimer=setTimeout(closeNotesPreview, 180);
}
// position:fixed is viewport pixels. Anchor GBR is already visual (UI scale
// is transform:scale). Sit beside the 📝 so the pointer can reach the
// preview before the hover-close timer fires.
function notesPopupPosition(anchor, popupSize, viewport, gap){
  gap = (gap==null) ? 8 : gap;
  const w = (popupSize && popupSize.w) || 340;
  const h = (popupSize && popupSize.h) || 220;
  const vw = (viewport && viewport.w) || 0;
  const vh = (viewport && viewport.h) || 0;
  let left = (anchor && anchor.right || 0) + gap;
  let top  = (anchor && anchor.top) || 0;
  if(vw && left+w > vw-gap) left = (anchor.left||0) - w - gap;
  if(left < gap) left = gap;
  if(vh && top+h > vh-gap) top = Math.max(gap, vh-h-gap);
  if(top < gap) top = gap;
  return {left, top};
}
function notesEditorMaxHeight(popupTop, viewportH, chromeH, gap){
  gap = (gap==null) ? 8 : gap;
  const top = Number(popupTop)||0;
  const vh = Number(viewportH)||0;
  const chrome = Number(chromeH)||0;
  const minH = 80;
  if(!(vh>0)) return minH;
  return Math.max(minH, vh - gap - top - chrome);
}
function clampNotesPopupPos(left, top, w, h, vw, vh, gap){
  gap = (gap==null) ? 8 : gap;
  const minVisible = 48;
  let x = Number(left)||0, y = Number(top)||0;
  const width = Number(w)||0, height = Number(h)||0;
  if(vw>0) x = Math.min(Math.max(gap, x), Math.max(gap, vw - Math.min(width, vw - gap*2) - gap));
  if(vh>0) y = Math.min(Math.max(gap, y), Math.max(gap, vh - minVisible - gap));
  return {left:x, top:y};
}
function notesPopupDragShouldStart(target, popup){
  if(!target || !popup) return false;
  if(target===popup) return true;
  if(typeof target.closest!=='function') return false;
  if(target.closest('.np-editor')) return false;
  if(target.closest('.np-actions')) return false;
  if(target.closest('.np-toolbar button')) return false;
  return !!target.closest('.np-toolbar');
}
function notesPopupChromeHeight(popup){
  if(!popup || !popup.querySelector) return 94;
  const tape=8;
  const toolbar=popup.querySelector('.np-toolbar');
  const actions=popup.querySelector('.np-actions');
  return tape + (toolbar && toolbar.offsetHeight || 0) + (actions && actions.offsetHeight || 0);
}
function applyNotesPopupHeight(popup){
  if(!popup) return;
  const top=parseFloat(popup.style.top);
  const vh=(typeof window!=='undefined' && window.innerHeight) || 0;
  const chrome=notesPopupChromeHeight(popup);
  const y=isFinite(top) ? top : ((popup.getBoundingClientRect && popup.getBoundingClientRect().top) || 0);
  const maxH=notesEditorMaxHeight(y, vh, chrome, 8);
  popup.style.maxHeight=Math.max(0, vh - y - 8)+'px';
  const editor=popup.querySelector && popup.querySelector('.np-editor');
  if(editor) editor.style.maxHeight=maxH+'px';
}
function placeNotesPopup(popup, nodeId){
  if(!popup) return;
  const mark = (typeof document!=='undefined' && document.querySelector)
    ? (document.querySelector(`.node[data-id="${nodeId}"] .notes-mark`)
       || document.querySelector(`.node[data-id="${nodeId}"]`))
    : null;
  const stageEl = (typeof stage!=='undefined') ? stage : null;
  const anchor = (mark && mark.getBoundingClientRect && mark.getBoundingClientRect())
    || (stageEl && stageEl.getBoundingClientRect && stageEl.getBoundingClientRect())
    || {left:8, right:8, top:8};
  const pos = notesPopupPosition(
    anchor,
    {w: popup.offsetWidth||340, h: popup.offsetHeight||220},
    {w: (typeof window!=='undefined' && window.innerWidth) || 0,
     h: (typeof window!=='undefined' && window.innerHeight) || 0}
  );
  popup.style.left = pos.left+'px';
  popup.style.top  = pos.top+'px';
  applyNotesPopupHeight(popup);
}
function bindNotesPopupDrag(popup){
  if(!popup || popup._npDragBound) return;
  popup._npDragBound=true;
  popup.addEventListener('pointerdown', e=>{
    if(e.button!=null && e.button!==0) return;
    if(!notesPopupDragShouldStart(e.target, popup)) return;
    e.preventDefault();
    e.stopPropagation();
    _notesSticky=true;
    clearTimeout(_notesHoverTimer);
    const startX=e.clientX, startY=e.clientY;
    const left0=parseFloat(popup.style.left)||0;
    const top0=parseFloat(popup.style.top)||0;
    popup.classList.add('np-dragging');
    const onMove=ev=>{
      const r=popup.getBoundingClientRect();
      const pos=clampNotesPopupPos(
        left0 + ev.clientX - startX,
        top0 + ev.clientY - startY,
        r.width, r.height,
        (typeof window!=='undefined' && window.innerWidth) || 0,
        (typeof window!=='undefined' && window.innerHeight) || 0,
        8
      );
      popup.style.left=pos.left+'px';
      popup.style.top=pos.top+'px';
      applyNotesPopupHeight(popup);
    };
    const onUp=()=>{
      popup.classList.remove('np-dragging');
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      applyNotesPopupHeight(popup);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  });
}
function showNotesEditor(nodeId, opts){
  const sticky=!!(opts && opts.sticky);
  const open=document.querySelector('.notes-popup');
  if(open && open.dataset.nodeId===String(nodeId)){
    if(sticky) pinNotesPopup(open);
    else clearTimeout(_notesHoverTimer);
    return;
  }
  closeNotesPopup();
  if(!map||!map.nodes[nodeId]) return;
  const n=map.nodes[nodeId];
  const popup=document.createElement('div');
  popup.className='notes-popup';
  popup.dataset.nodeId=String(nodeId);
  const has=(n.notes||'').replace(/<[^>]*>/g,'').trim().length>0;
  popup.innerHTML=`
    <div class="np-toolbar">
      <button data-c="bold"          title="${rmsTr('actBold','Bold')}"><b>B</b></button>
      <button data-c="italic"        title="${rmsTr('actItalic','Italic')}"><i>i</i></button>
      <button data-c="strikeThrough" title="${rmsTr('actStrike','Strikethrough')}"><s>S</s></button>
      <div class="np-div"></div>
      <button data-c="h1"            title="${rmsTr('heading1','Heading 1')}">H1</button>
      <button data-c="h2"            title="${rmsTr('heading2','Heading 2')}">H2</button>
      <div class="np-div"></div>
      <button data-c="insertUnorderedList" title="${rmsTr('actUl','Bulleted list')}">•≡</button>
      <button data-c="insertOrderedList"   title="${rmsTr('actOl','Numbered list')}">1≡</button>
      <div class="np-div"></div>
      <button data-c="createLink"  title="${rmsTr('insertLink','Insert link')}">🔗</button>
      <button data-c="unlink"      title="${rmsTr('removeLink','Remove link')}">⊘🔗</button>
      <button data-c="removeFormat" title="${rmsTr('clearFormat','Clear formatting')}">⨯</button>
    </div>
    <div class="np-editor" contenteditable="true" data-placeholder="${rmsTr('notesPlaceholder','Type your notes — formatting is on the toolbar.')}"></div>
    <div class="np-actions">
      ${has?'<button class="np-clear">'+rmsTr('notesRemove','Remove')+'</button>':''}
      <button class="np-cancel">${rmsTr('notesCancel','Cancel')}</button>
      <button class="np-save primary">${rmsTr('notesSave','Save')}</button>
    </div>`;
  document.body.appendChild(popup);
  placeNotesPopup(popup, nodeId);
  _notesSticky=sticky;
  popup.addEventListener('mousedown',e=>{ e.stopPropagation(); pinNotesPopup(popup); });
  popup.addEventListener('mouseenter',()=>clearTimeout(_notesHoverTimer));
  popup.addEventListener('mouseleave',scheduleCloseNotesPreview);
  bindNotesPopupDrag(popup);
  const editor=popup.querySelector('.np-editor');
  editor.innerHTML = sanitizeNotes(n.notes||'');   // safe: inert-parsed, whitelisted
  editor._initialHTML=sanitizeNotes(editor.innerHTML);
  scheduleSaveStatePost();
  applyNotesPopupHeight(popup);
  if(sticky){
    editor.focus();
    const range=document.createRange(); range.selectNodeContents(editor); range.collapse(false);
    const s=getSelection(); s.removeAllRanges(); s.addRange(range);
  }

  popup.querySelectorAll('.np-toolbar button').forEach(btn=>{
    btn.addEventListener('mousedown',e=>e.preventDefault());  // keep selection
    btn.addEventListener('click',e=>{
      e.stopPropagation();
      const c=btn.dataset.c;
      if(c==='h1'||c==='h2'){ execCmd('formatBlock', '<'+c+'>'); }
      else if(c==='createLink'){
        // The dialog takes focus; remember the selection to link and put it back.
        const s=getSelection();
        const range=s.rangeCount && editor.contains(s.anchorNode) ? s.getRangeAt(0).cloneRange() : null;
        rmsPrompt(rmsTr('enterUrl','Enter URL (https://…):')).then(url=>{
          if(!editor.isConnected) return;
          editor.focus();
          if(range){ const s2=getSelection(); s2.removeAllRanges(); s2.addRange(range); }
          if(url) execCmd('createLink',url);
        });
        return;
      }
      else { execCmd(c); }
      editor.focus();
    });
  });

  const close=()=>closeNotesPopup();
  // The popup can outlive its node (undo, map switch, read-only preview).
  const canWrite=()=>!!(map && map.nodes[nodeId] && !READONLY);
  const save=()=>{
    if(!canWrite()){ close(); return; }
    // Robust sanitize (inert parse + tag/attr whitelist) before storing.
    const html=sanitizeNotes(editor.innerHTML);
    const plain=html.replace(/<[^>]*>/g,'').trim();
    if(plain) map.nodes[nodeId].notes=html; else delete map.nodes[nodeId].notes;
    pushHistory(); render(); close();
  };
  popup.querySelector('.np-save').onclick=save;
  popup.querySelector('.np-cancel').onclick=close;
  popup.querySelector('.np-clear')?.addEventListener('click',()=>{
    if(!canWrite()){ close(); return; }
    delete map.nodes[nodeId].notes; pushHistory(); render(); close();
  });
  editor.addEventListener('input',()=>applyNotesPopupHeight(popup));
  editor.addEventListener('keydown',e=>{
    e.stopPropagation();
    if(e.key==='Escape' && !e.isComposing){
      e.preventDefault();
      // Esc keeps typed notes (same "unsaved" test the quit path uses);
      // Cancel is the explicit discard.
      if(sanitizeNotes(editor.innerHTML)!==editor._initialHTML) save(); else close();
    }
    if(e.key==='Enter' && (e.ctrlKey||e.metaKey)){ e.preventDefault(); save(); }
  });
}

/* ============================================================
   PROMPT TEMPLATES — see templates.js, loaded before this file.
   TEMPLATES and TEMPLATE_CATEGORIES are defined there; the
   functions that use them stay here.
   ============================================================ */
async function createMapFromTemplate(templateId){
  ++_mapLoadGeneration;
  resetMapViewState();
  closeNotesPopup();
  const tpl = TEMPLATES[templateId];
  if(!tpl){ createMap(); return; }
  const id = uid();
  const keyToId = {};      // template key -> real uid
  const nodes = {};
  let rootId = null;
  tpl.nodes.forEach(n => {
    const nid = uid();
    keyToId[n.k] = nid;
    if(!n.parent) rootId = nid;
  });
  // Optional per-node fields a template may set to showcase features.
  const OPT = ['notes','image','url','ref','citation','fontSize','bold','italic',
    'underline','strike','textColor','highlight','align','listType','collapsed','width','height',
    'html','frontmatter','raw','lang'];
  tpl.nodes.forEach(n => {
    const nid = keyToId[n.k];
    const node = {
      id: nid,
      text: n.text,
      parent: n.parent ? keyToId[n.parent] : null,
      x: 0, y: 0,
      side: n.parent ? null : 'root',   // unsided → balanced by weight below
      color: n.color || '#fff'
    };
    if(n.task) node.task = n.task;       // carry task state
    OPT.forEach(f => { if(n[f] !== undefined) node[f] = n[f]; });
    nodes[nid] = node;
  });
  // Cross-links (template keys → real ids), skipping any that don't resolve.
  const links = Array.isArray(tpl.links)
    ? tpl.links.filter(l => keyToId[l.from] && keyToId[l.to])
               .map(l => ({ from: keyToId[l.from], to: keyToId[l.to] }))
    : [];
  flushPendingSave();
  map = { id, title: tpl.name, titleAuto: false, color: tpl.color, layout: 'balanced', rootId, nodes, links };
  sel = rootId; history = []; hpos = -1;
  opLog('newMap', {id, text:tpl.name||''});
  balanceRootSides();        // split top-level branches evenly left/right
  pushHistory();
  $('#mapTitle').value = map.title;
  autoLayout(); fit();
  scheduleSave(); refreshList();
}

// ===== Map duplication =====
async function duplicateMap(id){
  let src = (map && map.id===id) ? map : null;
  if(!src){ try{ src = await Store.get(id); }catch(e){} }
  if(!src){ toast(rmsTr('tDupFailed','Could not duplicate')); return; }
  const copy = JSON.parse(JSON.stringify(src));
  copy.id = uid();
  copy.title = (src.title||rmsTr('untitled','Untitled map')) + rmsTr('copySuffix',' (copy)');
  copy.titleAuto = false;
  copy.updated = Date.now();
  await saveMapNow(copy);
  let imgOk = true;
  try{
    const r = await fetch(apiUrl('/api/maps/'+encodeURIComponent(copy.id)+'/images/duplicate'), {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ from: id })
    });
    if(!r.ok) imgOk = false;
  }catch(_){ imgOk = false; }
  await loadMap(copy.id);
  refreshList();
  toast(imgOk ? rmsTr('tMapDuplicated','Map duplicated') : rmsTr('tMapCopiedNoImg','Map copied, but images could not be copied'));
}

// ===== Save current map as a reusable template =====
async function saveAsTemplate(){
  if(!map){ return; }
  const name = ((await rmsPrompt(rmsTr('templateNamePrompt','Name this template:'), map.title||rmsTr('tplDefaultName','My template')))||'').trim();
  if(!name || !map) return;
  const idToK = {}; let i=0;
  Object.keys(map.nodes).forEach(nid=>{ idToK[nid] = (nid===map.rootId) ? 'root' : ('n'+(i++)); });
  const nodes = Object.values(map.nodes).map(n=>{
    const o = { k: idToK[n.id], text: nodeTextPlain(n.text)||'' };
    if(n.parent) o.parent = idToK[n.parent];
    if(n.task) o.task = n.task;
    return o;
  });
  const tpl = { id:'user_'+uid(), name, desc:'Your saved template', color: map.color||'#e0613a', group:'mine', icon:'⭐', nodes, _user:true };
  let store=[]; try{ store=JSON.parse(localStorage.getItem('mindspark:userTemplates')||'[]'); }catch(e){}
  store.push(tpl);
  try{ localStorage.setItem('mindspark:userTemplates', JSON.stringify(store)); }catch(e){ toast(rmsTr('tSaveStorageFull','Could not save (storage full?)')); return; }
  loadUserTemplates();
  toast(rmsTr('tSavedToMyTpl','Saved to “My templates”'));
}
function deleteUserTemplate(tid){
  let store=[]; try{ store=JSON.parse(localStorage.getItem('mindspark:userTemplates')||'[]'); }catch(e){}
  store = store.filter(t=>t.id!==tid);
  localStorage.setItem('mindspark:userTemplates', JSON.stringify(store));
  delete TEMPLATES[tid];
  if(!store.length){
    const idx=TEMPLATE_CATEGORIES.findIndex(c=>c.id==='mine');
    if(idx>=0) TEMPLATE_CATEGORIES.splice(idx,1);
  }
}
// Merge user templates from localStorage into the in-memory catalog.
function loadUserTemplates(){
  let store=[]; try{ store=JSON.parse(localStorage.getItem('mindspark:userTemplates')||'[]'); }catch(e){ store=[]; }
  // Drop any previously-merged user templates so we don't duplicate on re-call
  Object.keys(TEMPLATES).forEach(k=>{ if(TEMPLATES[k]&&TEMPLATES[k]._user) delete TEMPLATES[k]; });
  store.forEach(t=>{ TEMPLATES[t.id]=t; });
  const hasCat = TEMPLATE_CATEGORIES.some(c=>c.id==='mine');
  if(store.length && !hasCat){
    TEMPLATE_CATEGORIES.push({ id:'mine', label:'My templates', icon:'⭐', color:'#c98a1a' });
  } else if(!store.length && hasCat){
    const idx=TEMPLATE_CATEGORIES.findIndex(c=>c.id==='mine');
    if(idx>=0) TEMPLATE_CATEGORIES.splice(idx,1);
  }
}
// Close every top-level menu/popover so only one is ever open at once.
function closeAllMenus(){
  document.querySelectorAll('.tpl-pop, .export-pop').forEach(p=>{ try{p.remove();}catch(_){} });
  if(typeof closeRowMenu==='function') closeRowMenu();
  try{ if(typeof closeThemePanel==='function') closeThemePanel(); }catch(_){}
  if(typeof activePicker!=='undefined' && activePicker){ try{activePicker.remove();}catch(_){} activePicker=null; }
}
// Category labels in templates.js are English data; show them in the UI language.
function tplCatLabel(c){ return rmsTr('tplCat_'+c.id, c.label); }
// User templates store desc:'Your saved template' in localStorage; translate at render.
function tplDesc(t){ return (t._user && t.desc==='Your saved template') ? rmsTr('tplUserDesc', t.desc) : (t.desc||''); }
function showTemplatesMenu(){
  if(document.querySelector('.tpl-pop')){ closeAllMenus(); return; }      // click again closes it
  closeAllMenus();
  const pop = document.createElement('div');
  pop.className = 'tpl-pop';
  document.body.appendChild(pop);
  pop.addEventListener('mousedown', e => e.stopPropagation());
  // Stop clicks inside the popover from reaching the document-level
  // outside-click handler — otherwise drilling into a category (which
  // rebuilds innerHTML and detaches the clicked button) would be seen as
  // an "outside" click and close the menu.
  pop.addEventListener('click', e => e.stopPropagation());

  const place = () => {
    // Anchor under the "New mind map" row, constrained to the viewport.
    const row = document.querySelector('.new-map-row') || $('#newMapMenu');
    positionPopup(pop, row);
  };
  const close = () => pop.remove();

  // ----- root view: blank + category list -----
  const renderRoot = () => {
    pop.innerHTML = `
      <div class="tpl-head">${escapeHtml(rmsTr('newMapMenu','Start from a template'))}</div>
      <button class="tpl-item" data-act="blank">
        <span class="tpl-ic" style="background:#e0613a">⊕</span>
        <span><b>${escapeHtml(rmsTr('tplBlank','Blank map'))}</b><i>${escapeHtml(rmsTr('tplBlankSub','Just a root node'))}</i></span>
      </button>
      <div class="tpl-divider"></div>
      ${TEMPLATE_CATEGORIES.map(c=>{
        const count = Object.values(TEMPLATES).filter(t=>(t.group||'prompt')===c.id).length;
        return `<button class="tpl-item tpl-cat" data-cat="${c.id}">
            <span class="tpl-ic" style="background:${c.color}">${c.icon}</span>
            <span><b>${escapeHtml(tplCatLabel(c))}</b><i>${escapeHtml(count===1?rmsTr('tplCountOne','1 template'):rmsTf('tplCountN','%s templates',count))}</i></span>
            <span class="tpl-chev">›</span>
          </button>`;
      }).join('')}`;
    pop.querySelector('[data-act="blank"]').onclick = () => { close(); createMap(); };
    pop.querySelectorAll('.tpl-cat').forEach(b => b.onclick = () => renderCategory(b.dataset.cat));
    place();
  };

  // ----- category view: back + that category's templates -----
  const renderCategory = (catId) => {
    const cat = TEMPLATE_CATEGORIES.find(c=>c.id===catId);
    if(!cat) return renderRoot();   // e.g. the last "My templates" entry was deleted
    const entries = Object.entries(TEMPLATES).filter(([,t])=>(t.group||'prompt')===catId);
    pop.innerHTML = `
      <button class="tpl-back" data-act="back">‹ ${escapeHtml(rmsTr('tplAllCats','All categories'))}</button>
      <div class="tpl-head" style="padding-top:2px">${escapeHtml(tplCatLabel(cat))}</div>
      ${entries.map(([id,t])=>`
        <button class="tpl-item" data-id="${id}">
          <span class="tpl-ic" style="background:${t.color}">${t.icon || '⊟'}</span>
          <span><b>${escapeHtml(t.name)}</b><i>${escapeHtml(tplDesc(t))}</i></span>
          ${t._user?`<span class="tpl-del" data-del="${id}" title="${escapeHtml(rmsTr('tplDelete','Delete template'))}">✕</span>`:''}
        </button>`).join('')}`;
    pop.querySelector('[data-act="back"]').onclick = renderRoot;
    pop.querySelectorAll('.tpl-item[data-id]').forEach(b => b.onclick = (e) => {
      if(e.target.classList.contains('tpl-del')){
        e.stopPropagation();
        const tid=e.target.dataset.del;
        const tname=(TEMPLATES[tid] && TEMPLATES[tid].name) || '';
        rmsConfirm(rmsTr('confirmDeleteTemplate','Delete template “%s”?').replace('%s', tname),
                   { okLabel:rmsTr('dlgDelete','Delete'), danger:true }).then(ok=>{
          if(!ok) return;
          deleteUserTemplate(tid);
          if(!pop.isConnected) return;
          // Refresh; back to root if the category is now gone.
          if(TEMPLATE_CATEGORIES.some(c=>c.id===catId)) renderCategory(catId);
          else renderRoot();
        });
        return;
      }
      close(); createMapFromTemplate(b.dataset.id);
    });
    place();
  };

  renderRoot();
  setTimeout(() => document.addEventListener('click', function cl(e){
    if(!pop.contains(e.target)){ close(); document.removeEventListener('click', cl); }
  }), 0);
}

function createMap(){
  ++_mapLoadGeneration;
  resetMapViewState();
  const id=uid(); const rid=uid();
  const rootText=rmsTr('centralIdea','Central Idea');
  const m={id,title:rootText,titleAuto:true,color:PALETTE[Math.floor(Math.random()*PALETTE.length)],rootId:rid,
    nodes:{[rid]:{id:rid,text:rootText,parent:null,x:0,y:0,side:'root',color:'#fff'}}};
  // Show it immediately — never wait on the network to render the UI.
  flushPendingSave();
  closeNotesPopup();
  map=m; sel=rid; history=[]; hpos=-1; pushHistory();
  $('#mapTitle').value=map.title;
  opLog('newMap', {id});
  autoLayout();
  // Default new maps to 100% zoom, centred on the root
  view.k=1;
  const {w:sw,h:sh}=_stageSize();
  const rn=map.nodes[rid];
  view.x = sw/2 - (rn.x + (rn.w||120)/2);
  view.y = sh/2 - (rn.y + (rn.h||50)/2);
  applyView(); _markStage();
  scheduleSave();          // persist to the database in the background
  refreshList();
  setTimeout(()=>startEdit(rid),120);
}
async function loadMap(id){
  const generation=++_mapLoadGeneration;
  resetMapViewState();
  flushPendingSave();
  let m=null;
  try{ await _mapSaves.flush(id); m=await Store.get(id); }
  catch(e){ if(generation===_mapLoadGeneration) toast(rmsTr('couldNotOpenMap','Could not open map')); return false; }
  if(generation!==_mapLoadGeneration) return false;
  if(!m){ toast(rmsTr('tMapNotFound','Map not found')); return false; }
  sanitizeMap(m);
  // Legacy migration: old maps may still store `comment` — promote it to `notes`
  for(const n of Object.values(m.nodes||{})){
    if(n.comment && !n.notes){
      n.notes = '<p>'+escapeHtml(n.comment).replace(/\n/g,'<br>')+'</p>';
      delete n.comment;
    }
  }
  flushPendingSave();          // persist the outgoing map's pending edit to itself
  closeNotesPopup();           // its node belongs to the outgoing map
  map=m; sel=map.rootId;
  const _imported = !!map._import; if(_imported) delete map._import;
  // Initialise history WITHOUT triggering a save — loading is not a change,
  // so the sidebar order (sorted by `updated`) must not be reshuffled.
  history=[mapHistorySnapshot()];
  hpos=0; updateUndo();
  $('#mapTitle').value=map.title;
  opLog('open', {id:map.id, text:map.title||''});
  if(_imported){ balanceRootSides(); autoLayout(); }
  else {
    render();
    if(mapHasCardOverlap(map.nodes, { hidden: hiddenSet() })) autoLayout();
  }
  // Restore this map's saved camera if it has one; otherwise preserve the
  // session zoom across switches; otherwise auto-fit a fresh map.
  const saved=loadMapView(map.id);
  if(saved && !_imported){ applyMapView(saved); }
  else if(userZoom!=null && !_imported){ view.k=userZoom; recenter(); }
  else fit();
  refreshList();
  if(mdMode) syncTextFromMap();
  updateMapSaveStatus();
  if(!mdMode && typeof prepareNodeTyping==='function') prepareNodeTyping(sel);
  return true;
}

/* ---------- title ---------- */
$('#mapTitle').addEventListener('input',e=>{
  if(!map || READONLY) return;
  map.title=e.target.value;
  map.titleAuto=false;          // user took control — stop mirroring the root text
  scheduleSave();
  // Per keystroke only retitle the active sidebar row; the full list rebuild
  // (Store.list + re-sort) waits for change/blur below.
  const nm=document.querySelector('#mapList .map-item.active .nm');
  if(nm) nm.textContent=map.title||rmsTr('untitled','Untitled');
  else refreshList();
});
$('#mapTitle').addEventListener('change',()=>{ if(map && !READONLY) refreshList(); });

/* ---------- autosave ---------- */
const _mapSaveStates=new Map(), _saveErrorNotified=new Set();
// Last `saveState` value sent to the native shell (null = never sent).
let _saveStatePosted=null, _saveStateTimer=0;
const _mapSaves=createMapSaveQueue({
  save:snapshot=>Store.save(snapshot),
  onState(id,state,error){
    _mapSaveStates.set(id,state);
    if(state==='saved') _saveErrorNotified.delete(id);
    if(map && map.id===id) updateMapSaveStatus();
    // Native quit skips the save round-trip when nothing is pending.
    postSaveState();
    // A terminal refusal is not retried, so it always gets its own warning
    // even if a retryable failure was already announced for this map.
    if(state==='failed-terminal'){
      _saveErrorNotified.add(id);
      console.warn('Map save refused:',id,error);
      toast(rmsTr('saveFailedTerminalWarning','The server refused to save this map. Your latest changes are only in this window; they will not be retried automatically.'));
    }else if(error && !_saveErrorNotified.has(id)){
      _saveErrorNotified.add(id);
      console.warn('Map save failed:',id,error);
      toast(rmsTr('savePendingWarning','Changes are still in this window and have not been saved. Retrying; keep the app open.'));
    }
  }
});
function updateMapSaveStatus(){
  const state=map && _mapSaveStates.get(map.id);
  const busy=state==='saving'||state==='retrying';
  $('#savePill').classList.toggle('saving',busy);
  $('#savePill').classList.toggle('failed',state==='failed'||state==='failed-terminal');
  $('#savePill').classList.toggle('failed-terminal',state==='failed-terminal');
  const key=state==='failed-terminal' ? 'saveFailedTerminal' : state==='failed' ? 'saveFailed' : state==='retrying' ? 'saveRetrying' : busy ? 'saving' : 'saved';
  const fallback={saveFailedTerminal:'Save refused',saveFailed:'Save failed',saveRetrying:'Retrying…',saving:'Saving…',saved:'Saved'};
  $('#saveText').textContent=rmsTr(key,fallback[key]);
}
// The native shell (applicationShouldTerminate) quits without a flush when
// this is false, whether or not the overlay is visible. So it must cover
// every edit that could still be lost: the save queue, and drafts that have
// not reached the model yet (open node editor, notes popup, Markdown pane).
function rmsPageIsDirty(){
  if([..._mapSaveStates.values()].some(s=>s!=='saved')) return true;
  if(typeof mdMode!=='undefined' && mdMode && (_mdTimer || _mdComposing)) return true;
  if(notesPopupIsDirty()) return true;
  return openNodeEditIsDirty();
}
function notesPopupIsDirty(){
  if(typeof document==='undefined' || !document.querySelector) return false;
  const ed=document.querySelector('.notes-popup .np-editor');
  // Same "unsaved" test rmsFlushPendingEdits and Esc use.
  return !!ed && sanitizeNotes(ed.innerHTML)!==ed._initialHTML;
}
// Mirrors flushOpenEditToModel's reading of the editor, but only compares.
function openNodeEditIsDirty(){
  if(typeof document==='undefined' || !document.querySelector || !map || !map.nodes) return false;
  const float=(typeof _editFloat!=='undefined') ? _editFloat : null;
  // A float prepared for the first keystroke holds no user text yet.
  if(float && float.classList && float.classList.contains('input-ready')) return false;
  const el=document.querySelector('.node.editing');
  const id=(float && float.dataset && float.dataset.nodeId) || (el && el.dataset && el.dataset.id);
  const n=id && map.nodes[id];
  if(!n) return false;
  if(el && el.classList && el.classList.contains('editing-block')){
    const box=el.querySelector('.node-block');
    if(!box) return false;
    return !!box._rmsComposing || captureBlockEditHTML(box, n.html)!==n.html;
  }
  const textEl=(float && editFloatLiveTextEl(float)) || (el && (el.querySelector('.node-text') || el));
  if(!textEl) return false;
  if(textEl._rmsComposing) return true;   // IME marked text is not in the model
  const cap=captureNodeEditText(textEl);
  if(cap.image && (cap.image!==n.image || cap.imageAlt!==(n.imageAlt||''))) return true;
  const text=cap.text || (n.image!==undefined ? '' : 'Untitled');
  return text!==(n.text||'');
}
function postSaveState(){
  clearTimeout(_saveStateTimer); _saveStateTimer=0;
  const handler=typeof window!=='undefined' && window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.rmsNative;
  if(!handler) return;
  let dirty;
  try{ dirty=rmsPageIsDirty(); }catch(_){ dirty=true; }   // unsure: let the shell flush
  if(dirty===_saveStatePosted) return;
  try{ handler.postMessage({op:'saveState',dirty}); _saveStatePosted=dirty; }catch(_){}
}
// Editor events can flip the draft part of the flag. At most one check per
// 150 ms: the first event arms the timer, later ones ride on it.
function scheduleSaveStatePost(){
  if(_saveStateTimer) return;
  _saveStateTimer=setTimeout(postSaveState,150);
}
if(typeof document!=='undefined' && document.addEventListener){
  for(const type of ['input','focusin','focusout','compositionstart','compositionend','keydown','pointerdown'])
    document.addEventListener(type, scheduleSaveStatePost, true);
}
function scheduleSave(){
  if(!map || READONLY || _historyPreview) return;
  if(typeof applyLevelColors==='function') applyLevelColors();
  map.updated=Date.now();
  _mapSaves.schedule(map,600);
}
async function saveMapNow(target){
  target.updated=Date.now();
  _mapSaves.schedule(target,0);
  await _mapSaves.flush(target.id);
}
// Callers can await the same queue that owns both timers and in-flight writes.
// Ignoring the return value is safe during a UI switch: errors remain visible,
// snapshots stay queued for retry, and they keep their original map identity.
function flushPendingSave(){
  flushMdEdits();
  const pending=_mapSaves.flush();
  pending.catch(error=>console.warn('Pending map save failed:',error));
  return pending;
}
let _suspendedEditorSelection=null;
window.rmsRestoreAfterShow=function(){
  if(!openEditorTextEl() && sel && !mdMode && !openOverlayTextField()) prepareNodeTyping(sel);
  const host=openEditorTextEl();
  if(!host || openOverlayTextField()) return;
  const saved=_suspendedEditorSelection;
  _suspendedEditorSelection=null;
  host.focus();
  if(saved && saved.host===host && host.contains(saved.range.startContainer) && host.contains(saved.range.endContainer)){
    const selection=getSelection();
    selection.removeAllRanges(); selection.addRange(saved.range);
  } else if(peekEditReplaceAll()) selectEditorContents(host);
};
window.rmsFlushForHide=function(){
  const host=openEditorTextEl();
  const selection=getSelection();
  if(host && selection.rangeCount){
    const range=selection.getRangeAt(0);
    if(host.contains(range.startContainer) && host.contains(range.endContainer))
      _suspendedEditorSelection={host,range:range.cloneRange()};
  }
  mdClearDragSel();
  if(map && !READONLY && !_historyPreview){
    flushMdEdits();
    if(!_mdComposing && !host?._rmsComposing) pushHistory({preserveEditor:true});
  }
  flushPendingSave();
};
window.rmsFlushPendingEdits=async function(){
  const notes=document.querySelector('.notes-popup .np-editor');
  if(notes && sanitizeNotes(notes.innerHTML)!==notes._initialHTML){
    throw new Error(rmsTr('finishNoteBeforeQuit','Save or cancel your open note before quitting.'));
  }
  // Blurring confirms the IME's marked text before taking a model snapshot.
  document.activeElement?.blur();
  if(_mdComposing) throw new Error(rmsTr('finishComposition','Finish text input before quitting.'));
  window.rmsFlushForHide();
  await flushPendingSave();
};
window.rmsRetryPendingSaves=function(){
  if(Store===ServerStore && !map) proceedBoot().catch(showStoreFailure);
  else flushPendingSave();
};
window.addEventListener('pagehide',()=>window.rmsFlushForHide());
document.addEventListener('visibilitychange',()=>{ if(document.hidden) window.rmsFlushForHide(); });

/* ============================================================
   EXPORT  (JSON + PNG via manual canvas render)
   ============================================================ */
function exportMenu(){
  if(document.querySelector('.export-pop')){ closeAllMenus(); return; }   // click again closes it
  closeAllMenus();
  const pop=document.createElement('div');
  pop.className='export-pop';
  const exGrp=(k,en)=>`<div class="ex-grp">${escapeHtml(rmsTr(k,en))}</div>`;
  const exBtn=(a,ic,k,en,sen)=>`<button data-a="${a}"><span class="ex-ic">${ic}</span><span><b>${escapeHtml(rmsTr(k,en))}</b><i>${escapeHtml(rmsTr(k+'Sub',sen))}</i></span></button>`;
  pop.innerHTML=[
    exGrp('exGrpTools','Tools'),
    exBtn('history','🕘','exHistory','Version history','Browse & restore past versions'),
    exBtn('present','▶','exPresent','Presentation mode','Step through the map one topic at a time'),
    exBtn('buildprompt','✨','exBuildPrompt','Compile subtree → prompt','Assemble the selected branch into a prompt'),
    exGrp('exGrpExport','Export'),
    exBtn('png','🖼','exPng','PNG image','Themed export, honors map style'),
    exBtn('prompt','⚡','exPrompt','Export as prompt','Fill variables, then copy clean text'),
    exBtn('mdrich','📝','exMd','Markdown','Formatting, tasks, tables, code'),
    exBtn('copy','⎘','exCopy','Copy as text (clipboard)','Plain outline, no download'),
    exBtn('word','📄','exWord','Word document (.doc)','Opens in Word, Google Docs, LibreOffice'),
    exBtn('mermaid','🧜','exMermaid','Mermaid diagram','Renders in GitHub, Notion, Obsidian'),
    exBtn('refs','📖','exRefs','References list','All citation nodes, formatted'),
    exGrp('exGrpManage','Manage'),
    exBtn('duplicate','⎘','exDuplicate','Duplicate this map','Make an editable copy'),
    exBtn('astemplate','⭐','exAsTemplate','Save as template','Reuse this structure for new maps'),
    exBtn('json','{}','exJson','JSON file','Full backup, re-importable'),
    exGrp('exGrpImport','Import'),
    `<button data-a="import"><span class="ex-ic">↑</span><span><b>${escapeHtml(rmsTr('exImport','Import file'))}</b><i>${escapeHtml(rmsTr('importFileSub','JSON, OPML, Markdown, GitMind (.gmind), MindMeister (.mind)'))}</i></span></button>`,
  ].join('');
  document.body.appendChild(pop);
  positionPopup(pop, $('#menuExport'), {align:'right'});
  pop.addEventListener('mousedown',e=>e.stopPropagation());
  const close=()=>pop.remove();
  setTimeout(()=>document.addEventListener('click', function cl(e){
    if(!pop.contains(e.target)) { close(); document.removeEventListener('click', cl); }
  }), 0);
  pop.querySelectorAll('button').forEach(b=>b.onclick=()=>{
    const a=b.dataset.a; close();
    if(a==='history') showVersionHistory();
    else if(a==='present') startPresentation();
    else if(a==='buildprompt') showBuildPrompt(sel || (map&&map.rootId));
    else if(a==='png') exportPNG();
    else if(a==='prompt') exportAsPrompt();
    else if(a==='mdrich') exportMarkdown(false, true);
    else if(a==='copy') exportMarkdown(true);
    else if(a==='word') exportDoc();
    else if(a==='mermaid') exportMermaid();
    else if(a==='refs') exportReferences();
    else if(a==='duplicate') duplicateMap(map.id);
    else if(a==='astemplate') saveAsTemplate();
    else if(a==='json') exportJSON();
    else if(a==='import') importJSON();
  });
}

/* ============================================================
   Version history — browse and restore past saves of the current map.
   SQLite snapshots taken by the local server on each content change.
   ============================================================ */
let _historyRequestGeneration=0;
let _historyPreview = null;   // {original} while previewing a past version
function relTime(ts){
  const s=Math.floor((Date.now()-ts)/1000);
  if(s<60) return rmsTr('relJustNow','just now');
  if(s<3600) return rmsTf('relMinAgo','%s min ago', Math.floor(s/60));
  if(s<86400) return rmsTf('relHourAgo','%s h ago', Math.floor(s/3600));
  const d=Math.floor(s/86400);
  if(d<30) return d===1 ? rmsTr('relDayAgo','1 day ago') : rmsTf('relDaysAgo','%s days ago', d);
  return new Date(ts).toLocaleDateString();
}
async function showVersionHistory(){
  if(!map){ toast(rmsTr('tOpenMapFirst','Open a map first')); return; }
  if(typeof Store.history !== 'function'){ toast(rmsTr('tHistoryNA','History not available')); return; }
  document.querySelectorAll('.hist-panel,.export-pop').forEach(p=>p.remove());
  const panel=document.createElement('div');
  panel.className='hist-panel';
  panel.innerHTML=`<div class="hist-head"><b>${escapeHtml(rmsTr('exHistory','Version history'))}</b><button class="hist-x" title="${escapeHtml(rmsTr('close','Close'))}">×</button></div>
    <div class="hist-list"><div class="hist-status">${escapeHtml(rmsTr('layoutPresetsLoading','Loading…'))}</div></div>`;
  document.body.appendChild(panel);
  panel.addEventListener('mousedown',e=>e.stopPropagation());
  panel.querySelector('.hist-x').onclick=()=>{ cancelHistoryPreview(); panel.remove(); };
  const list=panel.querySelector('.hist-list');
  const mapId=map.id;
  let versions=[];
  try{ versions=await Store.history(mapId); }
  catch(e){ list.textContent=rmsTr('storageUnavailable','Could not load your maps.'); return; }
  if(!panel.isConnected || !map || map.id!==mapId) return;
  if(!versions || !versions.length){
    list.innerHTML=`<div class="hist-status">${escapeHtml(rmsTr('histEmpty','No earlier versions yet.'))}<br><span class="hist-sub">${escapeHtml(rmsTr('histEmptySub','Versions are recorded each time the map changes. Make an edit, then check back.'))}</span></div>`;
    return;
  }
  list.innerHTML = versions.map((v,i)=>`
    <div class="hist-row" data-ref="${escapeHtml(String(v.ref!=null?v.ref:v.ts))}">
      <div class="hist-when"><b>${escapeHtml(i===0?rmsTr('histLatest','Latest'):relTime(v.ts))}</b><i>${new Date(v.ts).toLocaleString()}</i></div>
      <div class="hist-actions">
        <button class="hist-prev">${escapeHtml(rmsTr('histPreview','Preview'))}</button>
        <button class="hist-diff">${escapeHtml(rmsTr('histDiff','Diff'))}</button>
        <button class="hist-restore${i===0?' disabled':''}"${i===0?' disabled':''}>${escapeHtml(rmsTr('histRestore','Restore'))}</button>
      </div>
    </div>`).join('');
  list.querySelectorAll('.hist-row').forEach(row=>{
    const ref=row.dataset.ref;
    row.querySelector('.hist-prev').onclick=()=>previewVersion(mapId, ref, row);
    row.querySelector('.hist-diff').onclick=()=>diffVersion(mapId, ref);
    const rb=row.querySelector('.hist-restore');
    if(rb && !rb.disabled) rb.onclick=()=>restoreVersion(mapId, ref);
  });
}
// Compute node-level changes between an older map snapshot and a newer one.
function diffMaps(oldMap, newMap){
  const O=(oldMap&&oldMap.nodes)||{}, N=(newMap&&newMap.nodes)||{};
  const plain=t=>nodeTextPlain(t||'').replace(/\s+/g,' ').trim();
  const added=[], removed=[], changed=[];
  for(const id in N){ if(!(id in O)) added.push(plain(N[id].text)); }
  for(const id in O){ if(!(id in N)) removed.push(plain(O[id].text)); }
  for(const id in N){ if(id in O){ const a=plain(O[id].text), b=plain(N[id].text); if(a!==b) changed.push({from:a,to:b}); } }
  return {added, removed, changed};
}
async function loadHistoryVersion(mapId,ref){
  const generation=++_historyRequestGeneration, mapGeneration=_mapLoadGeneration;
  try{
    await flushPendingSave();
    const data=await Store.version(mapId,ref);
    if(generation!==_historyRequestGeneration || mapGeneration!==_mapLoadGeneration || !map || map.id!==mapId) return null;
    if(!data) toast(rmsTr('tVersionLoadFail','Could not load that version'));
    return data;
  }catch(error){
    if(generation===_historyRequestGeneration && mapGeneration===_mapLoadGeneration) toast(rmsTr('tVersionLoadFail','Could not load that version'));
    return null;
  }
}
async function diffVersion(mapId, ref){
  const data=await loadHistoryVersion(mapId,ref);
  if(!data) return;
  const past=normalizeLoadedMap(data);
  const current=_historyPreview ? _historyPreview.original : map;   // real current map
  showDiffPanel(diffMaps(past, current));
}
function showDiffPanel(d){
  document.querySelectorAll('.diff-panel').forEach(p=>p.remove());
  const e=escapeHtml;
  const empty=rmsTr('diffEmptyText','(empty)');
  const sec=(title,items,cls)=> !items.length ? '' :
    `<div class="diff-sec"><div class="diff-h ${cls}">${e(title)} (${items.length})</div>`+
    items.map(it=> typeof it==='string'
      ? `<div class="diff-row ${cls}">${e(it||empty)}</div>`
      : `<div class="diff-row chg"><span class="d-from">${e(it.from||empty)}</span><span class="d-arrow">\u2192</span><span class="d-to">${e(it.to||empty)}</span></div>`
    ).join('')+`</div>`;
  const total=d.added.length+d.removed.length+d.changed.length;
  const panel=document.createElement('div'); panel.className='diff-panel';
  panel.innerHTML=`<div class="diff-head"><b>${e(rmsTr('diffTitle','Changes since this version'))}</b><button class="diff-x" title="${e(rmsTr('close','Close'))}">\u00d7</button></div>`+
    (total ? sec(rmsTr('diffAdded','Added'),d.added,'add')+sec(rmsTr('diffRemoved','Removed'),d.removed,'del')+sec(rmsTr('diffEdited','Edited'),d.changed,'chg')
           : `<div class="diff-empty">${e(rmsTr('diffNone','No differences — identical to the current map.'))}</div>`);
  document.body.appendChild(panel);
  panel.querySelector('.diff-x').onclick=()=>panel.remove();
}
async function previewVersion(mapId, ref, row){
  const data=await loadHistoryVersion(mapId,ref);
  if(!data) return;
  if(!_historyPreview) _historyPreview={original:JSON.parse(JSON.stringify(map)),readOnly:READONLY};
  READONLY=true;
  map = normalizeLoadedMap(data);
  $('#mapTitle').readOnly=true;
  if(mdMode){ syncTextFromMap(); document.getElementById('mdEditor').readOnly=true; }
  render(); fit();
  document.querySelectorAll('.hist-row').forEach(r=>r.classList.remove('active'));
  row?.classList.add('active');
  showPreviewBanner(mapId, ref);
}
function showPreviewBanner(mapId, ref){
  document.querySelectorAll('.hist-banner').forEach(b=>b.remove());
  const b=document.createElement('div');
  b.className='hist-banner';
  b.innerHTML=`<span>👁 ${escapeHtml(rmsTr('histBanner','Previewing an earlier version (read-only)'))}</span>
    <button class="hb-restore">${escapeHtml(rmsTr('histRestoreThis','Restore this version'))}</button>
    <button class="hb-cancel">${escapeHtml(rmsTr('histBackCurrent','Back to current'))}</button>`;
  document.body.appendChild(b);
  b.querySelector('.hb-restore').onclick=()=>restoreVersion(mapId, ref);
  b.querySelector('.hb-cancel').onclick=()=>{ cancelHistoryPreview(); };
}
function cancelHistoryPreview(){
  ++_historyRequestGeneration;
  document.querySelectorAll('.hist-banner').forEach(b=>b.remove());
  if(_historyPreview){
    map=_historyPreview.original; READONLY=_historyPreview.readOnly; _historyPreview=null;
    $('#mapTitle').readOnly=READONLY;
    if(mdMode){ syncTextFromMap(); document.getElementById('mdEditor').readOnly=READONLY; }
    render(); fit();
  }
}
async function restoreVersion(mapId, ref){
  const data=await loadHistoryVersion(mapId,ref);
  if(!data) return;
  const restored=normalizeLoadedMap(data);
  restored.id=mapId;                 // keep identity
  restored.updated=Date.now();
  cancelHistoryPreview();
  // Pinning is sidebar state of the map as it is now, not part of the version.
  if(map && map.pinned) restored.pinned=true; else delete restored.pinned;
  map=restored;
  if(sel && !map.nodes[sel]) sel=null;
  if(typeof multiSel!=='undefined' && multiSel.size) clearMultiSelect();
  $('#mapTitle').value=map.title;
  // Append to the existing undo stack (pushHistory also resyncs the Markdown
  // editor) so ⌘Z goes back to the pre-restore map.
  pushHistory();
  render(); fit();
  // Keep the pre-restore state as its own version instead of letting the
  // restore replace it inside the current coalescing window.
  if(typeof Store.sealVersion==='function'){ try{ await Store.sealVersion(mapId); }catch(e){ console.warn('seal version failed:',e); } }
  try{ await saveMapNow(restored); }catch(e){ console.warn('save after history restore failed:',e); return; }
  if(map!==restored) return;
  document.querySelectorAll('.hist-banner,.hist-panel').forEach(p=>p.remove());
  refreshList();
  toast(rmsTr('tVersionRestored','Version restored'));
}
// Normalize a loaded/decoded map object to the current shape (defensive defaults).
// Unknown top-level fields (layoutConfig, layoutParams, layoutPreset,
// frontmatter, …) are carried over so a restore doesn't silently drop them.
function normalizeLoadedMap(m){
  return sanitizeMap({ ...m, id:m.id, title:m.title||'Untitled map', titleAuto:!!m.titleAuto, color:m.color||'#e0613a',
           rootId:m.rootId, sameLevelColors:m.sameLevelColors, style:m.style, layout:m.layout||'balanced',
           nodes:m.nodes||{}, links:m.links||[], vars:m.vars||{} });
}

/* ============================================================
   Build prompt from branch — assemble the selected subtree into a clean,
   structured prompt; copy it, or (optional, bring-your-own-key) run it
   against an LLM API and drop the answer back as child nodes.
   ============================================================ */
function assemblePrompt(rootId){
  if(!map || !map.nodes[rootId]) return '';
  const lines=[];
  const walk=(id, depth)=>{
    const n=map.nodes[id]; if(!n) return;
    const txt=nodeTextPlain(n.text||'').replace(/\n/g,' ').trim();
    const indent='  '.repeat(depth);
    if(depth===0){ lines.push(txt); }
    else { lines.push(`${indent}- ${txt}`); }
    const note=(n.notes||'').replace(/<[^>]*>/g,' ').replace(/\s+/g,' ').trim();
    if(note) lines.push(`${indent}  (${note})`);
    childrenOf(id).forEach(c=>walk(c, depth+1));
  };
  walk(rootId, 0);
  // Substitute any {{variables}} the map already has values for.
  let out=lines.join('\n');
  const vars=map.vars||{};
  out=out.replace(/\{\{(\w+)\}\}/g,(m,k)=> (vars[k]!=null && String(vars[k]).trim()!=='') ? vars[k] : m);
  return out;
}
const LLM_PROVIDERS = {
  anthropic: {
    label:'Anthropic (Claude)', url:'https://api.anthropic.com/v1/messages',
    defaultModel:'claude-3-5-sonnet-latest',
    headers:(key)=>({'content-type':'application/json','x-api-key':key,'anthropic-version':'2023-06-01','anthropic-dangerous-direct-browser-access':'true'}),
    body:(model,prompt)=>JSON.stringify({model, max_tokens:1024, messages:[{role:'user',content:prompt}]}),
    extract:(d)=> (d.content||[]).filter(b=>b.type==='text').map(b=>b.text).join('\n').trim()
  },
  openai: {
    label:'OpenAI', url:'https://api.openai.com/v1/chat/completions',
    defaultModel:'gpt-4o-mini',
    headers:(key)=>({'content-type':'application/json','Authorization':'Bearer '+key}),
    body:(model,prompt)=>JSON.stringify({model, messages:[{role:'user',content:prompt}]}),
    extract:(d)=> (d.choices&&d.choices[0]&&d.choices[0].message&&d.choices[0].message.content||'').trim()
  }
};
function showBuildPrompt(nodeId){
  if(!map){ toast(rmsTr('tOpenMapFirst','Open a map first')); return; }
  nodeId = nodeId && map.nodes[nodeId] ? nodeId : map.rootId;
  document.querySelectorAll('.bp-panel,.export-pop').forEach(p=>p.remove());
  const prompt=assemblePrompt(nodeId);
  const provider=localStorage.getItem('mindspark:llm:provider')||'anthropic';
  const model=localStorage.getItem('mindspark:llm:model:'+provider) || LLM_PROVIDERS[provider].defaultModel;
  const tok=estimateTokens(prompt,'');
  const panel=document.createElement('div');
  panel.className='bp-panel';
  panel.innerHTML=`
    <div class="bp-head"><b>${escapeHtml(rmsTf('bpTitle','Build prompt from “%s”', nodeTextPlain(map.nodes[nodeId].text||'').slice(0,40)||rmsTr('bpBranch','branch')))}</b><button class="bp-x" title="${escapeHtml(rmsTr('close','Close'))}">×</button></div>
    <textarea class="bp-text" spellcheck="false">${escapeHtml(prompt)}</textarea>
    <div class="bp-meta"><span class="bp-tok">${escapeHtml(rmsTf('bpTokens','~%s tokens', tok))}</span></div>
    <div class="bp-row">
      <button class="bp-copy primary">${escapeHtml(rmsTr('bpCopy','Copy prompt'))}</button>
      <button class="bp-toggle">${escapeHtml(rmsTr('bpRunApi','Run with API'))} ▾</button>
    </div>
    <div class="bp-run" style="display:none">
      <div class="bp-run-row">
        <select class="bp-provider">
          ${Object.entries(LLM_PROVIDERS).map(([k,v])=>`<option value="${k}"${k===provider?' selected':''}>${v.label}</option>`).join('')}
        </select>
        <input class="bp-model" placeholder="${escapeHtml(rmsTr('bpModel','model'))}" value="${escapeHtml(model)}">
      </div>
      <input class="bp-key" type="password" placeholder="${escapeHtml(rmsTr('bpKeyPh','API key (stored only in this browser)'))}" value="${escapeHtml(localStorage.getItem('mindspark:llm:key:'+provider)||'')}">
      <div class="bp-warn">⚠ ${escapeHtml(rmsTr('bpWarn','Your key is stored in this browser’s localStorage and sent directly to the provider. Use a scoped key; don’t use this on a shared machine.'))}</div>
      <button class="bp-send primary">${escapeHtml(rmsTr('bpSend','Send'))} →</button>
      <div class="bp-result" style="display:none"></div>
    </div>`;
  document.body.appendChild(panel);
  panel.addEventListener('mousedown',e=>e.stopPropagation());
  const $$=s=>panel.querySelector(s);
  $$('.bp-x').onclick=()=>panel.remove();
  $$('.bp-copy').onclick=()=>{ navigator.clipboard?.writeText($$('.bp-text').value).then(()=>toast(rmsTr('tPromptCopied','Prompt copied')),()=>toast(rmsTr('tCopyFailed','Copy failed'))); };
  $$('.bp-toggle').onclick=()=>{ const r=$$('.bp-run'); r.style.display = r.style.display==='none'?'block':'none'; };
  const provSel=$$('.bp-provider'), modelIn=$$('.bp-model'), keyIn=$$('.bp-key');
  provSel.onchange=()=>{ const pv=provSel.value;
    modelIn.value=localStorage.getItem('mindspark:llm:model:'+pv)||LLM_PROVIDERS[pv].defaultModel;
    keyIn.value=localStorage.getItem('mindspark:llm:key:'+pv)||''; };
  $$('.bp-send').onclick=async()=>{
    const pv=provSel.value, key=keyIn.value.trim(), mdl=modelIn.value.trim()||LLM_PROVIDERS[pv].defaultModel;
    if(!key){ toast(rmsTr('tEnterApiKey','Enter an API key')); return; }
    localStorage.setItem('mindspark:llm:provider',pv);
    localStorage.setItem('mindspark:llm:model:'+pv,mdl);
    localStorage.setItem('mindspark:llm:key:'+pv,key);
    const res=$$('.bp-result'); res.style.display='block'; res.textContent=rmsTr('bpRunning','Running…');
    const send=$$('.bp-send'); send.disabled=true;
    try{
      const cfg=LLM_PROVIDERS[pv];
      const r=await fetch(cfg.url,{method:'POST',headers:cfg.headers(key),body:cfg.body(mdl,$$('.bp-text').value)});
      if(!r.ok){ const t=await r.text(); throw new Error('HTTP '+r.status+' — '+t.slice(0,200)); }
      const data=await r.json();
      const answer=cfg.extract(data)||rmsTr('bpEmptyResp','(empty response)');
      res.innerHTML='';
      const pre=document.createElement('div'); pre.className='bp-answer'; pre.textContent=answer;
      const acts=document.createElement('div'); acts.className='bp-answer-acts';
      const cp=document.createElement('button'); cp.textContent=rmsTr('bpCopyAnswer','Copy answer');
      cp.onclick=()=>navigator.clipboard?.writeText(answer).then(()=>toast(rmsTr('tAnswerCopied','Answer copied')));
      const add=document.createElement('button'); add.className='primary'; add.textContent=rmsTr('bpAddChildren','Add as child nodes');
      add.onclick=()=>{ addResponseAsNodes(nodeId, answer); panel.remove(); toast(rmsTr('tAddedToMap','Added to map')); };
      acts.appendChild(cp); acts.appendChild(add);
      res.appendChild(pre); res.appendChild(acts);
    }catch(e){
      res.textContent=rmsTf('bpError','Error: %s', e.message);
    } finally { send.disabled=false; }
  };
}
// Turn an LLM answer into child nodes under `parentId`. Top-level bullet/numbered
// lines become separate children; otherwise the whole answer becomes one node.
function addResponseAsNodes(parentId, answer){
  if(!map || !map.nodes[parentId]) return;
  const lines=answer.split('\n').map(l=>l.trim()).filter(Boolean);
  const bullets=lines.filter(l=>/^([-*•]|\d+[.)])\s+/.test(l));
  const mk=(text, notes)=>{
    const id=uid();
    map.nodes[id]={ id, text:text.slice(0,200), parent:parentId, x:0, y:0, side:null, color:'#fff', created:Date.now() };
    if(notes) map.nodes[id].notes='<p>'+escapeHtml(notes).replace(/\n/g,'<br>')+'</p>';
  };
  if(bullets.length>=2 && bullets.length>=lines.length*0.5){
    bullets.forEach(b=>mk(b.replace(/^([-*•]|\d+[.)])\s+/,'')));
  } else {
    const title=lines[0]||'AI response';
    mk(title.length>60?title.slice(0,60)+'…':title, answer);
  }
  autoLayout(); pushHistory(); scheduleSave();
}

/* ============================================================
   Presentation mode — step through the map one node at a time.
   ============================================================ */
let _pres = null;   // {order, idx, collapsed} while presenting
function startPresentation(){
  if(_pres) return;
  if(!map || !map.nodes[map.rootId]){ toast(rmsTr('tOpenMapFirst','Open a map first')); return; }
  document.querySelectorAll('.export-pop').forEach(p=>p.remove());
  // Expand everything so the whole map is walkable; remember what to restore.
  const wasCollapsed = Object.keys(map.nodes).filter(id=>map.nodes[id].collapsed);
  wasCollapsed.forEach(id=>map.nodes[id].collapsed=false);
  // Depth-first order from the root → walks branch by branch.
  const order=[];
  const walk=id=>{ order.push(id); childrenOf(id).forEach(walk); };
  walk(map.rootId);
  _pres={ order, idx:0, collapsed:wasCollapsed };
  document.body.classList.add('presenting');
  autoLayout(false, {persist:false});   // temporary expand — never saved
  const bar=document.createElement('div');
  bar.className='pres-bar';
  bar.innerHTML=`<button class="pres-prev" title="${rmsTh('presPrev','Previous (←)')}">◀</button>
    <span class="pres-count"></span>
    <span class="pres-title"></span>
    <button class="pres-next" title="${rmsTh('presNext','Next (→ / Space)')}">▶</button>
    <button class="pres-exit" title="${rmsTh('presExit','Exit (Esc)')}">✕</button>`;
  document.body.appendChild(bar);
  bar.addEventListener('mousedown',e=>e.stopPropagation());
  bar.querySelector('.pres-prev').onclick=()=>presStep(-1);
  bar.querySelector('.pres-next').onclick=()=>presStep(1);
  bar.querySelector('.pres-exit').onclick=()=>endPresentation();
  document.addEventListener('keydown', presKey, true);
  presGo(0);
}
function presKey(e){
  if(!_pres) return;
  if(e.key==='ArrowRight'||e.key==='ArrowDown'||e.key===' '||e.key==='PageDown'){ e.preventDefault(); e.stopPropagation(); presStep(1); }
  else if(e.key==='ArrowLeft'||e.key==='ArrowUp'||e.key==='PageUp'){ e.preventDefault(); e.stopPropagation(); presStep(-1); }
  else if(e.key==='Escape'){ e.preventDefault(); e.stopPropagation(); endPresentation(); }
  // Everything else (Backspace, Tab, letters, ⌘Z…) would edit the map
  // underneath the presentation — swallow it.
  else { e.preventDefault(); e.stopPropagation(); }
}
function presStep(d){ if(!_pres) return; presGo(Math.max(0, Math.min(_pres.order.length-1, _pres.idx+d))); }
function presGo(i){
  if(!_pres) return;
  _pres.idx=i;
  const id=_pres.order[i];
  document.querySelectorAll('.node.pres-current').forEach(el=>el.classList.remove('pres-current'));
  const el=document.querySelector(`.node[data-id="${id}"]`);
  if(el) el.classList.add('pres-current');
  // Comfortable fixed zoom, centred on the current node.
  view.k=Math.min(1.1, Math.max(view.k, 0.9));
  centreOn(id);
  const bar=document.querySelector('.pres-bar');
  if(bar){
    bar.querySelector('.pres-count').textContent=`${i+1} / ${_pres.order.length}`;
    bar.querySelector('.pres-title').textContent=nodeTextPlain(map.nodes[id]?.text||'')||rmsTr('untitledNode','(untitled)');
    bar.querySelector('.pres-prev').disabled = i===0;
    bar.querySelector('.pres-next').disabled = i===_pres.order.length-1;
  }
}
function endPresentation(){
  if(!_pres) return;
  document.removeEventListener('keydown', presKey, true);
  document.querySelectorAll('.pres-bar').forEach(b=>b.remove());
  document.querySelectorAll('.node.pres-current').forEach(el=>el.classList.remove('pres-current'));
  document.body.classList.remove('presenting');
  // Restore collapse state (presentation never persists changes).
  (_pres.collapsed||[]).forEach(id=>{ if(map.nodes[id]) map.nodes[id].collapsed=true; });
  _pres=null;
  autoLayout(false, {persist:false}); fit();
}

function exportJSON(){
  const blob=new Blob([JSON.stringify(map,null,2)],{type:'application/json'});
  download(blob,(map.title||'mindmap')+'.json'); toast(rmsTr('tJsonExported','JSON exported'));
}
function importJSON(){ importFile(); }   // back-compat alias
// ---- GitMind (.gmind) import ----------------------------------------------
// A .gmind file is a ZIP archive containing content.json (GitMind's nested tree).
// Read the ZIP via its central directory; inflate DEFLATE entries with the native
// DecompressionStream. No external dependency.
async function _gmindUnzip(buf, prefer){
  const dv=new DataView(buf), bytes=new Uint8Array(buf);
  let eocd=-1;
  for(let i=bytes.length-22; i>=0; i--){ if(dv.getUint32(i,true)===0x06054b50){ eocd=i; break; } }
  if(eocd<0) throw new Error('Not a valid .gmind file (no ZIP directory)');
  const cdCount=dv.getUint16(eocd+10,true), cdOffset=dv.getUint32(eocd+16,true);
  const files={}; let p=cdOffset;
  for(let n=0;n<cdCount;n++){
    if(dv.getUint32(p,true)!==0x02014b50) break;
    const method=dv.getUint16(p+10,true);
    const compSize=dv.getUint32(p+20,true);
    const nameLen=dv.getUint16(p+28,true), extraLen=dv.getUint16(p+30,true), commentLen=dv.getUint16(p+32,true);
    const localOff=dv.getUint32(p+42,true);
    const name=new TextDecoder().decode(bytes.subarray(p+46, p+46+nameLen));
    const lhNameLen=dv.getUint16(localOff+26,true), lhExtraLen=dv.getUint16(localOff+28,true);
    const dataStart=localOff+30+lhNameLen+lhExtraLen;
    files[name]={method, comp:bytes.subarray(dataStart, dataStart+compSize)};
    p += 46+nameLen+extraLen+commentLen;
  }
  const key=(prefer && Object.keys(files).find(k=>k.toLowerCase().endsWith(prefer)))
    || Object.keys(files).find(k=>/(^|\/)content\.json$/i.test(k))
    || Object.keys(files).find(k=>/\.json$/i.test(k));
  if(!key) throw new Error('No content.json found inside the .gmind file');
  const f=files[key]; let out;
  if(f.method===0){ out=f.comp; }
  else if(f.method===8){
    const stream=new Response(f.comp).body.pipeThrough(new DecompressionStream('deflate-raw'));
    out=new Uint8Array(await new Response(stream).arrayBuffer());
  } else throw new Error('Unsupported compression in .gmind (method '+f.method+')');
  return new TextDecoder('utf-8').decode(out);
}
// GitMind stores rich text as HTML. Fold block elements to line breaks and run it
// through our inline sanitizer so formatting survives but nothing dangerous does.
function gmindHtmlToInline(html, plain){
  if(!html) return plain!=null ? String(plain) : '';
  let s=String(html).replace(/<\/(p|div)>/gi,'<br>').replace(/<(p|div)[^>]*>/gi,'');
  s=s.replace(/(\s*<br\s*\/?>\s*)+$/i,'');   // trim trailing breaks
  return sanitizeInlineHTML(s);
}
function convertGmindToMap(d, filename){
  const rootNode = d.root || (d.data || d.children ? d : (d.body && (d.body.root||d.body)) || d);
  if(!rootNode) throw new Error('Unrecognized .gmind structure');
  const nodes={}; const links=[]; let counter=0; const newId=()=>'g'+(counter++);
  let rootId=null;
  const applyStyle=(n, style)=>{
    if(!style) return;
    const fs=parseInt(style.fontSize,10); if(fs) n.fontSize=fs;
    if(style.fontWeight==='bold' || +style.fontWeight>=600) n.bold=true;
    if(/italic/i.test(style.fontStyle||'')) n.italic=true;
    const td=style.textDecoration||style.textDecorationLine||'';
    if(/underline/i.test(td)) n.underline=true;
    if(/line-through/i.test(td)) n.strike=true;
    if(style.color) n.textColor=style.color;
  };
  const walk=(g, parentId, isRoot)=>{
    const data=g.data||{};
    const id=newId();
    const plain = data.text!=null ? String(data.text) : '';
    const n={ id, parent:parentId, x:0, y:0,
      text: data.html ? gmindHtmlToInline(data.html, plain) : plain };
    const kids = Array.isArray(g.children) ? g.children : [];
    if(kids.length && !isRoot) n.collapsed = (data.expanded===false);
    if(data.image){ const im=data.image; const url = typeof im==='string'?im:(im.url||im.src||''); if(url) n.image=url; }
    applyStyle(n, g.style);
    nodes[id]=n;
    if(isRoot){
      rootId=id; n.side='root';
      const split = (data.mindLayoutSplitIndex!=null) ? data.mindLayoutSplitIndex : Math.ceil(kids.length/2);
      kids.forEach((c,i)=>{ const cid=walk(c, id, false); nodes[cid].side = i<split ? 'right' : 'left'; });
    } else {
      kids.forEach(c=> walk(c, id, false));
    }
    return id;
  };
  walk(rootNode, null, true);
  const title = (rootId && nodes[rootId]) ? nodeTextPlain(nodes[rootId].text) : '';
  return { id:uid(), title: title || (filename||'Imported').replace(/\.gmind$/i,''),
           titleAuto:false, color:'#e0613a', rootId, nodes, links, vars:{} };
}
async function parseGmind(buf, filename){
  const jsonText = await _gmindUnzip(buf);
  let d; try{ d=JSON.parse(jsonText); }catch(e){ throw new Error('.gmind content.json is not valid JSON'); }
  return convertGmindToMap(d, filename);
}

// ---- MindMeister (.mind) import -------------------------------------------
// A .mind file is a ZIP wrapping map.json: a nested tree whose node text lives in
// `title`, with `note` / `link` / `image` fields and a flat `connections` list.
function mindTitleToText(title){
  if(title==null) return '';
  const t=String(title).replace(/\r\n?/g,'\n');
  // Preserve intra-title line breaks as <br> (titles can contain hard wraps).
  return t.indexOf('\n')>=0 ? t.split('\n').map(escapeHtml).join('<br>') : t;
}
function convertMindToMap(d, filename){
  const root = d.root || d;
  if(!root || !root.children && root.title==null) throw new Error('Unrecognized .mind structure');
  const nodes={}; const links=[]; let counter=0; const newId=()=>'m'+(counter++);
  const idMap={}; let rootId=null;
  const th=d.theme||{};
  const bg=(th.root_style&&th.root_style.backgroundColor)||(th.background&&th.background.color)||'';
  const themeColor = /^#?[0-9a-f]{6}$/i.test(bg) ? ('#'+bg.replace(/^#/,'')) : '#5b8db2';
  const applyStyle=(n, style)=>{
    if(!style) return;
    if(style.bold) n.bold=true;
    if(style.italic) n.italic=true;
    const fs=parseInt(style.fontSize,10); if(fs) n.fontSize=fs;
    if(style.color && /^#?[0-9a-f]{6}$/i.test(style.color)) n.textColor='#'+String(style.color).replace(/^#/,'');
  };
  const walk=(g, parentId, isRoot)=>{
    const id=newId();
    if(g.id!=null) idMap[g.id]=id;
    const kids = Array.isArray(g.children) ? g.children : [];
    const n={ id, parent:parentId, x:0, y:0, text: mindTitleToText(g.title) };
    const note=g.note!=null ? String(g.note).trim() : '';
    if(note && note!=='-') n.notes = sanitizeNotes(note.replace(/\r\n?/g,'\n').replace(/\n/g,'<br>'));
    if(g.link){
      const url=typeof normalizeNodeUrl==='function' ? normalizeNodeUrl(g.link) : String(g.link);
      if(url) n.url=url;
    }
    if(g.image){ const im=g.image; const url=typeof im==='string'?im:(im.url||im.src||''); if(url) n.image=url; }
    applyStyle(n, g.style);
    nodes[id]=n;
    if(isRoot){
      rootId=id; n.side='root';
      const half=Math.ceil(kids.length/2);
      kids.forEach((c,i)=>{ const cid=walk(c,id,false); nodes[cid].side = i<half?'right':'left'; });
    } else {
      kids.forEach(c=>walk(c,id,false));
    }
    return id;
  };
  walk(root, null, true);
  (Array.isArray(d.connections)?d.connections:[]).forEach(c=>{
    const a=idMap[c.from!=null?c.from:c.source_id], b=idMap[c.to!=null?c.to:c.target_id];
    if(a && b && a!==b) links.push({from:a, to:b});
  });
  const title = (rootId && nodes[rootId]) ? nodeTextPlain(nodes[rootId].text) : '';
  return { id:uid(), title: title || (filename||'Imported').replace(/\.mind$/i,''),
           titleAuto:false, color:themeColor, rootId, nodes, links, vars:{} };
}
async function parseMind(buf, filename){
  const jsonText = await _gmindUnzip(buf, 'map.json');
  let d; try{ d=JSON.parse(jsonText); }catch(e){ throw new Error('.mind map.json is not valid JSON'); }
  return convertMindToMap(d, filename);
}

function importFile(){
  const inp=document.createElement('input');
  inp.type='file';
  inp.accept='.json,.opml,.xml,.md,.markdown,.txt,.gmind,.mind';
  inp.onchange=async()=>{
    const f=inp.files[0]; if(!f) return;
    const name=(f.name||'').toLowerCase();
    try{
      let m, preserveState=false;
      if(name.endsWith('.gmind')){
        // Binary ZIP — read as bytes, not text. GitMind carries its own
        // expanded/collapsed state, so don't force-collapse afterwards.
        m=await parseGmind(await f.arrayBuffer(), f.name);
        preserveState=true;
      } else if(name.endsWith('.mind')){
        // MindMeister ZIP (map.json). No reliable collapse state in the export,
        // so fall through to the default collapse-to-overview below.
        m=await parseMind(await f.arrayBuffer(), f.name);
      } else {
        const t=await f.text();
        if(name.endsWith('.json')) { m=JSON.parse(t); }
        else if(name.endsWith('.opml')||name.endsWith('.xml')) { m=parseOPML(t, f.name); }
        else { m=parseMarkdownOutline(t, f.name); }   // .md, .markdown, .txt
      }
      if(!m || !m.nodes || !m.rootId) throw new Error('No recognizable outline');
      m=sanitizeMap(m);
      // Start collapsed so the user sees a clean top-level overview (unless the
      // format already carries its own expand state, e.g. .gmind).
      if(!preserveState){
        Object.keys(m.nodes).forEach(id=>{
          if(id !== m.rootId) m.nodes[id].collapsed = true;
        });
      }
      m.id=uid();
      await saveMapNow(m);
      // Saved but not opened (switch refused, superseded, or read failed):
      // don't lay out / toast over whatever map is showing now.
      if(!(await loadMap(m.id))){ refreshList(); return; }
      // Imported nodes have no positions (all at 0,0) — lay them out into a
      // proper tree, then frame the result.
      autoLayout(); fit();
      refreshList();
      toast(preserveState ? rmsTf('tImported','Imported %s', f.name) : rmsTf('tImportedCollapsed','Imported %s (collapsed — click ＋ to expand)', f.name));
    }catch(e){ console.error(e); rmsAlert(rmsTr('importFailed','Could not import this file:\n%s').replace('%s', e.message)); }
  };
  inp.click();
}
// Convert basic inline markdown (**bold**, *italic*, ~~strike~~) to our HTML.
function mdInlineToHtml(t){
  const hasHtml = INLINE_HTML_RE.test(t);    // raw inline HTML (<b>, <sub>, <a>, ...) present?
  const hasMd = /!\[[^\]]*\]\([^)]+\)|\*\*[^*]+\*\*|(?:^|[^*])\*[^*]+\*|~~[^~]+~~|`[^`]+`|(?:^|[^!])\[[^\]]+\]\([^)]+\)/.test(t);
  // Plain text stays plain, except a literal "<" is escaped: callers put this output
  // into innerHTML (Markdown preview/PDF) or store it as node HTML, so "<img onerror>"
  // typed as text must never turn into a tag. Text without "<" is returned unchanged.
  if(!hasHtml && !hasMd) return String(t==null?'':t).replace(/</g,'&lt;');
  // keep any raw formatting HTML (sanitized) rather than escaping it to literal text
  let s = hasHtml ? sanitizeInlineHTML(t) : escapeHtml(t);
  // Code spans are masked out before the other inline rules run, and restored verbatim
  // afterward, so their content is never itself reinterpreted as further formatting —
  // matches standard Markdown precedence (`**not bold**` stays literal text inside a code
  // span, not a bold run). A later regex pass over the same string can't tell "this asterisk
  // is inside a <code> tag" apart from any other, so wrapping alone isn't enough — the
  // content has to be out of the string entirely while those passes run.
  const codeSlots=[];
  s = s.replace(/`([^`]+)`/g, (m, code) => { codeSlots.push(code); return '\uE010'+(codeSlots.length-1)+'\uE011'; });
  s = s.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
  s = s.replace(/(^|[^*])\*([^*]+)\*/g, '$1<i>$2</i>');
  s = s.replace(/~~([^~]+)~~/g, '<s>$1</s>');
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)[^)]*\)/g, (m,alt,src)=>'<img alt="'+alt.replace(/"/g,'&quot;')+'" src="'+src.replace(/"/g,'&quot;')+'" loading="lazy">');   // inline image
  // Links: only http(s)/mailto become <a>; any other scheme (javascript:, file:, app
  // schemes) stays visible as its literal Markdown text. Quotes are escaped so a crafted
  // URL cannot close the href attribute and add its own.
  s = s.replace(/(^|[^!])\[([^\]]+)\]\(([^)]+)\)/g, (m,p,label,url)=> isSafeLinkUrl(url.replace(/&amp;/g,'&'))
    ? p+'<a href="'+url.trim().replace(/"/g,'&quot;')+'" target="_blank" rel="noopener noreferrer">'+label+'</a>'
    : m);
  s = s.replace(/\uE010(\d+)\uE011/g, (m,idx)=>'<code>'+codeSlots[+idx]+'</code>');
  return s;
}
// Inverse of mdInlineToHtml: node HTML -> inline Markdown. Leaves $...$ math source
// verbatim (math is stored as text, not rendered into n.text), so equations round-trip.
function htmlToInlineMd(html){
  if(html==null) return '';
  if(!hasInlineMarkup(html)) return String(html);          // plain text (may hold $...$) — as-is
  const tpl=document.createElement('template'); tpl.innerHTML=html;   // inert parse
  const emit = node => {
    let out='';
    node.childNodes.forEach(ch=>{
      if(ch.nodeType===3){ out += ch.nodeValue; return; }  // text node (keeps $...$, entities decoded)
      if(ch.nodeType!==1) return;
      const tag=ch.tagName.toLowerCase(), inner=emit(ch);
      if(tag==='b'||tag==='strong')                      out+='**'+inner+'**';
      else if(tag==='i'||tag==='em')                     out+='*'+inner+'*';
      else if(tag==='s'||tag==='strike'||tag==='del')    out+='~~'+inner+'~~';
      else if(tag==='code')                              out+='`'+inner+'`';
      else if(tag==='br')                                out+='\n';
      else if(tag==='a'){ const h=ch.getAttribute('href')||''; out += h ? '['+(inner||h)+']('+h+')' : inner; }
      else if(/^(sub|sup|kbd|mark|ins|u|abbr|small)$/.test(tag)){ const at=ch.getAttribute('title'); out += '<'+tag+(at?' title="'+at.replace(/"/g,'&quot;')+'"':'')+'>'+inner+'</'+tag+'>'; }  // no md equivalent -> keep as HTML
      else if(tag==='ul'||tag==='ol'||tag==='li'){ out += '<'+tag+'>'+inner.replace(/\n/g,'<br>')+'</'+tag+'>'; }  // no md list syntax fits inside a single node's text -> keep as HTML (see applyListToSelection); guard against a bare newline (e.g. from an empty <li><br></li>) breaking the single-line Markdown round-trip
      else                                               out+=inner;   // span, div, … -> text only
    });
    return out;
  };
  return emit(tpl.content).replace(/\u00A0/g,' ');
}
// Parse an OPML document into a map.
function parseOPML(text, filename){
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if(doc.querySelector('parsererror')) throw new Error('Invalid OPML / XML');
  const body = doc.querySelector('body');
  if(!body) throw new Error('OPML has no <body>');
  const title = (doc.querySelector('head > title')?.textContent
               || (filename||'').replace(/\.[^.]+$/, '') || 'Imported').trim();
  const nodes = {};
  const rootId = uid();
  nodes[rootId] = { id:rootId, text:title, parent:null, side:'root', x:0, y:0 };
  const walk = (outline, parentId, side) => {
    const id = uid();
    const txt = outline.getAttribute('text') || outline.getAttribute('title') || '';
    nodes[id] = { id, text:mdInlineToHtml(txt.trim()), parent:parentId, side, x:0, y:0 };
    const note = outline.getAttribute('_note') || outline.getAttribute('note');
    if(note) nodes[id].notes = escapeHtml(note);
    const href = outline.getAttribute('url') || outline.getAttribute('htmlUrl') || outline.getAttribute('xmlUrl');
    if(href){
      const url=typeof normalizeNodeUrl==='function' ? normalizeNodeUrl(href) : '';
      if(url) nodes[id].url=url;
    }
    [...outline.children]
      .filter(c => c.tagName && c.tagName.toLowerCase()==='outline')
      .forEach(child => walk(child, id, side));
  };
  const tops = [...body.children].filter(c => c.tagName && c.tagName.toLowerCase()==='outline');
  tops.forEach((o, i) => walk(o, rootId, i%2 ? 'left' : 'right'));
  return { id:uid(), title, titleAuto:false, color:'#e0613a', rootId, nodes };
}
// Parse a Markdown / plain-text outline (headings and/or nested bullets) into a map.
// Parses simple "key: value" YAML frontmatter lines into an ordered list of {key,value}
// pairs. Not a general YAML parser — frontmatter for things like a Claude Skill (or most
// static-site front matter) is flat key: value pairs, optionally quoted; a continuation
// line (no "key:" prefix, e.g. a wrapped block-scalar description) is appended to the
// previous field's value rather than attempting a full YAML block-scalar parse.
function parseFrontmatterFields(raw){
  const inner = raw.replace(/^---\r?\n/, '').replace(/\r?\n---\s*$/, '');
  const lines = inner.split(/\r?\n/);
  const fields = [];
  for(const line of lines){
    if(!line.trim()) continue;
    const m = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if(!m){ if(fields.length) fields[fields.length-1].value += ' '+line.trim(); continue; }
    let [, key, value] = m;
    value = value.trim();
    if(value.length>1 && ((value[0]==="'" && value[value.length-1]==="'") || (value[0]==='"' && value[value.length-1]==='"'))){
      value = value.slice(1,-1);
    }
    fields.push({ key, value });
  }
  return fields;
}
function frontmatterFieldsToHtml(fields){
  const esc = s => String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  let h = '<table><thead><tr><th>Field</th><th>Value</th></tr></thead><tbody>';
  fields.forEach(f=>{ h += '<tr><td>'+esc(f.key)+'</td><td>'+esc(f.value)+'</td></tr>'; });
  h += '</tbody></table>';
  return h;
}
// Inverse of frontmatterFieldsToHtml: reads a frontmatter table node's rows back into a
// "---\nkey: value\n---" YAML block for export.
function frontmatterNodeToYaml(n){
  const tpl=document.createElement('template'); tpl.innerHTML=n.html||'';
  const rows=[...tpl.content.querySelectorAll('tbody tr')];
  const lines=['---'];
  rows.forEach(tr=>{
    const cells=tr.querySelectorAll('td'); if(cells.length<2) return;
    const key=(cells[0].textContent||'').trim(); if(!key) return;
    let value=(cells[1].textContent||'').trim();
    // Re-quote if the value has characters YAML would otherwise treat specially (colon,
    // leading/trailing whitespace, empty, or a leading character with special YAML meaning).
    if(value==='' || /^\s|\s$/.test(value) || /[:#{}\[\],&*!|>'"%@`]/.test(value)){
      value = "'"+value.replace(/'/g, "''")+"'";
    }
    lines.push(key+': '+value);
  });
  lines.push('---');
  return lines.join('\n');
}
function parseMarkdownOutline(text, filename, editorState){
  // Windows (\r\n) and classic Mac (\r) files: a stray \r would stick to
  // every heading/list item's text.
  text=String(text==null?'':text).replace(/\r\n?/g,'\n');
  // An editor session carries node identity separately from the exported text.
  // Imports still allocate independent IDs. Metadata indexed by outline paths is
  // appropriate for import, but cannot identify nodes after an in-place insert.
  const previousNodes=editorState && editorState.previousNodes;
  const idsByLine=(editorState && editorState.nodeIdsByLine)||[];
  const lineMap=editorState && editorState.lineMap;
  if(lineMap) lineMap.length=0;
  let sourceLine=0, prefixLines=0, frontmatterLine=0;
  let _meta=null, _frontmatter=null;
  // Strip a leading <!-- mindspark ... --> comment and a leading YAML --- ... --- block,
  // in whichever order they appear. Looping instead of checking each once matters: if
  // buildMarkdown ever emits them in a different order than expected, a single anchored
  // check would silently stop matching the second block, leaving it to leak into the
  // outline as literal text/nodes instead of being recognized as metadata.
  for(let guard=0; guard<4; guard++){
    const mm = text.match(/^\uFEFF?\s*<!--\s*mindspark\s*\r?\n([\s\S]*?)\r?\n\s*-->\s*\r?\n?/i);
    if(mm){ try{ _meta=JSON.parse(mm[1].trim()); }catch(e){ _meta=null; } prefixLines+=(mm[0].match(/\n/g)||[]).length; text=text.slice(mm[0].length); continue; }
    const fm = text.match(/^\s*---\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?/);
    if(fm){ frontmatterLine=prefixLines; _frontmatter=('---\n'+fm[1].replace(/\s+$/,'')+'\n---'); prefixLines+=(fm[0].match(/\n/g)||[]).length; text=text.slice(fm[0].length); continue; }
    break;
  }
  const title = (filename||'').replace(/\.[^.]+$/, '') || 'Imported';
  const nodes = {};
  const rootId = uid();
  nodes[rootId] = { id:rootId, text:title, parent:null, side:'root', x:0, y:0 };
  // Frontmatter (a leading YAML block — e.g. a Claude Skill's `name`/`description`, or a
  // static-site page's front matter) becomes a real, visible, editable child node instead of
  // being silently dropped: rendered as a small "Field | Value" table so it's readable at a
  // glance and directly editable, and re-emitted as proper --- YAML --- at the very top of the
  // file when the map is exported back to Markdown (see buildMarkdown / frontmatterNodeToYaml).
  // Inserted into `nodes` before the main parse loop runs so it naturally lands as the first
  // child once the sole-top-level-heading gets promoted to root, below.
  let frontmatterId = null;
  if(_frontmatter){
    frontmatterId = previousNodes && previousNodes[idsByLine[frontmatterLine]] ? idsByLine[frontmatterLine] : uid();
    if(lineMap) lineMap[frontmatterLine]=frontmatterId;
    const fields = parseFrontmatterFields(_frontmatter);
    nodes[frontmatterId] = { ...(previousNodes && previousNodes[frontmatterId]), id:frontmatterId, parent:rootId, x:0, y:0, frontmatter:true, html: frontmatterFieldsToHtml(fields) };
  }
  const stack = [{ id:rootId, depth:0 }];
  let sideCounter = 0, lastHeadingDepth = 0, subDepth = null;
  const LIST_WRAP_RE = /^<(ul|ol)>([\s\S]*)<\/\1>$/i;
  const add = (txt, depth, task, extra) => {
    while(stack.length>1 && stack[stack.length-1].depth >= depth) stack.pop();
    const parentId = stack[stack.length-1].id;
    const oldId=idsByLine[sourceLine];
    const previous=previousNodes && previousNodes[oldId] && !nodes[oldId] ? previousNodes[oldId] : null;
    const id=previous ? oldId : uid();
    if(lineMap) lineMap[sourceLine]=id;
    let side = 'right';
    if(parentId===rootId) side = (sideCounter++ % 2) ? 'left' : 'right';
    else side = nodes[parentId].side || 'right';
    // A formula ("=SUM(children)", "=2*3*4", ...) is verbatim, code-like content — never run
    // it through inline-markdown scanning, which would happily mangle e.g. the asterisks in
    // "=2*3*4" into a spurious *italic* span.
    const isFormula = txt.trim().startsWith('=');
    let text = isFormula ? txt.trim() : mdInlineToHtml(txt), listType = null;
    const styleProps = {};
    // Peel whole-node style wrapper tags (from buildMarkdown's wrapStyle — <div style=
    // text-align>, <span style=font-size>, <span style=color>, <mark style=background-
    // color>, <u>) from the outside in, extracting each into a discrete node property.
    // Unlike bold/italic/strike (which are fine left as plain embedded <b>/<i>/<s> — purely
    // a rendering concern), fontSize/textColor/highlight/align also feed layout and PDF/
    // canvas export elsewhere, so they need to land back on the node object itself.
    const peelStyle = s => {
      let m, changed = true;
      while(changed){
        changed = false;
        if((m = s.match(/^<div style="text-align:(left|right)">([\s\S]*)<\/div>$/i))){ styleProps.align = m[1].toLowerCase(); s = m[2]; changed = true; }
        else if((m = s.match(/^<span style="font-size:(\d+)px">([\s\S]*)<\/span>$/i))){ styleProps.fontSize = +m[1]; s = m[2]; changed = true; }
        else if((m = s.match(/^<span style="color:(#[0-9a-fA-F]{3,8})">([\s\S]*)<\/span>$/i))){ styleProps.textColor = m[1]; s = m[2]; changed = true; }
        else if((m = s.match(/^<mark style="background-color:(#[0-9a-fA-F]{3,8})">([\s\S]*)<\/mark>$/i))){ styleProps.highlight = m[1]; s = m[2]; changed = true; }
        else if((m = s.match(/^<u>([\s\S]*)<\/u>$/i))){ styleProps.underline = true; s = m[1]; changed = true; }
      }
      return s;
    };
    // A whole-node bulleted/numbered list (multiple lines inside ONE node) has no plain-
    // Markdown equivalent, so buildMarkdown emits it as literal <ul>/<ol><li> HTML instead
    // (already part of the sanitizer's inline-HTML whitelist). Recognize that shape here and
    // unwrap it back into the canvas-native form: listType + <br>-joined line text — a single
    // node/line either way, no separate bookkeeping required.
    if(!isFormula){
      const lm = text.match(LIST_WRAP_RE);
      if(lm){
        const tpl = document.createElement('template'); tpl.innerHTML = lm[2];
        const kids = [...tpl.content.childNodes].filter(c => c.nodeType===1 || (c.nodeType===3 && c.nodeValue.trim()));
        if(kids.length && kids.every(c => c.nodeType===1 && c.tagName.toLowerCase()==='li')){
          text = kids.map(li=>{
            const inner = li.innerHTML;
            // A lone <br> is applyListToSelection's placeholder for an otherwise-empty
            // line (kept so the <li> still has visible height) — treat it as empty here,
            // not as literal content, or joining with <br> below would double it up.
            return /^\s*<br\s*\/?>\s*$/i.test(inner) ? '' : peelStyle(inner);
          }).join('<br>');
          listType = lm[1].toLowerCase()==='ol' ? 'ol' : 'ul';
        }
      } else {
        text = peelStyle(text);
      }
    }
    const carried=previous ? {...previous} : {};
    // These fields are represented by editable Markdown; removing their syntax
    // must remove the corresponding formatting/content. Other node properties
    // (marker, dimensions, color, citation, etc.) remain owned by this node.
    for(const key of ['text','html','raw','lang','task','listType','bold','italic','strike','underline',
      'fontSize','textColor','highlight','align','notes','image','imageAlt','hlevel','hr','para']) delete carried[key];
    nodes[id] = { ...carried, id, text, parent:parentId, side:previous ? previous.side : side, x:0, y:0 };
    if(listType) nodes[id].listType = listType;
    Object.assign(nodes[id], styleProps);
    if(task) nodes[id].task = task;
    if(extra) Object.assign(nodes[id], extra);
    stack.push({ id, depth });
  };
  const IMG_LINE = /^!\[([^\]]*)\]\(([^)]+)\)$/;   // [1]=alt [2]=src
  const attachCur = fn => { const c=stack[stack.length-1]; if(c && nodes[c.id]) fn(nodes[c.id]); };
  const attachNotes = html => attachCur(n=>{ n.notes = (n.notes ? n.notes + '\n' : '') + html; });
  const escHtml = t => t.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const splitRow = r => { let x=r.trim(); if(x[0]==='|') x=x.slice(1); if(x[x.length-1]==='|') x=x.slice(0,-1); return x.split('|').map(c=>c.trim()); };
  const isTableSep = x => /-/.test(x) && /^[\s|:-]+$/.test(x) && x.includes('|');
  const tableToHtml = rows => {
    const head = splitRow(rows[0]);
    const cell = (c,tag) => '<'+tag+'>'+mdInlineToHtml(c)+'</'+tag+'>';
    let h='<table><thead><tr>'+head.map(c=>cell(c,'th')).join('')+'</tr></thead>';
    const body=rows.slice(2).filter(r=>r.trim());
    if(body.length) h+='<tbody>'+body.map(r=>{ const cs=splitRow(r); return '<tr>'+head.map((_,i)=>cell(cs[i]!=null?cs[i]:'','td')).join('')+'</tr>'; }).join('')+'</tbody>';
    return h+'</table>';
  };
  const L = text.split('\n');
  const base = () => (subDepth!=null ? subDepth : lastHeadingDepth);   // current section container
  const stripWrap = x => x.replace(/^<(?:p|div|center|figure|picture|span|section|article)\b[^>]*>/i,'').replace(/<\/(?:p|div|center|figure|picture|span|section|article)>$/i,'').trim();
  const nextIsBullet = from => { for(let k=from+1;k<L.length;k++){ if(!L[k].trim()) continue; return /^\s*(?:[-*+]|\d+\.)\s+/.test(L[k]); } return false; };
  for(let i=0; i<L.length; i++){
    sourceLine=prefixLines+i;
    const line = L[i];
    // Fenced code block -> its own block child node of the nearest heading (renders the code)
    const fence = line.match(/^(\s*)(`{3,}|~{3,})(.*)$/);
    if(fence){
      const ind=fence[1], fch=fence[2][0], flen=fence[2].length, buf=[]; let j=i+1;
      while(j<L.length){ const cl=L[j].match(/^\s*(`{3,}|~{3,})\s*$/); if(cl && cl[1][0]===fch && cl[1].length>=flen) break; buf.push(L[j].startsWith(ind)?L[j].slice(ind.length):L[j]); j++; }
      const lang=fence[3].trim();
      add(lang||'code', base() + 1 + Math.floor(ind.length/2), null, { html:'<pre><code>'+escHtml(buf.join('\n'))+'</code></pre>', lang:lang||'' });
      i=j; continue;   // skip past the closing fence
    }
    // GFM table (header row + separator line) -> its own block child node of the nearest heading
    if(line.includes('|') && line.trim() && i+1<L.length && isTableSep(L[i+1])){
      const ind=(line.match(/^\s*/)||[''])[0].length;
      const rows=[line, L[i+1]]; let j=i+2;
      while(j<L.length && L[j].includes('|') && L[j].trim()){ rows.push(L[j]); j++; }
      add('table', base() + 1 + Math.floor(ind/2), null, { html:tableToHtml(rows) }); i=j-1; continue;
    }
    if(!line.trim()) continue;
    // Multi-line raw HTML block (<table>, <div style=...>, <details>, ...) -> one raw block node
    const htmlOpen = line.match(/^\s*<(table|div|details|figure|blockquote|dl|section)\b/i);
    if(htmlOpen && !new RegExp('</'+htmlOpen[1]+'\\s*>','i').test(line)){
      const tag=htmlOpen[1].toLowerCase(), buf=[line]; let depth=1, j=i+1;
      const openRe=new RegExp('<'+tag+'\\b','gi'), closeRe=new RegExp('</'+tag+'\\s*>','gi');
      while(j<L.length && depth>0){ const ln=L[j]; buf.push(ln); depth += (ln.match(openRe)||[]).length - (ln.match(closeRe)||[]).length; j++; }
      add(tag+' block', base() + 1, null, { html: buf.join('\n'), raw:true });
      i=j-1; continue;
    }
    // Raw HTML <img> (bare, or wrapped in <p>/<a>/<figure>) -> image on the current node
    const rawImg = line.match(/<img\b[^>]*>/i);
    if(rawImg){
      const src=(rawImg[0].match(/\bsrc\s*=\s*["']([^"']+)["']/i)||[])[1];
      const alt=(rawImg[0].match(/\balt\s*=\s*["']([^"']*)["']/i)||[])[1];
      if(src) attachCur(n=>{ n.image=src; if(alt) n.imageAlt=alt; });
      continue;
    }
    // Horizontal rule (---, ***, ___) -> separator, not a node
    if(/^\s*([-*_])(?:[ \t]*\1){2,}[ \t]*$/.test(line)){ add('', base()+1, null, {hr:true}); continue; }   // horizontal rule -> divider node
    // A bare block wrapper on its own line (<p ...>, </p>, <div>, <center>, <figure>...) -> unwrap (no node)
    if(/^<\/?(?:p|div|center|figure|picture|section|article)\b[^>]*>$/i.test(line.trim())) continue;
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if(h){ lastHeadingDepth = h[1].length; subDepth = null; add(h[2].trim(), lastHeadingDepth, null, { hlevel:h[1].length }); continue; }
    // Blockquote -> the current node's notes
    const quote = line.match(/^\s*>\s?(.*)$/);
    if(quote){ attachCur(n=>{ n.notes = (n.notes ? n.notes + '\n' : '') + quote[1]; }); continue; }
    // A standalone image line -> attach to the current node (don't make a child)
    const imgLine = line.trim().match(IMG_LINE);
    if(imgLine){ attachCur(n=>{ n.image = imgLine[2]; if(imgLine[1]) n.imageAlt = imgLine[1]; }); continue; }
    const bullet = line.match(/^(\s*)(?:[-*+]|\d+\.)\s+(.*)$/);
    if(bullet){
      const indent = bullet[1].replace(/\t/g, '  ').length;
      let body = bullet[2].trim(), task = null;
      const cb = body.match(/^\[([ xX])\]\s+(.*)$/);        // GitHub-style task checkbox
      if(cb){ task = cb[1].toLowerCase()==='x' ? 'done' : 'todo'; body = cb[2].trim(); }
      const bi = body.match(IMG_LINE);                        // a bullet that is only an image
      if(bi){ attachCur(n=>{ n.image = bi[2]; if(bi[1]) n.imageAlt = bi[1]; }); continue; }
      add(body, base() + 1 + Math.floor(indent/2), task);
      continue;
    }
    // A bold-led paragraph immediately followed by a list acts as a sub-heading:
    // it becomes the parent of that list (e.g. "**Editing & canvas**" over its bullets).
    if(nextIsBullet(i)){   // a lead-in line directly above a list -> parent of that list
      add(line.trim(), lastHeadingDepth + 1, null, {para:true});
      subDepth = lastHeadingDepth + 1;
      continue;
    }
    // Plain paragraph: hang under the current section (unwrap a surrounding block tag)
    const para = stripWrap(line.trim());
    if(para) add(para, base() + 1, null, {para:true});   // plain line -> paragraph child (no bullet marker)
  }
  // The filename is the map TITLE, not a node. When the whole document hangs off a
  // single top-level node (the common case: one `# Heading`), promote it to the root
  // and drop the filename wrapper — matching how markmap renders a Markdown file.
  // (The frontmatter node, if any, doesn't count as "real" content for this check — a
  // skill.md with one heading plus its frontmatter should still promote the heading.)
  let finalRoot = rootId;
  const tops = Object.values(nodes).filter(n => n.parent === rootId && n.id !== frontmatterId);
  if(tops.length === 1){
    const promoted = tops[0];
    promoted.parent = null; promoted.side = 'root';
    delete nodes[rootId];
    finalRoot = promoted.id;
    if(frontmatterId) nodes[frontmatterId].parent = finalRoot;
  }
  // Balanced left/right split (each branch kept consistent) so the imported map isn't
  // lopsided — the parser can't call the DOM-bound balanceRootSides().
  const kids = Object.values(nodes).filter(n => n.parent === finalRoot);
  const half = Math.ceil(kids.length / 2);
  const setBranch = (id, side) => { nodes[id].side = side; Object.values(nodes).filter(c => c.parent === id).forEach(c => setBranch(c.id, side)); };
  kids.forEach((k, i) => setBranch(k.id, i < half ? 'right' : 'left'));
  nodes[finalRoot].side = 'root';
  if(_meta && _meta.nodes && !previousNodes){
    const kidsOrd = pid => Object.values(nodes).filter(n=>n.parent===pid);   // document order (matches export)
    const applyMeta=(id,path)=>{ const mm=_meta.nodes[path], n=nodes[id];
      if(mm && n){
        if(safeColor(mm.color)) n.color=safeColor(mm.color); if(safeColor(mm.textColor)) n.textColor=safeColor(mm.textColor);
        if(mm.w){ n.width=mm.w; n.w=mm.w; } if(mm.h){ n.height=mm.h; n.h=mm.h; }
        if(mm.collapsed) n.collapsed=true;
        if(mm.underline) n.underline=true;   // bold/italic/strike round-trip via visible **/*/~~ syntax instead (see buildMarkdown)
        if(mm.fontSize) n.fontSize=mm.fontSize; if(mm.listType) n.listType=mm.listType;
        if(safeColor(mm.highlight)) n.highlight=safeColor(mm.highlight); if(mm.align) n.align=mm.align;
        if(mm.image) n.image=mm.image; if(mm.url) n.url=mm.url; if(mm.ref) n.ref=true; if(mm.citation) n.citation=mm.citation;
        if(mm.created) n.created=mm.created; if(mm.updated) n.updated=mm.updated;
      }
      kidsOrd(id).forEach((c,i)=>applyMeta(c.id, path+'.'+i));
    };
    applyMeta(finalRoot, '0');
  }
  const out = { id:uid(), title, titleAuto:false, color:(_meta&&safeColor(_meta.color))||'#e0613a', rootId:finalRoot, nodes };
  if(_frontmatter) out.frontmatter=_frontmatter;
  if(_meta&&_meta.layout) out.layout=_meta.layout;
  if(_meta&&_meta.vars) out.vars=_meta.vars;
  return out;
}

// ============================================================================
// Formula engine: Excel-like calculations for nodes.
//
// A node becomes a "formula" when its (plain) text starts with '='. Supports:
//  - arithmetic: + - * / % ^ (right-assoc), parens, unary +/-
//  - comparisons: < > <= >= == !=  (produce 1/0, usable in IF)
//  - functions: SUM AVERAGE/AVG MIN MAX COUNT ROUND ABS SQRT POW MOD FLOOR
//               CEIL/CEILING TRUNC IF LOG LOG10 EXP PI E
//  - SUM(children) etc: aggregate over the current node's direct children
//  - {Label}: reference another node by label — matches either a bare-number
//    node's full text, or (for the natural "Rent: 1200" mind-map pattern) the
//    part before the colon, so a descriptively-labeled node is both readable
//    AND referenceable from a sibling formula.
//
// Plain (non-formula) node text is still usable as a *value* if it parses as
// a number (optionally with $ / % / thousands separators, or a "Label: n"
// prefix) — so a parent can SUM(children) over a mix of plain numbers and
// sub-formulas, same as Excel treats a bare "42" cell as a number.
// ============================================================================
class FormulaError extends Error {}
const FORMULA_FUNCS = {
  SUM:     args => args.reduce((a,b)=>a+b, 0),
  AVERAGE: args => args.length ? args.reduce((a,b)=>a+b,0)/args.length : 0,
  AVG:     args => FORMULA_FUNCS.AVERAGE(args),
  MIN:     args => { if(!args.length) throw new FormulaError(rmsTf('fxErrNeedOne','%s needs at least one value','MIN')); return Math.min(...args); },
  MAX:     args => { if(!args.length) throw new FormulaError(rmsTf('fxErrNeedOne','%s needs at least one value','MAX')); return Math.max(...args); },
  COUNT:   args => args.length,
  ROUND:   args => { const x=args[0], n=args.length>1?args[1]:0; const f=Math.pow(10,n); return Math.round(x*f)/f; },
  ABS:     args => Math.abs(args[0]),
  SQRT:    args => { if(args[0]<0) throw new FormulaError(rmsTr('fxErrSqrtNeg','SQRT of a negative number')); return Math.sqrt(args[0]); },
  POW:     args => Math.pow(args[0], args[1]),
  MOD:     args => { if(args[1]===0) throw new FormulaError(rmsTr('fxErrDivZero','Division by zero')); return args[0] % args[1]; },
  FLOOR:   args => Math.floor(args[0]),
  CEIL:    args => Math.ceil(args[0]),
  CEILING: args => Math.ceil(args[0]),
  TRUNC:   args => Math.trunc(args[0]),
  LOG:     args => Math.log(args[0]),
  LOG10:   args => Math.log10(args[0]),
  EXP:     args => Math.exp(args[0]),
};
// Function signatures shown in the formula autocomplete popup.
const FORMULA_FUNC_INFO = [
  {name:'SUM',     sig:'SUM(a, b, ...)',      desc:'Adds up values \u2014 try SUM(children)'},
  {name:'AVERAGE', sig:'AVERAGE(a, b, ...)',  desc:'Mean of values \u2014 try AVERAGE(children)'},
  {name:'AVG',     sig:'AVG(a, b, ...)',      desc:'Alias for AVERAGE'},
  {name:'MIN',     sig:'MIN(a, b, ...)',      desc:'Smallest value'},
  {name:'MAX',     sig:'MAX(a, b, ...)',      desc:'Largest value'},
  {name:'COUNT',   sig:'COUNT(a, b, ...)',    desc:'How many values'},
  {name:'ROUND',   sig:'ROUND(x, digits)',    desc:'Rounds x to given decimals'},
  {name:'ABS',     sig:'ABS(x)',              desc:'Absolute value'},
  {name:'SQRT',    sig:'SQRT(x)',             desc:'Square root'},
  {name:'POW',     sig:'POW(x, y)',           desc:'x to the power of y'},
  {name:'MOD',     sig:'MOD(x, y)',           desc:'Remainder of x / y'},
  {name:'FLOOR',   sig:'FLOOR(x)',            desc:'Round down'},
  {name:'CEIL',    sig:'CEIL(x)',             desc:'Round up'},
  {name:'TRUNC',   sig:'TRUNC(x)',            desc:'Drop the decimal part'},
  {name:'IF',      sig:'IF(cond, then, else)',desc:'Branches on a condition'},
  {name:'LOG',     sig:'LOG(x)',              desc:'Natural log'},
  {name:'LOG10',   sig:'LOG10(x)',            desc:'Base-10 log'},
  {name:'EXP',     sig:'EXP(x)',              desc:'e to the power of x'},
  {name:'PI',      sig:'PI',                  desc:'3.14159...'},
];
function _formulaTokenize(src){
  const toks=[]; let i=0; const n=src.length;
  while(i<n){
    const c=src[i];
    if(/\s/.test(c)){ i++; continue; }
    if(c==='{'){
      const j=src.indexOf('}', i+1);
      if(j<0) throw new FormulaError(rmsTr('fxErrUnclosed','Unclosed { reference'));
      toks.push({t:'ref', v:src.slice(i+1,j).trim()}); i=j+1; continue;
    }
    if(/[0-9]/.test(c) || (c==='.' && /[0-9]/.test(src[i+1]||''))){
      let j=i, dot=false;
      while(j<n && (/[0-9]/.test(src[j]) || (src[j]==='.' && !dot))){ if(src[j]==='.') dot=true; j++; }
      toks.push({t:'num', v:parseFloat(src.slice(i,j))}); i=j; continue;
    }
    if(/[A-Za-z_]/.test(c)){
      let j=i; while(j<n && /[A-Za-z0-9_]/.test(src[j])) j++;
      toks.push({t:'ident', v:src.slice(i,j)}); i=j; continue;
    }
    if(c==='<' || c==='>' || c==='!'){
      if(src[i+1]==='='){ toks.push({t:'op', v:c+'='}); i+=2; continue; }
      toks.push({t:'op', v:c}); i++; continue;
    }
    if(c==='='){
      if(src[i+1]==='='){ toks.push({t:'op', v:'=='}); i+=2; continue; }
      toks.push({t:'op', v:'=='}); i++; continue;   // lone "=" also means equality inside an expression
    }
    if('+-*/%^'.includes(c)){ toks.push({t:'op', v:c}); i++; continue; }
    if(c==='('){ toks.push({t:'('}); i++; continue; }
    if(c===')'){ toks.push({t:')'}); i++; continue; }
    if(c===','){ toks.push({t:','}); i++; continue; }
    throw new FormulaError(rmsTf('fxErrChar','Unexpected character: “%s”', c));
  }
  toks.push({t:'eof'});
  return toks;
}
function _formulaParse(toks){
  let p=0;
  const peek=()=>toks[p];
  const next=()=>toks[p++];
  function expect(t){ const tok=next(); if(tok.t!==t) throw new FormulaError(rmsTf('fxErrExpected','Expected “%s”', t)); return tok; }
  function parseExpression(){ return parseComparison(); }
  function parseComparison(){
    let left=parseAdd();
    const t=peek();
    if(t.t==='op' && ['<','>','<=','>=','==','!='].includes(t.v)){
      next(); const right=parseAdd();
      return {type:'cmp', op:t.v, left, right};
    }
    return left;
  }
  function parseAdd(){
    let node=parseTerm();
    while(peek().t==='op' && (peek().v==='+'||peek().v==='-')){
      const op=next().v; node={type:'bin', op, left:node, right:parseTerm()};
    }
    return node;
  }
  function parseTerm(){
    let node=parseUnary();
    while(peek().t==='op' && (peek().v==='*'||peek().v==='/'||peek().v==='%')){
      const op=next().v; node={type:'bin', op, left:node, right:parseUnary()};
    }
    return node;
  }
  // Unary binds looser than ^ on the left (-2^2 is -(2^2) = -4, the standard math/Python
  // convention — not (-2)^2 = 4), but parsePower's own right-hand (exponent) side still
  // goes through parseUnary so 2^-2 = 0.25 works without needing parens around the -2.
  function parsePower(){
    const base=parsePrimary();
    if(peek().t==='op' && peek().v==='^'){ next(); return {type:'bin', op:'^', left:base, right:parseUnary()}; }
    return base;
  }
  function parseUnary(){
    if(peek().t==='op' && (peek().v==='-'||peek().v==='+')){
      const op=next().v; return {type:'unary', op, arg:parseUnary()};
    }
    return parsePower();
  }
  function parseArg(){
    if(peek().t==='ident' && peek().v.toLowerCase()==='children' && toks[p+1] && toks[p+1].t!=='('){
      next(); return {type:'children'};
    }
    return parseExpression();
  }
  function parsePrimary(){
    const t=peek();
    if(t.t==='num'){ next(); return {type:'num', value:t.v}; }
    if(t.t==='ref'){ next(); return {type:'ref', label:t.v}; }
    if(t.t==='('){ next(); const e=parseExpression(); expect(')'); return e; }
    if(t.t==='ident'){
      next();
      const name=t.v.toUpperCase();
      if(peek().t==='('){
        next();
        const args=[];
        if(peek().t!==')'){
          args.push(parseArg());
          while(peek().t===','){ next(); args.push(parseArg()); }
        }
        expect(')');
        return {type:'call', name, args};
      }
      if(name==='CHILDREN') return {type:'children'};
      return {type:'const', name};
    }
    throw new FormulaError(rmsTr('fxErrToken','Unexpected token in formula'));
  }
  const ast=parseExpression();
  if(peek().t!=='eof') throw new FormulaError(rmsTr('fxErrTrailing','Unexpected trailing input'));
  return ast;
}
function _assertNum(v, where){
  if(v && typeof v==='object' && '__children' in v) throw new FormulaError(rmsTr('fxErrChildren','children can only be used as a whole function argument, e.g. SUM(children)'));
  if(typeof v!=='number' || !isFinite(v)) throw new FormulaError(where ? rmsTf('fxErrNumberAt','Expected a number (%s)', where) : rmsTr('fxErrNumber','Expected a number'));
}
function _formulaEval(node, ctx){
  switch(node.type){
    case 'num': return node.value;
    case 'const':
      if(node.name==='PI') return Math.PI;
      if(node.name==='E') return Math.E;
      throw new FormulaError(rmsTf('fxErrName','Unknown name: %s', node.name));
    case 'children': return { __children: ctx.children() };
    case 'ref': {
      const v = ctx.resolveRef(node.label);
      if(v==null) throw new FormulaError(rmsTf('fxErrResolve','Cannot resolve {%s}', node.label));
      _assertNum(v, '{'+node.label+'}');
      return v;
    }
    case 'unary': {
      const v=_formulaEval(node.arg, ctx); _assertNum(v);
      return node.op==='-' ? -v : v;
    }
    case 'bin': {
      const l=_formulaEval(node.left, ctx), r=_formulaEval(node.right, ctx);
      _assertNum(l); _assertNum(r);
      switch(node.op){
        case '+': return l+r;
        case '-': return l-r;
        case '*': return l*r;
        case '/': if(r===0) throw new FormulaError(rmsTr('fxErrDivZero','Division by zero')); return l/r;
        case '%': if(r===0) throw new FormulaError(rmsTr('fxErrDivZero','Division by zero')); return l%r;
        case '^': return Math.pow(l,r);
      }
      break;
    }
    case 'cmp': {
      const l=_formulaEval(node.left, ctx), r=_formulaEval(node.right, ctx);
      _assertNum(l); _assertNum(r);
      switch(node.op){
        case '<': return l<r?1:0;   case '>': return l>r?1:0;
        case '<=': return l<=r?1:0; case '>=': return l>=r?1:0;
        case '==': return l===r?1:0; case '!=': return l!==r?1:0;
      }
      break;
    }
    case 'call': {
      if(node.name==='IF'){
        if(node.args.length!==3) throw new FormulaError(rmsTr('fxErrIf','IF needs 3 arguments: IF(cond, then, else)'));
        const cond=_formulaEval(node.args[0], ctx); _assertNum(cond, 'IF condition');
        return cond ? _formulaEval(node.args[1], ctx) : _formulaEval(node.args[2], ctx);
      }
      if(node.name==='PI' && node.args.length===0) return Math.PI;
      const fn=FORMULA_FUNCS[node.name];
      if(!fn) throw new FormulaError(rmsTf('fxErrFunc','Unknown function: %s()', node.name));
      const flat=[];
      for(const a of node.args){
        const v=_formulaEval(a, ctx);
        if(v && typeof v==='object' && '__children' in v) flat.push(...v.__children);
        else { _assertNum(v, 'argument to '+node.name); flat.push(v); }
      }
      return fn(flat);
    }
  }
  throw new FormulaError(rmsTr('fxErrMalformed','Malformed formula'));
}
function evalFormula(src, ctx){
  const toks=_formulaTokenize(src);
  const ast=_formulaParse(toks);
  const v=_formulaEval(ast, ctx);
  _assertNum(v, 'result');
  return v;
}
function parseNumericLiteral(text){
  if(text==null) return null;
  let s=String(text).trim();
  if(!s) return null;
  let percent=false;
  if(/%$/.test(s)){ percent=true; s=s.slice(0,-1).trim(); }
  s=s.replace(/^[$\u20ac\u00a3\u00a5]\s*/,'').replace(/,/g,'');
  if(!/^-?\d+(\.\d+)?$/.test(s)) return null;
  const v=parseFloat(s);
  return percent ? v/100 : v;
}
function parseLabeledValue(text){
  const s=String(text||'').trim();
  const m=s.match(/^(.+?):\s*(.+)$/);
  if(m){
    const val=parseNumericLiteral(m[2]);
    if(val!=null) return { label:m[1].trim(), value:val };
  }
  return { label:s, value:parseNumericLiteral(s) };
}
// Cleared at the start of every render() so formulas always reflect the current map;
// memoized within a single pass so a value referenced by several formulas is only computed once.
let _formulaCache=new Map();
// normalized label -> node ids (map order), built on first whole-map lookup
// in a pass so each reference does not re-parse every node's text.
let _formulaLabelIndex=null;
function clearFormulaCache(){ _formulaCache=new Map(); _formulaLabelIndex=null; }
function formulaLabelIndex(){
  if(_formulaLabelIndex) return _formulaLabelIndex;
  const idx=new Map();
  if(map && map.nodes){
    for(const id of Object.keys(map.nodes)){
      const n=map.nodes[id]; if(!n) continue;
      const key=(parseLabeledValue(nodeTextPlain(n.text||'')).label||'').trim().toLowerCase();
      const list=idx.get(key);
      if(list) list.push(id); else idx.set(key, [id]);
    }
  }
  _formulaLabelIndex=idx;
  return idx;
}
function computeNodeValue(nodeId, visiting){
  if(_formulaCache.has(nodeId)) return _formulaCache.get(nodeId);
  if(!visiting) visiting=new Set();
  if(visiting.has(nodeId)) return {error:rmsTr('fxErrCircular','Circular reference')};
  const n = map && map.nodes[nodeId];
  if(!n) return null;
  const plain = nodeTextPlain(n.text||'').trim();
  if(!plain.startsWith('=')){
    const num = parseLabeledValue(plain).value;
    _formulaCache.set(nodeId, num);
    return num;
  }
  const nextVisiting = new Set(visiting); nextVisiting.add(nodeId);
  const ctx = {
    children: () => childrenOf(nodeId).map(cid=>computeNodeValue(cid, nextVisiting)).filter(v=> typeof v==='number' && isFinite(v)),
    resolveRef: (label) => {
      const norm = s => (s||'').trim().toLowerCase();
      const target = norm(label);
      const tried=new Set();
      const tryList = (ids)=>{
        for(const cid of ids){
          if(tried.has(cid) || cid===nodeId) continue; tried.add(cid);
          const cn=map.nodes[cid]; if(!cn) continue;
          const cnPlain = nodeTextPlain(cn.text||'');
          if(norm(parseLabeledValue(cnPlain).label)===target){
            const v=computeNodeValue(cid, nextVisiting);
            return (v && typeof v==='object' && v.error) ? undefined : v;
          }
        }
        return undefined;
      };
      let v;
      if(n.parent!=null){ v=tryList(childrenOf(n.parent)); if(v!==undefined) return v; }
      v=tryList(childrenOf(nodeId)); if(v!==undefined) return v;
      v=tryList(formulaLabelIndex().get(target)||[]); if(v!==undefined) return v;
      return null;
    }
  };
  let result;
  try{ result = evalFormula(plain.slice(1), ctx); }
  catch(e){ result = { error: (e && e.message) || rmsTr('fxErrGeneric','Formula error') }; }
  _formulaCache.set(nodeId, result);
  return result;
}
// Formats a computed formula value for display in the node (e.g. trims float noise).
function formatFormulaResult(v){
  if(v==null) return '\u2014';
  if(typeof v==='object' && v.error) return '#ERROR';
  if(typeof v==='number'){
    if(!isFinite(v)) return '#ERROR';
    const rounded = Math.round(v*1e6)/1e6;
    return String(rounded);
  }
  return '\u2014';
}

// Strip HTML to plain text but keep newlines from <br> and block elements
function nodeTextPlain(text){
  if(!text) return '';
  if(!hasInlineMarkup(text)) return text;
  const tpl=document.createElement('template'); tpl.innerHTML=text;   // inert parse
  tpl.content.querySelectorAll('br').forEach(br=>br.replaceWith(document.createTextNode('\n')));
  return (tpl.content.textContent||'').replace(/\u00A0/g,' ').trim();
}
// Per-node ~Nt corner badge. Always off: the count sat on the card and
// read as debug chrome. Map-wide total in the toolbar still uses estimateTokens.
function shouldShowNodeTokenBadge(_tokens, _hasNotes){
  return false;
}
// While a canvas gesture is in progress, WKWebView paints a native text
// selection across every card the pointer crosses (sibling-drop hover is
// the usual trigger). Editing must keep selectable text.
function canvasGestureBlocksTextSelection(state){
  if(!state || state.editing) return false;
  return !!(state.dragNode || state.marquee || state.resizing || state.panning);
}
function isNodeDoubleClick(stamp, id, now, windowMs){
  if(!stamp || stamp.id==null || id==null) return false;
  const dt=now-stamp.t;
  const win=windowMs==null?450:windowMs;
  return stamp.id===id && dt>=0 && dt<=win;
}
function shouldStartNodeDrag(detail){
  return (detail|0)<2;
}
function shouldIgnoreTransientToolbarClick(detail, now, nodeDownAt, windowMs){
  if((detail|0)>=2) return true;
  const win=windowMs==null?450:windowMs;
  if(nodeDownAt && now-nodeDownAt>=0 && now-nodeDownAt<=win) return true;
  return false;
}
function clearCanvasTextSelection(){
  if(typeof pendingNodeTyping==='function' && pendingNodeTyping()) return;
  try{
    const s = typeof window!=='undefined' && window.getSelection && window.getSelection();
    if(s && s.rangeCount) s.removeAllRanges();
  }catch(_){}
}
function estimateTokens(text, notes){
  const tParts = nodeTextPlain(text||'');
  const nParts = notes ? (notes||'').replace(/<[^>]*>/g,' ').replace(/\s+/g,' ').trim() : '';
  const chars = tParts.length + nParts.length;
  if(chars === 0) return 0;
  return Math.max(1, Math.round(chars / 4));
}
// ===== Mermaid flowchart export =====
// Walk the tree and emit `parent --> child` edges plus node definitions.
// Renders natively in GitHub, GitLab, Notion, Obsidian, etc.
function buildMermaid(startId){
  const root = startId || map.rootId;
  const lines = ['flowchart TD'];
  // Stable short ids: n0, n1, … mapped from node ids
  const idMap = {}; let counter = 0;
  const mid = id => (idMap[id] || (idMap[id] = 'n' + (counter++)));
  // Escape text for a Mermaid node label inside ["..."]
  const label = id => {
    let t = nodeTextPlain(map.nodes[id].text) || ' ';
    t = t.replace(/\n+/g, ' ').replace(/"/g, '#quot;').trim();
    if(t.length > 80) t = t.slice(0, 77) + '…';
    return t;
  };
  const defined = new Set();
  const define = id => {
    if(defined.has(id)) return;
    defined.add(id);
    lines.push(`    ${mid(id)}["${label(id)}"]`);
  };
  const walk = id => {
    define(id);
    childrenOf(id).forEach(c => {
      define(c);
      lines.push(`    ${mid(id)} --> ${mid(c)}`);
      walk(c);
    });
  };
  walk(root);
  // Colour the root node to match the map accent
  const accent = (map.color || '#e0613a');
  lines.push(`    style ${mid(root)} fill:${accent},color:#fff,stroke:${accent}`);
  return lines.join('\n');
}
function exportMermaid(){
  if(!map) return;
  const startId = (sel && sel !== map.rootId) ? sel : map.rootId;
  const code = buildMermaid(startId);
  // Wrap in a fenced ```mermaid block so it pastes straight into Markdown
  const fenced = '```mermaid\n' + code + '\n```\n';
  if(navigator.clipboard?.writeText){
    navigator.clipboard.writeText(fenced).then(
      () => toast(rmsTr('tMermaidCopied','Mermaid diagram copied')),
      () => { download(new Blob([fenced],{type:'text/plain'}), (map.title||'mindmap')+'.mmd.md'); toast(rmsTr('tClipBlocked','Clipboard blocked — downloaded instead')); }
    );
  } else {
    download(new Blob([fenced],{type:'text/plain'}), (map.title||'mindmap')+'.mmd.md');
    toast(rmsTr('tMermaidDownloaded','Mermaid diagram downloaded'));
  }
}

// Build hierarchical Markdown bullets from the map. If `startId` is given,
// only that node's subtree is included — useful for "copy this branch as a prompt".
// Serialize a node's notes HTML back to Markdown blocks so code fences and tables
// round-trip: <pre> -> fenced code, <table> -> pipe table, else -> blockquote lines.
function _htmlTableToMdRows(tableEl){
  const rows=[...tableEl.querySelectorAll('tr')].map(tr=>[...tr.children].map(c=>htmlToInlineMd(c.innerHTML).replace(/\s*\n\s*/g,' ').trim()));
  if(!rows.length) return [];
  const ncol=Math.max(...rows.map(r=>r.length));
  const fill=r=>{ const c=r.slice(); while(c.length<ncol) c.push(''); return c; };
  const out=['| '+fill(rows[0]).join(' | ')+' |', '| '+Array(ncol).fill('---').join(' | ')+' |'];
  rows.slice(1).forEach(r=>out.push('| '+fill(r).join(' | ')+' |'));
  return out;
}
function notesToMdBlocks(notesHtml){
  const tpl=document.createElement('template'); tpl.innerHTML=notesHtml||'';
  const blocks=[];
  tpl.content.childNodes.forEach(ch=>{
    if(ch.nodeType===3){ ch.nodeValue.split('\n').forEach(l=>{ if(l.trim()) blocks.push({q:l.trim()}); }); return; }
    if(ch.nodeType!==1) return;
    const tag=ch.tagName.toLowerCase();
    if(tag==='pre') blocks.push({ code: ch.textContent.replace(/\n+$/,'') });
    else if(tag==='table') blocks.push({ table:_htmlTableToMdRows(ch) });
    else { htmlToInlineMd(ch.innerHTML).split('\n').forEach(l=>{ if(l.trim()) blocks.push({q:l.trim()}); }); }
  });
  return blocks;
}
function _nodeMeta(n){   // per-node info that JSON has but Markdown can't express
  const m={};
  // n.color is the node's BOX background (a shape property, not text styling) — no clean
  // inline-HTML equivalent, and reusing background-color here would collide with n.highlight
  // (a genuine text highlight) on reimport. Kept in meta.
  if(n.color) m.color=n.color;
  if(n.width) m.w=n.width;
  if(n.height) m.h=n.height;
  if(n.collapsed) m.collapsed=1;
  // textColor / underline / fontSize / highlight / align / image are intentionally NOT
  // stored here — they round-trip via visible HTML (<span style>, <u>, <mark>, <div
  // style>, <img>) in the text itself instead (see buildMarkdown / parseMarkdownOutline's
  // `add`), the same way bold/italic/strike already use visible **/*/~~ syntax.
  // (applyMeta below still reads these legacy meta fields for files exported before this.)
  if(n.ref) m.ref=1;
  if(n.citation) m.citation=n.citation;
  if(n.url) m.url=n.url;
  if(n.created) m.created=n.created;
  if(n.updated) m.updated=n.updated;
  return Object.keys(m).length? m : null;
}
function buildMarkdown(startId, opts){
  const rich = !!(opts && opts.rich);            // rich: keep formatting, tasks, links, images
  const withMeta = !!(opts && opts.meta);        // prepend a <!-- mindspark ... --> metadata comment
  const lineMap = (opts && opts.lineMap) || null;// filled: lineMap[lineIndex] = nodeId (node<->text sync)
  const root = startId || map.rootId;
  const lines=[];
  const nmeta={}, lm={};
  const baseDepth = 0;
  const notesText = n => (n.notes||'').replace(/<[^>]+>/g,'').replace(/&nbsp;/g,' ').trim();
  const emitNotes = (n, pad) => {   // rich: code fences / tables round-trip; other notes -> blockquotes
    if(!(n.notes||'').trim()) return;
    notesToMdBlocks(n.notes).forEach(b=>{
      if(b.code!=null){ lines.push('```'); b.code.split('\n').forEach(l=>lines.push(l)); lines.push('```'); }
      else if(b.table){ b.table.forEach(l=>lines.push(l)); }
      else lines.push(pad+'> '+b.q);
    });
  };
  const walk=(id, bd, path)=>{
    const n=map.nodes[id];
    if(!n) return;
    if(n.frontmatter) return;   // emitted separately as YAML frontmatter at the very top instead — never inline
    if(withMeta){ const mm=_nodeMeta(n); if(mm) nmeta[path]=mm; }
    const pad='  '.repeat(bd);
    if(n.hr){ if(lineMap) lm[lines.length]=id; lines.push(pad+'---'); return; }   // divider round-trips as ---
    if(n.html){   // block node (table / code / raw HTML) at the current bullet indent
      if(lineMap) lm[lines.length]=id;
      if(n.raw){ n.html.split('\n').forEach(l=>lines.push(l.trim()?pad+l:l)); return; }
      const lang=(rich && n.lang) ? n.lang : '';
      notesToMdBlocks(n.html).forEach(b=>{
        if(b.code!=null){ lines.push(pad+'```'+lang); b.code.split('\n').forEach(l=>lines.push(pad+l)); lines.push(pad+'```'); }
        else if(b.table){ b.table.forEach(l=>lines.push(pad+l)); }
        else lines.push(pad+'> '+b.q);
      });
      return;
    }
    let body = (rich ? htmlToInlineMd(n.text) : nodeTextPlain(n.text)) || 'Untitled';
    const wrapStyle = s => {   // whole-node style toggles (nodebar buttons) get real Markdown/HTML syntax, not just metadata
      if(!rich) return s;
      if(n.strike) s='~~'+s+'~~';
      if(n.italic) s='*'+s+'*';
      if(n.bold) s='**'+s+'**';
      if(n.underline) s='<u>'+s+'</u>';
      if(n.highlight) s=`<mark style="background-color:${n.highlight}">${s}</mark>`;
      if(n.textColor) s=`<span style="color:${n.textColor}">${s}</span>`;
      if(n.fontSize) s=`<span style="font-size:${n.fontSize}px">${s}</span>`;
      if(n.align && n.align!=='center') s=`<div style="text-align:${n.align}">${s}</div>`;   // 'center' is the render-time default (see renderNodeText) — skip for brevity
      return s;
    };
    // A non-http(s) image (pasted/uploaded — stored as a data: URI) has no Markdown image
    // syntax that can hold it, so it round-trips as a literal <img> tag instead of silently
    // living only in the meta comment; a plain http(s) image keeps using ![image](url).
    const imageLine = () => {
      if(!(rich && n.image)) return null;
      if(/^https?:\/\//i.test(n.image)) return `![${n.imageAlt||'image'}](${n.image})`;
      const src = nodeImageSrc(n);
      return `<img src="${src}"${n.imageAlt ? ' alt="'+escapeHtml(n.imageAlt)+'"' : ''}>`;
    };
    let first;
    if(rich && n.listType){
      // A bulleted/numbered node (multiple lines living inside ONE node) has no plain-
      // Markdown equivalent — a bare "- line" is indistinguishable from a new sibling
      // node. <ul>/<ol>/<li> are already in the sanitizer's inline-HTML whitelist (see
      // SAFE_TAGS/INLINE_HTML_RE), so use them directly: visible/readable as real HTML in
      // the Markdown text, and it round-trips as a single line/node — parseMarkdownOutline
      // unwraps this same shape straight back into listType + <br>-joined text. Whole-node
      // style toggles are applied per <li> (not around the whole wrapper) so the outer tag
      // always literally starts with <ul>/<ol> for the importer to recognize.
      const tag = n.listType==='ol' ? 'ol' : 'ul';
      first = `<${tag}>` + body.split('\n').map(l=>`<li>${wrapStyle(l||'<br>')}</li>`).join('') + `</${tag}>`;
    } else {
      first = wrapStyle(body.replace(/\n+/g, rich ? '<br>' : ' '));   // keep multi-line text in ONE node
    }
    const hlevel = (id===root) ? 1 : ((rich && n.hlevel) ? n.hlevel : 0);   // imported headings re-emit as #/##/###
    if(hlevel){
      if(lines.length && lines[lines.length-1]!=='') lines.push('');
      if(lineMap) lm[lines.length]=id;   // record AFTER the spacer line, so it points at the heading text itself
      lines.push('#'.repeat(hlevel)+' '+first);
      if(rich){ emitNotes(n, ''); } else { const nt=notesText(n); if(nt) lines.push('', nt); }
      const il = imageLine(); if(il) lines.push(il);
      lines.push('');
      childrenOf(id).forEach((c,i)=>walk(c, 0, path+'.'+i));       // heading's children start a fresh bullet indent
    } else {
      if(lineMap) lm[lines.length]=id;
      const box = (rich && n.task) ? (n.task==='done' ? '[x] ' : '[ ] ') : '';
      const isPara = rich && n.para && !n.task;                 // keep plain paragraphs plain (no bullet)
      lines.push(isPara ? `${pad}${first}` : `${pad}- ${box}${first}`);
      const notePad = isPara ? pad : `${pad}  `;
      if(rich){ emitNotes(n, notePad); } else { const nt=notesText(n); if(nt) nt.split('\n').forEach(l=>lines.push(`${notePad}> ${l}`)); }
      const il = imageLine(); if(il) lines.push(`${notePad}${il}`);
      childrenOf(id).forEach((c,i)=>walk(c, bd+1, path+'.'+i));
    }
  };
  // A frontmatter child of root (Claude Skill name/description, etc.) is emitted as real
  // YAML --- frontmatter --- at the very top of the file, not as inline content.
  let frontmatterYaml = null, frontmatterNodeId=null;
  { const fmChild = childrenOf(root).find(cid => map.nodes[cid] && map.nodes[cid].frontmatter);
    if(fmChild){ frontmatterNodeId=fmChild; frontmatterYaml = frontmatterNodeToYaml(map.nodes[fmChild]); }
  }
  walk(root, 0, '0');
  let out=lines, shift=0; const prefix=[];
  if(withMeta){
    const meta={ v:1 };
    if(map.layout) meta.layout=map.layout;
    if(map.color) meta.color=map.color;
    if(map.vars && Object.keys(map.vars).length) meta.vars=map.vars;
    if(Object.keys(nmeta).length) meta.nodes=nmeta;
    if(Object.keys(meta).length>1){ prefix.push('<!-- mindspark', JSON.stringify(meta), '-->', ''); }
  }
  const frontmatterStart=prefix.length;
  if(frontmatterYaml){ frontmatterYaml.split('\n').forEach(l=>prefix.push(l)); prefix.push(''); }
  else if(rich && map.frontmatter){ map.frontmatter.split('\n').forEach(l=>prefix.push(l)); prefix.push(''); }   // legacy fallback
  if(prefix.length){ out=prefix.concat(lines); shift=prefix.length; }
  if(lineMap){ lineMap.length=0; for(const k in lm) lineMap[+k+shift]=lm[k]; if(frontmatterNodeId) lineMap[frontmatterStart]=frontmatterNodeId; }
  return out.join('\n');
}

// === Variable / placeholder detection ============================================
// Recognise {{name}} and ${name} in node text + notes. Names can include letters,
// numbers, underscores, hyphens, dots, and spaces.
const VAR_RE = /\{\{\s*([\w.\- ]+?)\s*\}\}|\$\{\s*([\w.\- ]+?)\s*\}/g;
function findVariables(startId){
  const root = startId || map.rootId;
  const seen = new Set();
  const order = [];
  const visit = text => {
    if(!text) return;
    const plain = nodeTextPlain(text);
    VAR_RE.lastIndex = 0;
    let m; while((m = VAR_RE.exec(plain)) !== null){
      const name = (m[1] || m[2] || '').trim();
      if(name && !seen.has(name)){ seen.add(name); order.push(name); }
    }
  };
  const walk = id => {
    const n = map.nodes[id]; if(!n) return;
    visit(n.text);
    if(n.notes) visit((n.notes||'').replace(/<[^>]+>/g,' '));
    childrenOf(id).forEach(walk);
  };
  walk(root);
  return order;
}
// Replace {{var}} and ${var} occurrences inside `text` using the values map.
function substituteVariables(text, values){
  if(!text) return text;
  return text.replace(VAR_RE, (m, a, b) => {
    const name = (a || b || '').trim();
    return Object.prototype.hasOwnProperty.call(values, name) ? values[name] : m;
  });
}

// Build a clean prompt text — hierarchical headings, no markdown syntax noise,
// notes inlined. Optionally substitutes filled variable values.
function buildPrompt(startId, values){
  const root = startId || map.rootId;
  const out = [];
  const sub = t => values ? substituteVariables(t, values) : t;
  const walk = (id, depth) => {
    const n = map.nodes[id]; if(!n) return;
    const text = sub(nodeTextPlain(n.text) || 'Untitled');
    const notes = sub(((n.notes||'').replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim()));
    if(depth === 0){
      out.push(text);
      if(notes) out.push('', notes);
      out.push('');
    } else if(depth === 1){
      // Top-level branches become section headers
      out.push('');
      out.push(text);
      out.push('-'.repeat(Math.min(text.length, 40)));
      if(notes) out.push(notes);
    } else {
      const indent = '  '.repeat(depth - 1);
      out.push(`${indent}${text}`);
      if(notes) out.push(`${indent}  (${notes})`);
    }
    childrenOf(id).forEach(c => walk(c, depth + 1));
  };
  walk(root, 0);
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

/* ---------- In-page dialogs ----------
   WKWebView has no UI delegate for window.confirm/prompt/alert, so those
   return false/null silently. These themed modals replace them and resolve a
   Promise: rmsConfirm → true/false, rmsPrompt → string/null, rmsAlert → undefined.
   They use .var-form, so the canvas keydown handler already treats them as modal. */
function rmsDialog(message, opts){
  const o=opts||{};
  const kind=o.kind||'confirm';                 // 'confirm' | 'prompt' | 'alert'
  return new Promise(resolve=>{
    const prevFocus=document.activeElement;
    const m=document.createElement('div');
    m.className='var-form rms-dialog';
    m.setAttribute('role', kind==='alert' ? 'alertdialog' : 'dialog');
    m.setAttribute('aria-modal','true');
    m.innerHTML=`
      <div class="vf-backdrop"></div>
      <div class="vf-card">
        <p class="vf-sub rms-dialog-msg"></p>
        ${kind==='prompt' ? '<div class="vf-fields"><input class="vf-input rms-dialog-input" type="text" spellcheck="false"></div>' : ''}
        <div class="vf-actions">
          ${kind==='alert' ? '' : '<button class="vf-cancel"></button>'}
          <button class="vf-go primary${o.danger ? ' danger' : ''}"></button>
        </div>
      </div>`;
    m.querySelector('.rms-dialog-msg').textContent=String(message==null ? '' : message);
    const okBtn=m.querySelector('.vf-go');
    const cancelBtn=m.querySelector('.vf-cancel');
    const input=m.querySelector('.rms-dialog-input');
    okBtn.textContent=o.okLabel || rmsTr('ok','OK');
    if(cancelBtn) cancelBtn.textContent=o.cancelLabel || rmsTr('cancel','Cancel');
    if(input) input.value=o.defaultValue==null ? '' : String(o.defaultValue);
    let done=false;
    const finish=value=>{
      if(done) return;
      done=true;
      m.remove();
      try{ if(prevFocus && prevFocus.isConnected && prevFocus.focus) prevFocus.focus({preventScroll:true}); }catch(_){}
      resolve(value);
    };
    const ok=()=>finish(kind==='prompt' ? input.value : (kind==='alert' ? undefined : true));
    const cancel=()=>finish(kind==='prompt' ? null : (kind==='alert' ? undefined : false));
    okBtn.onclick=ok;
    if(cancelBtn) cancelBtn.onclick=cancel;
    m.querySelector('.vf-backdrop').onclick=cancel;
    // Nothing inside may reach the canvas (mousedown clears selection,
    // keydown would edit the map underneath).
    m.addEventListener('mousedown',e=>e.stopPropagation());
    m.addEventListener('click',e=>e.stopPropagation());
    m.addEventListener('keydown',e=>{
      e.stopPropagation();
      if(isImeEvent(e)) return;
      if(e.key==='Escape'){ e.preventDefault(); cancel(); }
      else if(e.key==='Enter' && !e.shiftKey && !e.altKey){
        e.preventDefault();
        if(e.target===cancelBtn) cancel(); else ok();
      }
      else if(e.key==='Tab'){
        // Keep focus inside the dialog.
        const f=[input, cancelBtn, okBtn].filter(Boolean);
        const i=f.indexOf(document.activeElement);
        e.preventDefault();
        f[(i + (e.shiftKey ? f.length-1 : 1)) % f.length].focus();
      }
    });
    document.body.appendChild(m);
    if(input){ input.focus(); input.select(); } else okBtn.focus();
  });
}
function rmsConfirm(message, opts){ return rmsDialog(message, { ...(opts||{}), kind:'confirm' }); }
function rmsPrompt(message, defaultValue){ return rmsDialog(message, { kind:'prompt', defaultValue }); }
function rmsAlert(message){ return rmsDialog(message, { kind:'alert' }); }

// Show a small modal listing each detected variable with an input field.
// On submit, calls `done(values)` with the user-entered substitutions.
function showVariableForm(varNames, defaults, mapId, done){
  document.querySelectorAll('.var-form').forEach(p => p.remove());
  const m = document.createElement('div');
  m.className = 'var-form';
  m.innerHTML = `
    <div class="vf-backdrop"></div>
    <div class="vf-card">
      <button class="vf-close" aria-label="${rmsTh('close','Close')}">×</button>
      <h2>${rmsTh('vfTitle','Fill variables')}</h2>
      <p class="vf-sub">${escapeHtml(varNames.length===1 ? rmsTr('vfSubOne','Found 1 placeholder — fill it before exporting the prompt.') : rmsTf('vfSubN','Found %s placeholders — fill them before exporting the prompt.', varNames.length))}</p>
      <div class="vf-fields">
        ${varNames.map(name => `
          <label class="vf-row">
            <span class="vf-name"><code>${escapeHtml(name)}</code></span>
            <textarea class="vf-input" data-name="${escapeHtml(name)}" rows="1" placeholder="${escapeHtml(rmsTf('vfValueFor','value for %s', name))}">${escapeHtml(defaults[name] || '')}</textarea>
          </label>`).join('')}
      </div>
      <div class="vf-actions">
        <button class="vf-skip">${rmsTh('vfSkip','Skip / use raw')}</button>
        <button class="vf-cancel">${rmsTh('cancel','Cancel')}</button>
        <button class="vf-go primary">${rmsTh('vfExport','Export')}</button>
      </div>
    </div>`;
  document.body.appendChild(m);
  m.addEventListener('mousedown', e => e.stopPropagation());
  // Auto-grow textareas as the user types
  m.querySelectorAll('.vf-input').forEach(ta => {
    const grow = () => { ta.style.height='auto'; ta.style.height=Math.min(ta.scrollHeight, 140)+'px'; };
    ta.addEventListener('input', grow); grow();
  });
  m.querySelector('.vf-input')?.focus();
  const close = () => m.remove();
  const collect = () => {
    const out = {};
    // Skip blank fields: an empty value would otherwise replace the placeholder with
    // nothing and be remembered as if the user had chosen "".
    m.querySelectorAll('.vf-input').forEach(ta => { if(ta.value.trim() !== '') out[ta.dataset.name] = ta.value; });
    // Remember per-map for next time
    try { localStorage.setItem('mindspark:vars:'+mapId, JSON.stringify(out)); } catch(e){}
    return out;
  };
  m.querySelector('.vf-go').onclick     = () => { const v = collect(); close(); done(v); };
  m.querySelector('.vf-skip').onclick   = () => { close(); done(null); };  // null = no substitution
  m.querySelector('.vf-cancel').onclick = close;
  m.querySelector('.vf-close').onclick  = close;
  m.querySelector('.vf-backdrop').onclick = close;
  m.addEventListener('keydown', e => {
    if(e.key==='Escape'){ e.preventDefault(); close(); }
    if(e.key==='Enter' && (e.ctrlKey||e.metaKey)){ e.preventDefault(); m.querySelector('.vf-go').click(); }
  });
}

// Top-level "Export as prompt" — detects variables, shows the form when any are
// present, then builds the prompt text and copies it to the clipboard.
function exportAsPrompt(){
  if(!map) return;
  const startId = (sel && sel !== map.rootId) ? sel : map.rootId;
  const vars = findVariables(startId);
  const finish = (values) => {
    const text = buildPrompt(startId, values);
    if(navigator.clipboard?.writeText){
      navigator.clipboard.writeText(text).then(
        () => toast(rmsTf('tPromptCopiedChars','Prompt copied (%s chars)', text.length)),
        () => { download(new Blob([text],{type:'text/plain'}), (map.title||'prompt')+'.txt'); toast(rmsTr('tClipBlocked','Clipboard blocked — downloaded instead')); }
      );
    } else {
      download(new Blob([text],{type:'text/plain'}), (map.title||'prompt')+'.txt');
      toast(rmsTr('tPromptDownloaded','Prompt downloaded'));
    }
  };
  if(vars.length === 0){
    finish(null);
    return;
  }
  // Build defaults: values remembered from the last export form (localStorage) first,
  // then the map-level variables on top — map.vars is what the Variables panel edits,
  // so a stale remembered value must never override it. Empty strings don't count.
  const nonEmpty = o => {
    const out = {};
    if(o && typeof o === 'object') Object.keys(o).forEach(k => { if(o[k] != null && String(o[k]).trim() !== '') out[k] = o[k]; });
    return out;
  };
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem('mindspark:vars:'+map.id) || '{}'); } catch(e){}
  const defaults = { ...nonEmpty(saved), ...nonEmpty(map.vars) };
  // If every detected variable already has a non-empty map-level default, skip the
  // form entirely and export straight away — that's the whole point of map vars.
  const allCovered = vars.every(v => (map.vars||{})[v] != null && String((map.vars||{})[v]).trim() !== '');
  if(allCovered){
    finish(defaults);
    toast(rmsTr('tUsedVars','Used saved map variables'));
    return;
  }
  showVariableForm(vars, defaults, map.id, (values) => {
    finish(values);
  });
}

// ===== Map-level variables panel =====
// Lets the user set default values for every {{placeholder}} / ${placeholder}
// in the map, stored on map.vars so future prompt exports reuse them.
function showMapVariables(){
  if(!map) return;
  document.querySelectorAll('.var-form').forEach(p => p.remove());
  const vars = findVariables(map.rootId);
  const cur = map.vars || {};
  const m = document.createElement('div');
  m.className = 'var-form';
  if(vars.length === 0){
    m.innerHTML = `
      <div class="vf-backdrop"></div>
      <div class="vf-card">
        <button class="vf-close" aria-label="${rmsTh('close','Close')}">×</button>
        <h2>${rmsTh('mvTitle','Map variables')}</h2>
        <p class="vf-sub">${rmsTr('mvEmptyHtml','No placeholders found yet. Use <code>{{name}}</code> or <code>${name}</code> anywhere in your node text, then set their default values here so every prompt export fills them automatically.')}</p>
        <div class="vf-actions"><button class="vf-cancel">${rmsTh('close','Close')}</button></div>
      </div>`;
    document.body.appendChild(m);
    m.addEventListener('mousedown', e => e.stopPropagation());
    const close=()=>m.remove();
    m.querySelector('.vf-close').onclick=close;
    m.querySelector('.vf-cancel').onclick=close;
    m.querySelector('.vf-backdrop').onclick=close;
    return;
  }
  m.innerHTML = `
    <div class="vf-backdrop"></div>
    <div class="vf-card">
      <button class="vf-close" aria-label="${rmsTh('close','Close')}">×</button>
      <h2>${rmsTh('mvTitle','Map variables')}</h2>
      <p class="vf-sub">${escapeHtml(rmsTf('mvSub','Set default values for the %s placeholder(s) in this map. Prompt exports will reuse these without asking — leave one blank to be prompted at export time.', vars.length))}</p>
      <div class="vf-fields">
        ${vars.map(name => `
          <label class="vf-row">
            <span class="vf-name"><code>${escapeHtml(name)}</code></span>
            <textarea class="vf-input" data-name="${escapeHtml(name)}" rows="1" placeholder="${escapeHtml(rmsTf('mvDefaultFor','default for %s', name))}">${escapeHtml(cur[name] || '')}</textarea>
          </label>`).join('')}
      </div>
      <div class="vf-actions">
        <button class="vf-clear">${rmsTh('mvClear','Clear all')}</button>
        <button class="vf-cancel">${rmsTh('cancel','Cancel')}</button>
        <button class="vf-go primary">${rmsTh('mvSave','Save defaults')}</button>
      </div>
    </div>`;
  document.body.appendChild(m);
  m.addEventListener('mousedown', e => e.stopPropagation());
  m.querySelectorAll('.vf-input').forEach(ta => {
    const grow = () => { ta.style.height='auto'; ta.style.height=Math.min(ta.scrollHeight,140)+'px'; };
    ta.addEventListener('input', grow); grow();
  });
  m.querySelector('.vf-input')?.focus();
  const close=()=>m.remove();
  m.querySelector('.vf-go').onclick = () => {
    const out = {};
    m.querySelectorAll('.vf-input').forEach(ta => { if(ta.value.trim()!=='') out[ta.dataset.name]=ta.value; });
    map.vars = out;
    pushHistory(); scheduleSave();
    close();
    toast(rmsTr('tVarsSaved','Map variables saved'));
  };
  m.querySelector('.vf-clear').onclick = () => { m.querySelectorAll('.vf-input').forEach(ta=>{ta.value='';ta.dispatchEvent(new Event('input'));}); };
  m.querySelector('.vf-cancel').onclick = close;
  m.querySelector('.vf-close').onclick = close;
  m.querySelector('.vf-backdrop').onclick = close;
  m.addEventListener('keydown', e => {
    if(e.key==='Escape'){ e.preventDefault(); close(); }
    if(e.key==='Enter' && (e.ctrlKey||e.metaKey)){ e.preventDefault(); m.querySelector('.vf-go').click(); }
  });
}
function exportMarkdown(toClipboard, rich){
  if(!map) return;
  // If a non-root node is selected, export *that branch* — perfect for
  // pulling out a single prompt or section from a larger map.
  const startId = (sel && sel !== map.rootId) ? sel : map.rootId;
  const md = buildMarkdown(startId, {rich:!!rich, meta:!!rich});
  const scope = startId === map.rootId ? '' : rmsTr('tScopeBranch',' (selected branch)');
  if(toClipboard){
    if(navigator.clipboard?.writeText){
      navigator.clipboard.writeText(md).then(
        ()=>toast(rmsTr('tCopiedClip','Copied to clipboard')+scope),
        ()=>{ download(new Blob([md],{type:'text/markdown'}),(map.title||'mindmap')+'.md'); toast(rmsTr('tClipBlocked','Clipboard blocked — downloaded instead')); }
      );
    } else {
      download(new Blob([md],{type:'text/markdown'}),(map.title||'mindmap')+'.md');
      toast(rmsTr('tClipUnavailable','Clipboard unavailable — downloaded'));
    }
  } else {
    const name = startId === map.rootId ? map.title : nodeTextPlain(map.nodes[startId]?.text);
    download(new Blob([md],{type:'text/markdown'}), (name||'mindmap')+'.md');
    toast(rmsTr('tMdExported','Markdown exported')+scope);
  }
}
// Build a Word-compatible HTML document (saved with .doc extension —
// Word, Google Docs, and LibreOffice all open this as a Word document).
// Renders one LaTeX expression to a small PNG data-URL <img> tag, for exports that
// can't render MathML/OMML natively (the HTML-based .doc export opens in Word,
// Google Docs, and LibreOffice, none of which reliably render raw MathML pasted in
// via a file — but all three display an embedded image just fine). Reuses the same
// canvas math-layout engine (_layoutMath) the PNG exporter already relies on,
// scoped to a single expression instead of a full node.
function mathToImgTag(tex, fontPx, color){
  fontPx = fontPx || 16; color = color || '#23201b';
  try{
    const t=document.createElement('span'); t.innerHTML=latexToMathML(tex,false);
    const mathEl=t.querySelector('math'); if(!mathEl) return null;
    const measureCv=document.createElement('canvas'); const mctx=measureCv.getContext('2d');
    const lay=_layoutMath(mctx, mathEl, fontPx, 'serif', color);
    const scale=3, pad=2;   // render at higher pixel density so it stays crisp at normal document zoom
    const w=Math.max(1,Math.ceil(lay.w+pad*2)), h=Math.max(1,Math.ceil(lay.asc+lay.desc+pad*2));
    const cv=document.createElement('canvas'); cv.width=w*scale; cv.height=h*scale;
    const ctx=cv.getContext('2d'); ctx.scale(scale,scale);
    // The layout's draw closures are bound to the context it was built with, so
    // lay.draw() would paint onto the throwaway measuring canvas and leave `cv`
    // blank. Lay out again against the real output context and draw that.
    _layoutMath(ctx, mathEl, fontPx, 'serif', color).draw(pad, pad+lay.asc);
    // CSS height stays at the UNSCALED size — scale only adds pixel density, not display size.
    return `<img src="${cv.toDataURL('image/png')}" style="vertical-align:middle;height:${h}px" alt="${escapeHtml(tex)}">`;
  }catch(e){ return null; }
}
// Splits `text` around $...$/$$...$$ math segments, running each surrounding plain-
// text chunk through the normal escapeHtml/sanitizeInlineHTML path and replacing
// each math segment with its rendered image — rather than running the whole string
// through the escaper first, which would mangle the <img> markup this injects.
// Returns null (falls back to the caller's normal path) if there's no math at all,
// so the common case is untouched.
function renderMathForExport(text, fontPx, color){
  text = text || '';
  if(!containsMath(text)) return null;
  const re=new RegExp(MATH_DELIM_RE.source,'g');
  const plain = s => INLINE_HTML_RE.test(s) ? sanitizeInlineHTML(s) : escapeHtml(s).replace(/\n/g,'<br>');
  let out='', last=0, m;
  while((m=re.exec(text))){
    out += plain(text.slice(last,m.index));
    const tex=m[1]!=null?m[1]:m[2];
    out += mathToImgTag(tex, fontPx, color) || escapeHtml(m[0]);   // literal text if rendering ever fails
    last=m.index+m[0].length;
  }
  out += plain(text.slice(last));
  return out;
}
function imageSrcNeedsInline(src){
  if(!src) return false;
  if(/^(data:|https?:|\/\/)/i.test(src)) return false;
  return true;
}
function blobToDataUrl(blob){
  return new Promise((resolve, reject)=>{
    if(typeof FileReader!=='function'){ reject(new Error('no FileReader')); return; }
    const fr = new FileReader();
    fr.onload = ()=>resolve(String(fr.result||''));
    fr.onerror = ()=>reject(fr.error||new Error('read failed'));
    fr.readAsDataURL(blob);
  });
}
async function inlineNodeImageSrc(n, mapObj){
  const src = nodeImageSrc(n, mapObj);
  if(!src || !imageSrcNeedsInline(src)) return src;
  if(typeof fetch!=='function') return src;
  try{
    const r = await fetch(src);
    if(!r.ok) return src;
    const blob = await r.blob();
    return await blobToDataUrl(blob);
  }catch(_){ return src; }
}
async function inlineAllMapImages(){
  const out = {};
  if(!map || !map.nodes) return out;
  await Promise.all(Object.keys(map.nodes).map(async id=>{
    const n = map.nodes[id];
    if(!n || !n.image) return;
    out[id] = await inlineNodeImageSrc(n);
  }));
  return out;
}
function buildDoc(inlined){
  const title = (map.title || 'Mind Map').replace(/[<>]/g,'');
  const imgSrc = n => (inlined && n && inlined[n.id]) || nodeImageSrc(n);
  let body = `<h1>${escapeHtml(title)}</h1>`;
  // Root's image, if any
  const rootN = map.nodes[map.rootId];
  if(rootN && rootN.image){ body += `<img src="${imgSrc(rootN)}" alt="${escapeHtml(rootN.imageAlt||'attachment')}" style="max-width:320px;max-height:220px;display:block;margin-bottom:10px;border-radius:8px">`; }
  // Add root's notes under the title
  const rn = rootN?.notes;
  if(rn){ body += `<p><em>${renderMathForExport(rn, 13, '#6a6258') ?? sanitizeInlineHTML(rn)}</em></p>`; }
  // Render children as nested <ul>
  const renderChildren = (parentId, depth)=>{
    const cs = childrenOf(parentId);
    if(!cs.length) return '';
    let out = `<ul>`;
    cs.forEach(cid=>{
      const n = map.nodes[cid];
      const txt = renderMathForExport(n.text||'', 15, '#23201b')
        ?? (INLINE_HTML_RE.test(n.text||'') ? sanitizeInlineHTML(n.text) : escapeHtml(n.text||'').replace(/\n/g,'<br>'));
      const taskMark = n.task ? (n.task==='done' ? '\u2611\uFE0F ' : n.task==='doing' ? '\u25D0 ' : '\u2610 ') : '';
      out += `<li>`;
      if(n.image) out += `<img src="${imgSrc(n)}" alt="${escapeHtml(n.imageAlt||'attachment')}" style="max-width:280px;max-height:200px;display:block;margin-bottom:4px;border-radius:6px"><br>`;
      out += `${taskMark}${n.task==='done'?`<span style="text-decoration:line-through;opacity:.65">${txt}</span>`:txt}`;
      if(n.notes){ out += `<br><em style="color:#666">${renderMathForExport(n.notes, 13, '#6a6258') ?? sanitizeInlineHTML(n.notes)}</em>`; }
      out += renderChildren(cid, depth+1);
      out += `</li>`;
    });
    out += `</ul>`;
    return out;
  };
  body += renderChildren(map.rootId, 1);

  // Word-friendly HTML document with proper MIME hints
  return `<!DOCTYPE html>
<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40">
<head>
<meta charset="utf-8" />
<title>${escapeHtml(title)}</title>
<style>
  body{font-family:"PingFang SC",Calibri,"Segoe UI",Arial,sans-serif;color:#23201b;line-height:1.55;max-width:780px;margin:24px auto;padding:0 24px}
  h1{font-family:"PingFang SC",Cambria,Georgia,serif;color:#e0613a;margin:0 0 18px;font-size:26pt}
  ul{margin:6px 0 6px 24px;padding-left:18px}
  li{margin:4px 0}
  em{font-style:italic;color:#6a6258}
  a{color:#3a6ea5}
</style>
</head>
<body>${body}</body>
</html>`;
}
async function exportDoc(){
  if(!map) return;
  const inlined = await inlineAllMapImages();
  const html = buildDoc(inlined);
  // .doc extension + msword MIME → Word, Google Docs, LibreOffice all open it
  const filename = (map.title||'mindmap')+'.doc';
  const blob = new Blob(['\ufeff', html], {type:'application/msword'});
  download(blob, filename);
  toast(rmsTr('tWordExported','Word document exported'));
}
// --- Canvas math rendering (for PNG export) --------------------------------
// A small layout engine that draws the MathML subset produced by latexToMathML
// onto a 2D canvas (sub/superscripts, fractions, roots, accents). Used by the
// PNG exporter so equations render properly instead of showing raw LaTeX source.
function _layoutMath(ctx, el, fontPx, family, color){
  const ASC=fontPx*0.72, DESC=fontPx*0.24;
  const textBox=(str, italic)=>{
    let f=(italic?'italic ':'')+fontPx+'px '+family;
    ctx.font=f; const w=ctx.measureText(str).width;
    return { w, asc:ASC, desc:DESC, draw:(x,base)=>{ ctx.save(); ctx.font=f; ctx.fillStyle=color; ctx.textBaseline='alphabetic'; ctx.textAlign='left'; ctx.fillText(str,x,base); ctx.restore(); } };
  };
  if(el.nodeType===3) return textBox(el.nodeValue||'', false);
  const tag=(el.tagName||'').toLowerCase();
  const kids=Array.from(el.childNodes);
  const seq=()=>{
    const parts=kids.map(k=>_layoutMath(ctx,k,fontPx,family,color));
    const w=parts.reduce((s,p)=>s+p.w,0);
    const asc=Math.max(ASC,...parts.map(p=>p.asc),0);
    const desc=Math.max(DESC,...parts.map(p=>p.desc),0);
    return { w, asc, desc, draw:(x,base)=>{ let cx=x; parts.forEach(p=>{ p.draw(cx,base); cx+=p.w; }); } };
  };
  if(tag==='math'||tag==='mrow'||tag==='mstyle'||tag==='') return seq();
  if(tag==='mi'){ const t=el.textContent||''; return textBox(t, t.length===1 && /[a-zA-Z]/.test(t)); }
  if(tag==='mn'||tag==='mo'||tag==='mtext') return textBox(el.textContent||'', false);
  if(tag==='mspace'){ const em=parseFloat(el.getAttribute('width')||'0')||0; return { w:em*fontPx, asc:0, desc:0, draw:()=>{} }; }
  if(tag==='msup'||tag==='msub'||tag==='msubsup'){
    const base=_layoutMath(ctx,kids[0],fontPx,family,color);
    const sf=fontPx*0.72;
    let sup=null, sub=null;
    if(tag==='msup') sup=_layoutMath(ctx,kids[1],sf,family,color);
    else if(tag==='msub') sub=_layoutMath(ctx,kids[1],sf,family,color);
    else { sub=_layoutMath(ctx,kids[1],sf,family,color); sup=_layoutMath(ctx,kids[2],sf,family,color); }
    const supRise=fontPx*0.40, subDrop=fontPx*0.20;
    const sw=Math.max(sup?sup.w:0, sub?sub.w:0);
    return { w:base.w+sw+fontPx*0.04,
      asc:Math.max(base.asc, supRise+(sup?sup.asc:0)),
      desc:Math.max(base.desc, subDrop+(sub?sub.desc:0)),
      draw:(x,b)=>{ base.draw(x,b); const sx=x+base.w; if(sup) sup.draw(sx,b-supRise); if(sub) sub.draw(sx,b+subDrop+sf*0.5); } };
  }
  if(tag==='mfrac'){
    const num=_layoutMath(ctx,kids[0],fontPx*0.92,family,color);
    const den=_layoutMath(ctx,kids[1],fontPx*0.92,family,color);
    const pad=fontPx*0.18, gap=fontPx*0.18;
    const w=Math.max(num.w,den.w)+pad*2;
    const line=el.getAttribute('linethickness');
    return { w, asc:num.asc+num.desc+gap+fontPx*0.28, desc:den.asc+den.desc+gap-fontPx*0.28,
      draw:(x,b)=>{ const midY=b-fontPx*0.28;
        num.draw(x+(w-num.w)/2, midY-gap-num.desc);
        den.draw(x+(w-den.w)/2, midY+gap+den.asc);
        if(line!=='0'){ ctx.save(); ctx.strokeStyle=color; ctx.lineWidth=Math.max(1,fontPx*0.05); ctx.beginPath(); ctx.moveTo(x+pad*0.5,midY); ctx.lineTo(x+w-pad*0.5,midY); ctx.stroke(); ctx.restore(); } } };
  }
  if(tag==='msqrt'||tag==='mroot'){
    const content=_layoutMath(ctx,kids[0],fontPx,family,color);
    const lead=fontPx*0.62;
    return { w:content.w+lead+fontPx*0.2, asc:content.asc+fontPx*0.12, desc:content.desc,
      draw:(x,b)=>{ ctx.save(); ctx.strokeStyle=color; ctx.lineWidth=Math.max(1,fontPx*0.06); ctx.beginPath();
        const top=b-(content.asc+fontPx*0.12), bot=b+content.desc*0.4;
        ctx.moveTo(x,b); ctx.lineTo(x+lead*0.4,bot); ctx.lineTo(x+lead*0.7,top); ctx.lineTo(x+content.w+lead+fontPx*0.2,top); ctx.stroke(); ctx.restore();
        content.draw(x+lead,b); } };
  }
  if(tag==='mover'){
    const base=_layoutMath(ctx,kids[0],fontPx,family,color);
    const acc=_layoutMath(ctx,kids[1],fontPx*0.8,family,color);
    return { w:Math.max(base.w,acc.w), asc:base.asc+fontPx*0.28, desc:base.desc,
      draw:(x,b)=>{ base.draw(x,b); acc.draw(x+(base.w-acc.w)/2, b-base.asc-fontPx*0.05); } };
  }
  if(kids.length) return seq();
  return textBox(el.textContent||'', false);
}
// Draw a node's text that contains $...$ math. Lines split on \n; each line is a
// row of plain-text and math segments laid out horizontally, block centered on cy.
function drawNodeMath(ctx, text, o){
  const family=o.family, fontPx=o.fontPx, color=o.color;
  ctx.save();
  ctx.fillStyle=color;
  // listType (whole-node bullets): prefix each line the same way drawFormattedText
  // does for its own plain-text listType case, then fall through to the normal
  // per-line math-segment parsing below — this is already line-oriented, so a
  // bullet prefix on each line is all that's needed to support it here too.
  const rawLines=(text||'').split('\n');
  const lines = o.listType
    ? rawLines.map((line,i)=> (o.listType==='ol' ? `${i+1}. ` : '\u2022 ')+line)
    : rawLines;
  const re=new RegExp(MATH_DELIM_RE.source,'g');
  const built=lines.map(line=>{
    const segs=[]; let last=0,m; re.lastIndex=0;
    const pushText=(s)=>{ if(!s) return; ctx.font=(o.bold?'bold ':'500 ')+fontPx+'px '+family; segs.push({type:'t',str:s,w:ctx.measureText(s).width,asc:fontPx*0.72,desc:fontPx*0.24}); };
    while((m=re.exec(line))){
      pushText(line.slice(last,m.index));
      const tex=m[1]!=null?m[1]:m[2];
      let mathEl=null; try{ const t=document.createElement('span'); t.innerHTML=latexToMathML(tex,false); mathEl=t.querySelector('math'); }catch(e){}
      if(mathEl){ const lay=_layoutMath(ctx,mathEl,fontPx,family,color); segs.push({type:'m',lay,w:lay.w,asc:lay.asc,desc:lay.desc}); }
      else pushText(m[0]);
      last=m.index+m[0].length;
    }
    pushText(line.slice(last));
    const w=segs.reduce((s,p)=>s+p.w,0);
    const asc=Math.max(fontPx*0.72,...segs.map(s=>s.asc),0);
    const desc=Math.max(fontPx*0.24,...segs.map(s=>s.desc),0);
    return {segs,w,asc,desc};
  });
  const lineH=Math.max(...built.map(b=>b.asc+b.desc), fontPx*1.2)*1.1;
  const totalH=lineH*built.length;
  let cy=o.y - totalH/2;
  built.forEach(b=>{
    const baseline=cy+b.asc;
    let x = o.align==='left' ? o.x : o.align==='right' ? (o.x+o.maxWidth-b.w) : (o.x+(o.maxWidth-b.w)/2);
    b.segs.forEach(s=>{
      if(s.type==='t'){ ctx.save(); ctx.font=(o.bold?'bold ':'500 ')+fontPx+'px '+family; ctx.fillStyle=color; ctx.textBaseline='alphabetic'; ctx.textAlign='left'; ctx.fillText(s.str,x,baseline); ctx.restore(); }
      else s.lay.draw(x, baseline);
      x+=s.w;
    });
    cy+=lineH;
  });
  ctx.restore();
}

async function exportPNG(){
  render();
  // Read live theme colors from CSS custom properties so the export matches
  // whatever theme/map style the user has selected.
  const cs = getComputedStyle(document.documentElement);
  const css = name => cs.getPropertyValue(name).trim();
  const themeBg     = css('--paper')     || '#f4efe6';
  const themeEdge   = css('--line-2')    || '#c8bda8';
  const themeInk    = css('--ink')       || '#23201b';
  const themeNodeBg = css('--node-bg')   || '#ffffff';
  const themeLine   = css('--line')      || '#d8cfbf';
  const accent      = css('--accent')    || '#e0613a';
  const themeLink   = css('--link')      || '#b8451f';
  const mapStyle  = map.style  || 'modern';
  const mapLayout = map.layout || 'balanced';

  const hidden=hiddenSet(); const ids=Object.keys(map.nodes).filter(i=>!hidden.has(i));
  // Pre-load every node's image — ctx.drawImage() needs an actual loaded Image
  // object, not the data-URL string, so this has to finish before the drawing
  // pass below runs. A per-image timeout means one slow/corrupt image can't hang
  // the whole export; that node just falls back to no image, like before.
  // Remote (http/https) images load with crossOrigin='anonymous' for the same reason
  // as favicons below: a tainted canvas makes toBlob() throw and kills the whole
  // export. A host without CORS just fails the load, and that node draws no image.
  const loadImg = src => new Promise(resolve=>{
    if(!src){ resolve(null); return; }
    const img=new Image();
    let done=false; const finish=v=>{ if(!done){ done=true; resolve(v); } };
    if(/^(https?:)?\/\//i.test(String(src))) img.crossOrigin='anonymous';
    img.onload=()=>finish(img);
    img.onerror=()=>finish(null);
    setTimeout(()=>finish(null), 4000);
    try{ img.src=src; }catch(_){ finish(null); }
  });
  const imgMap={};
  await Promise.all(ids.filter(i=>map.nodes[i].image).map(async i=>{ imgMap[i]=await loadImg(nodeImageSrc(map.nodes[i])); }));

  // Favicons for link nodes, so the export matches what the live canvas shows.
  // crossOrigin='anonymous' is the whole safety story here: favicons come from
  // a third-party host, and drawing a cross-origin image WITHOUT it taints the
  // canvas, which makes the final toBlob() throw and kills the entire export.
  // With it, the browser either gets CORS headers and the icon is safe to
  // draw, or the load fails outright and we simply skip that icon. A missing
  // favicon is a cosmetic loss; a tainted canvas is a broken feature.
  const loadFavicon = src => new Promise(resolve=>{
    const img=new Image();
    let done=false; const finish=v=>{ if(!done){ done=true; resolve(v); } };
    img.crossOrigin='anonymous';
    img.onload=()=>finish(img);
    img.onerror=()=>finish(null);
    setTimeout(()=>finish(null), 3000);   // never let a slow icon host stall the export
    img.src=src;
  });
  const favicons={};
  {
    const hosts=new Set();
    ids.forEach(i=>{
      const t=map.nodes[i].text||'';
      URL_RE.lastIndex=0; let m;
      while((m=URL_RE.exec(t))!==null){
        try{ hosts.add(new URL(m[0]).hostname.replace(/^www\./,'')); }catch(_){}
      }
    });
    await Promise.all([...hosts].map(async h=>{
      favicons[h]=await loadFavicon('https://icons.duckduckgo.com/ip3/'+h+'.ico');
    }));
  }
  let minx=1e9,miny=1e9,maxx=-1e9,maxy=-1e9;
  ids.forEach(i=>{const n=map.nodes[i];minx=Math.min(minx,n.x);miny=Math.min(miny,n.y);maxx=Math.max(maxx,n.x+(n.w||120));maxy=Math.max(maxy,n.y+(n.h||40));});
  const pad=50,scale=2;
  const W=(maxx-minx+pad*2),H=(maxy-miny+pad*2);
  const cv=document.createElement('canvas');cv.width=W*scale;cv.height=H*scale;
  const ctx=cv.getContext('2d');ctx.scale(scale,scale);
  ctx.fillStyle=themeBg; ctx.fillRect(0,0,W,H);
  // Dot-grid texture — matches .stage's CSS exactly (26px spacing, 1px radius,
  // var(--canvas-dot)). The solid fill above was the only background the
  // export drew; the live canvas always has this texture, so without it the
  // export looks visibly flatter/emptier than what's actually on screen.
  const dotColor = css('--canvas-dot');
  if(dotColor){
    ctx.fillStyle = dotColor;
    ctx.beginPath();
    for(let dx=0; dx<=W; dx+=26){
      for(let dy=0; dy<=H; dy+=26){
        ctx.moveTo(dx+1, dy);
        ctx.arc(dx, dy, 1, 0, Math.PI*2);
      }
    }
    ctx.fill();
  }
  ctx.translate(-minx+pad,-miny+pad);

  // Edges — match map style: bezier (modern/bubble), step (classic), straight (sketch)
  const edgeColor = (mapStyle==='bubble') ? accent : (mapStyle==='sketch' ? themeInk : themeEdge);
  const edgeWidth = (mapStyle==='bubble') ? 3 : (mapStyle==='classic' ? 1.6 : 2.2);
  ctx.strokeStyle = edgeColor;
  ctx.lineWidth   = edgeWidth;
  ctx.lineCap='round'; ctx.lineJoin='round';
  ids.forEach(i=>{
    const n=map.nodes[i]; if(!n.parent||hidden.has(n.parent)) return;
    const p=map.nodes[n.parent]; if(!p) return;
    let x1,y1,x2,y2,leftSide=(n.side==='left'),horizontal=true;
    if(mapLayout==='down'){
      horizontal=false;
      x1=p.x+(p.w||0)/2; y1=p.y+(p.h||0);
      x2=n.x+(n.w||0)/2; y2=n.y;
    } else {
      x1=leftSide ? p.x : p.x+(p.w||0); y1=p.y+(p.h||0)/2;
      x2=leftSide ? n.x+(n.w||0) : n.x;  y2=n.y+(n.h||0)/2;
    }
    ctx.beginPath();
    if(mapStyle==='classic'){
      if(horizontal){ const mid=(x1+x2)/2; ctx.moveTo(x1,y1); ctx.lineTo(mid,y1); ctx.lineTo(mid,y2); ctx.lineTo(x2,y2); }
      else { const mid=(y1+y2)/2; ctx.moveTo(x1,y1); ctx.lineTo(x1,mid); ctx.lineTo(x2,mid); ctx.lineTo(x2,y2); }
    } else if(mapStyle==='sketch'){
      ctx.moveTo(x1,y1); ctx.lineTo(x2,y2);
    } else {
      if(horizontal){
        const dx=Math.abs(x2-x1)*0.5;
        ctx.moveTo(x1,y1);
        ctx.bezierCurveTo(x1+(leftSide?-dx:dx),y1, x2+(leftSide?dx:-dx),y2, x2,y2);
      } else {
        const dy=Math.abs(y2-y1)*0.5;
        ctx.moveTo(x1,y1);
        ctx.bezierCurveTo(x1,y1+dy, x2,y2-dy, x2,y2);
      }
    }
    ctx.stroke();
  });

  // Cross-links — dotted accent curves (match the on-screen rendering)
  if(map.links && map.links.length){
    ctx.save();
    ctx.strokeStyle = accent;
    ctx.lineWidth = 2;
    ctx.setLineDash([2, 6]);
    ctx.globalAlpha = 0.85;
    map.links.forEach(lk=>{
      const a=map.nodes[lk.from], b=map.nodes[lk.to];
      if(!a||!b||hidden.has(lk.from)||hidden.has(lk.to)) return;   // a folded-away endpoint still has coordinates but isn't in the exported bounds — drawing to it sends the curve off-canvas
      const ax=a.x+(a.w||120)/2, ay=a.y+(a.h||40)/2;
      const bx=b.x+(b.w||120)/2, by=b.y+(b.h||40)/2;
      const mx=(ax+bx)/2, my=(ay+by)/2;
      const dx=bx-ax, dy=by-ay; const len=Math.hypot(dx,dy)||1;
      const off=Math.min(60, len*0.18);
      const cx=mx-(dy/len)*off, cy=my+(dx/len)*off;
      ctx.beginPath(); ctx.moveTo(ax,ay); ctx.quadraticCurveTo(cx,cy,bx,by); ctx.stroke();
    });
    ctx.restore();
  }

  // Nodes — also match shape per style
  const nodeRadius = (mapStyle==='bubble') ? 999 : (mapStyle==='classic' || mapStyle==='sketch') ? 4 : 12;
  const roll = computeRollups();
  // Small pill badge (task-progress / token-count), matching the on-screen corner style.
  const drawPillBadge = (text, x, yTop, bg, fg) => {
    ctx.font = 'bold 10px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace';
    const tw = ctx.measureText(text).width;
    const padX=7, ph=15, pw=tw+padX*2;
    roundRect(ctx, x, yTop, pw, ph, ph/2);
    ctx.fillStyle = bg; ctx.fill();
    ctx.lineWidth=1.5; ctx.strokeStyle=themeNodeBg; ctx.stroke();
    ctx.fillStyle = fg; ctx.textAlign='center'; ctx.textBaseline='middle';
    ctx.fillText(text, x+pw/2, yTop+ph/2+0.5);
    ctx.textAlign='start';
  };
  ids.forEach(i=>{
    const n=map.nodes[i]; const isRoot=(i===map.rootId);
    const w=n.w||120, h=n.h||40;
    const r = Math.min(nodeRadius, h/2);
    roundRect(ctx, n.x, n.y, w, h, r);
    if(isRoot){
      ctx.fillStyle = map.color || accent;
    } else {
      ctx.fillStyle = n.color || themeNodeBg;
    }
    ctx.fill();
    if(!isRoot && mapStyle !== 'bubble'){
      ctx.strokeStyle = n.url ? themeLink : (mapStyle==='sketch' ? themeInk : themeLine);
      ctx.lineWidth = mapStyle==='sketch' ? 2 : 1.5;
      ctx.stroke();
    }
    if(n.url){
      const barW=Math.max(18, w-24), barX=n.x+(w-barW)/2, barY=n.y+h-8;
      roundRect(ctx, barX, barY, barW, 3, 1.5);
      ctx.fillStyle = isRoot ? 'rgba(255,255,255,.7)' : themeLink;
      ctx.fill();
    }
    // Text — pick a color that contrasts with the node background
    const bg = isRoot ? (map.color || accent) : (n.color || themeNodeBg);
    const textFill = n.textColor || (isRoot ? pickContrast(bg) : (n.color ? pickContrast(n.color) : themeInk));
    const fontPx = n.fontSize || (isRoot ? 19 : 15);
    ctx.textBaseline='middle';
    const insetX = isRoot ? 22 : 15;
    // Node image — drawn first, at the top, so text/checkbox center in the space below it
    let imgDrawH = 0;
    const img = imgMap[i];
    if(img){
      const contentW = w - insetX*2;
      imgDrawH = Math.min(200, contentW * (img.naturalHeight/img.naturalWidth || 1));
      const imgY = n.y + (isRoot?14:10);
      ctx.save();
      roundRect(ctx, n.x+insetX, imgY, contentW, imgDrawH, 8);
      ctx.clip();
      ctx.drawImage(img, n.x+insetX, imgY, contentW, imgDrawH);
      ctx.restore();
      imgDrawH += (isRoot?14:10)+6;   // top offset + the CSS's 6px margin-bottom, so text centers below it correctly
    }
    const textCenterY = n.y + imgDrawH + (h-imgDrawH)/2;
    // Highlight (background per text) — node-wide for the canvas export
    if(n.highlight){
      ctx.fillStyle = n.highlight;
      ctx.fillRect(n.x+insetX-2, n.y+imgDrawH+4, w-insetX*2+4, h-imgDrawH-8);
    }
    const baseX = n.x+insetX;
    let textX = baseX, textMaxWidth = w-insetX*2;
    // Marker badge — drawn before the task box so export order matches the DOM.
    if(n.marker){
      ctx.font='15px sans-serif'; ctx.textAlign='start'; ctx.textBaseline='middle';
      ctx.fillStyle=textFill;
      ctx.fillText(n.marker, textX, textCenterY);
      const mw=ctx.measureText(n.marker).width+6;
      textX += mw; textMaxWidth -= mw;
    }
    // Task checkbox — 18px box + 7px gap, matching .task-check's live CSS exactly
    if(n.task){
      const boxSize=18, boxY=textCenterY-boxSize/2, boxX=textX;
      roundRect(ctx, boxX, boxY, boxSize, boxSize, 5);
      ctx.fillStyle = n.task==='done' ? '#4a9d5b' : themeNodeBg;
      ctx.fill();
      ctx.strokeStyle = n.task==='doing' ? '#c98a1a' : (n.task==='done' ? '#4a9d5b' : themeLine);
      ctx.lineWidth=2; ctx.stroke();
      if(n.task==='done'||n.task==='doing'){
        ctx.font='bold 12px sans-serif'; ctx.textAlign='center'; ctx.textBaseline='middle';
        ctx.fillStyle = n.task==='done' ? '#fff' : '#c98a1a';
        ctx.fillText(n.task==='done'?'\u2713':'\u25D0', boxX+boxSize/2, boxY+boxSize/2+1);
        ctx.textAlign='start';
      }
      textX = boxX+boxSize+7; textMaxWidth -= boxSize+7;
    }
    // Render with inline B/I/U/S support, list bullets, line wrapping.
    // Nodes with $...$ math go through the canvas math renderer so equations
    // export as laid-out math instead of raw LaTeX source.
    // Mirror render(): divider nodes draw a rule, block/table nodes draw a cell grid,
    // formula nodes draw their computed value (render() above refreshed the cache).
    const exportBlocks = n.hr ? null : exportNodeBlocks(n);
    const formulaSrc = (n.hr || n.html) ? '' : nodeTextPlain(n.text||'').trim();
    if(n.hr){
      ctx.save(); ctx.strokeStyle=textFill; ctx.globalAlpha=0.55; ctx.lineWidth=2;
      ctx.beginPath(); ctx.moveTo(textX, textCenterY); ctx.lineTo(textX+textMaxWidth, textCenterY); ctx.stroke();
      ctx.restore();
    } else if(exportBlocks){
      drawExportBlocks(ctx, exportBlocks, {
        x: textX, y: n.y+imgDrawH+6, w: textMaxWidth, h: h-imgDrawH-12,
        fontPx, color: textFill, lineColor: themeLine, family: '"PingFang SC", sans-serif'
      });
    } else if(formulaSrc.startsWith('=')){
      const val = computeNodeValue(i);
      const shown = (val && typeof val==='object' && val.error) ? '#ERROR' : formatFormulaResult(val);
      drawFormattedText(ctx, escapeHtml(String(shown==null?'':shown)), {
        favicons, x: textX, y: textCenterY, maxWidth: textMaxWidth, fontPx, color: textFill,
        family: '"PingFang SC", sans-serif', baseBold: !!n.bold || isRoot, baseItalic: !!n.italic,
        baseUnderline: !!n.underline, baseStrike: !!n.strike, align: n.align || 'center', listType: null
      });
    } else if(containsMath(n.text||'')){
      drawNodeMath(ctx, n.text||'', {
        x: textX, y: textCenterY, maxWidth: textMaxWidth,
        fontPx, color: textFill, family: '"PingFang SC", sans-serif',
        bold: !!n.bold || isRoot, align: n.align || 'center', listType: n.listType || null
      });
    } else {
    drawFormattedText(ctx, n.text||'', {
      favicons,
      x: textX,
      y: textCenterY,
      maxWidth: textMaxWidth,
      fontPx,
      color: textFill,
      family: '"PingFang SC", sans-serif',
      baseBold: !!n.bold || isRoot,
      baseItalic: !!n.italic,
      baseUnderline: !!n.underline,
      baseStrike: !!n.strike,
      align: n.align || 'center',
      listType: n.listType || null
    });
    }
    // Notes indicator — small white-circle dot with a 📝 glyph (top-right)
    const noteText = (n.notes||'').replace(/<[^>]*>/g,'').trim();
    if(noteText){
      const cx = (n.side==='left') ? n.x + 4 : n.x + w - 4;
      const cy = n.y + 4;
      ctx.beginPath();
      ctx.arc(cx, cy, 10, 0, Math.PI*2);
      ctx.fillStyle = themeNodeBg;
      ctx.fill();
      ctx.lineWidth = 1.4;
      ctx.strokeStyle = themeLine;
      ctx.stroke();
      ctx.font = '10px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = themeInk;
      ctx.fillText('📝', cx, cy);
      ctx.textAlign = 'start';   // restore
      ctx.textBaseline = 'middle';
    }
    // Task-progress roll-up badge — top-left pill, shown on nodes with task-bearing
    // descendants (but that aren't themselves a task)
    const prog = {done:roll.tdone[i], total:roll.ttot[i]};
    if(prog.total>0 && !n.task){
      const complete = prog.done===prog.total;
      drawPillBadge(`\u2713 ${prog.done}/${prog.total}`, n.x-6, n.y-9, complete?'#4a9d5b':themeInk, '#fff');
    }
    // Reference/citation mark — top-left circle with a 📖 glyph
    if(n.ref){
      const cx=n.x-9+11, cy=n.y-9+11;
      ctx.beginPath(); ctx.arc(cx, cy, 11, 0, Math.PI*2);
      ctx.fillStyle=themeNodeBg; ctx.fill();
      ctx.lineWidth=1.5; ctx.strokeStyle=accent; ctx.stroke();
      ctx.font='11px sans-serif'; ctx.textAlign='center'; ctx.textBaseline='middle';
      ctx.fillStyle=themeInk; ctx.fillText('📖', cx, cy);
      ctx.textAlign='start';
    }

  });

  try{
    cv.toBlob(b=>{download(b,(map.title||'mindmap')+'.png');toast(rmsTr('tPngExported','PNG exported'));});
  }catch(e){
    // Only reachable if the canvas got tainted despite the CORS guard above.
    console.warn('PNG export failed:', e.message);
    toast(rmsTr('tPngFailed','Could not export the PNG'));
  }
}

// PNG export: what a block node (n.html) or a GFM-table node shows, as drawable
// blocks — {type:'table', grid} or {type:'text', lines}. null = ordinary text node.
function exportNodeBlocks(n){
  if(!n || n.hr) return null;
  if(n.html){
    const grid=htmlTableToGrid(sanitizeNotes(n.html));
    if(grid) return [{ type:'table', grid }];
    const tpl=document.createElement('template'); tpl.innerHTML=sanitizeNotes(n.html);
    tpl.content.querySelectorAll('br').forEach(br=>br.replaceWith(document.createTextNode('\n')));
    const txt=(tpl.content.textContent||'').replace(/\u00A0/g,' ').replace(/\n{3,}/g,'\n\n').trim();
    return txt ? [{ type:'text', lines:txt.split('\n') }] : null;
  }
  const text=n.text||'';
  if(!nodeTextHasGfmTable(text)) return null;
  const blocks=[];
  splitTextWithGfmTables(text).forEach(p=>{
    if(p.type==='table' && p.grid){
      const plain=c=>nodeTextPlain(formatNodeTableCell(c)).trim();   // same inline Markdown as the live cell, drawn as text
      blocks.push({ type:'table', grid:{ headers:p.grid.headers.map(plain), rows:p.grid.rows.map(r=>r.map(plain)), aligns:p.grid.aligns } });
    } else if(p.value){
      const t=nodeTextPlain(p.value).trim();
      if(t) blocks.push({ type:'text', lines:t.split('\n') });
    }
  });
  return blocks.length ? blocks : null;
}
// Draw exportNodeBlocks() output inside the box {x,y,w,h}: text lines, then each
// table as an equal-width grid with a bold header row. Rows shrink to fit the box.
function drawExportBlocks(ctx, blocks, o){
  const rowsNeeded=blocks.reduce((k,b)=> k + (b.type==='table' ? 1+b.grid.rows.length : b.lines.length), 0);
  if(!rowsNeeded) return;
  const rowH=Math.max(6, Math.min(o.fontPx*1.7, o.h/rowsNeeded));
  const fontPx=Math.max(6, Math.min(o.fontPx, rowH/1.45));
  const fit=(str, maxW)=>{
    let t=String(str==null?'':str);
    if(ctx.measureText(t).width<=maxW) return t;
    while(t.length>1 && ctx.measureText(t+'\u2026').width>maxW) t=t.slice(0,-1);
    return t+'\u2026';
  };
  let y=o.y + Math.max(0, (o.h - rowsNeeded*rowH)/2);
  ctx.save();
  ctx.textBaseline='middle'; ctx.fillStyle=o.color;
  blocks.forEach(b=>{
    if(b.type==='text'){
      ctx.font='500 '+fontPx+'px '+o.family; ctx.textAlign='center';
      b.lines.forEach(line=>{ ctx.fillText(fit(line, o.w), o.x+o.w/2, y+rowH/2); y+=rowH; });
      return;
    }
    const g=b.grid, cols=g.headers.length, cw=o.w/cols, top=y;
    const pad=Math.min(6, cw*0.1);
    [g.headers, ...g.rows].forEach((row, ri)=>{
      ctx.font=(ri===0?'700 ':'500 ')+fontPx+'px '+o.family;
      row.forEach((cell, ci)=>{
        const al=(g.aligns && g.aligns[ci]) || 'left';
        ctx.textAlign=al==='right'?'right':(al==='center'?'center':'left');
        const cx=al==='right' ? o.x+(ci+1)*cw-pad : al==='center' ? o.x+ci*cw+cw/2 : o.x+ci*cw+pad;
        ctx.fillText(fit(cell, cw-pad*2), cx, y+rowH/2);
      });
      y+=rowH;
    });
    ctx.strokeStyle=o.lineColor||o.color; ctx.lineWidth=1;
    ctx.beginPath();
    for(let r=0; r<=1+g.rows.length; r++){ ctx.moveTo(o.x, top+r*rowH); ctx.lineTo(o.x+o.w, top+r*rowH); }
    for(let c=0; c<=cols; c++){ ctx.moveTo(o.x+c*cw, top); ctx.lineTo(o.x+c*cw, y); }
    ctx.stroke();
  });
  ctx.restore();
}
// Render text (possibly containing inline <b>/<i>/<u>/<s>/<a>/<br>/<ul>/<ol>/<li>)
// onto a canvas context at the given centre point, with word-wrap and per-line
// alignment. This is what makes the PNG export look like the browser render.
function drawFormattedText(ctx, html, opts){
  const { x, y, maxWidth, fontPx, color, family, baseBold, baseItalic, baseUnderline, baseStrike, align, listType } = opts;
  // Step 1: walk the HTML, collecting "runs" each with a formatting state.
  // \n separators come from <br>, end-of-li, and end-of-p/div blocks.
  // Inert, sanitized parse (a live <div>.innerHTML would fire <img onerror> during
  // PNG export). Plain node text is plain text, as in renderNodeText.
  const src = (html || '').toString();
  const tpl = document.createElement('template');
  if(hasInlineMarkup(src)) tpl.innerHTML = sanitizeInlineHTML(src);
  else tpl.content.appendChild(document.createTextNode(src));
  const tmp = tpl.content;
  const runs = [];
  // legacy listType (whole-node bullets) — render as if each line of plain text
  // were wrapped in a <li>
  if(listType && !INLINE_HTML_RE.test(html||'')){
    const lines = (html||'').split('\n');
    lines.forEach((line, i)=>{
      const prefix = listType==='ol' ? `${i+1}. ` : '• ';
      runs.push({ text:prefix+line, bold:baseBold, italic:baseItalic, underline:baseUnderline, strike:baseStrike });
      if(i < lines.length-1) runs.push({ text:'\n', bold:false,italic:false,underline:false,strike:false });
    });
  } else {
    const walk = (node, st) => {
      node.childNodes.forEach(child => {
        if(child.nodeType === 3){
          // Split on \n so embedded newlines (Shift+Enter while editing) become
          // real line breaks in the export, not whitespace.
          const v = (child.nodeValue || '').replace(/\u00A0/g,' ');
          if(!v) return;
          const parts = v.split('\n');
          parts.forEach((p, i) => {
            if(i > 0) runs.push({ text:'\n', ...st });
            if(!p) return;
            // Auto-detect raw URLs the same way the live DOM does
            // (appendTextWithLinks) — the stored node content never contains
            // an <a> tag for these (that wrapping is display-only, applied
            // fresh on every live render, never saved) so without this the
            // export has no way to know a plain-text segment is a link at
            // all, and just draws the raw URL as ordinary text.
            URL_RE.lastIndex = 0;
            let last = 0, m;
            let matched = false;
            while((m = URL_RE.exec(p)) !== null){
              matched = true;
              if(m.index > last) runs.push({ text:p.slice(last, m.index), ...st });
              let _fh=''; try{ _fh=new URL(m[0]).hostname.replace(/^www\./,''); }catch(_){}
              runs.push({ text:prettyUrl(m[0]), ...st, link:true, underline:true, favHost:_fh });
              last = m.index + m[0].length;
            }
            if(matched){ if(last < p.length) runs.push({ text:p.slice(last), ...st }); }
            else runs.push({ text:p, ...st });
          });
        } else if(child.nodeType === 1){
          const tag = child.tagName.toLowerCase();
          const next = { ...st };
          if(tag==='b'||tag==='strong') next.bold = true;
          if(tag==='i'||tag==='em')     next.italic = true;
          if(tag==='u')                 next.underline = true;
          if(tag==='s'||tag==='strike') next.strike = true;
          if(tag==='a'){ next.link = true; next.underline = true; }
          if(tag==='br'){ runs.push({ text:'\n', ...st }); return; }
          if(tag==='li'){
            // Push bullet/number prefix
            const isOL = child.parentElement && child.parentElement.tagName==='OL';
            const idx = child.parentElement ? Array.from(child.parentElement.children).indexOf(child)+1 : 1;
            runs.push({ text:(isOL ? `${idx}. ` : '• '), ...st });
          }
          walk(child, next);
          if(tag==='li' || tag==='p' || tag==='div') runs.push({ text:'\n', ...st });
        }
      });
    };
    walk(tmp, { bold:baseBold, italic:baseItalic, underline:baseUnderline, strike:baseStrike, link:false });
  }

  if(runs.length===0) return;

  // Step 2: word-wrap into lines. Each line = array of {text, w, bold, italic, underline, strike}
  const setFont = (run) => {
    let f='';
    if(run.italic) f += 'italic ';
    f += (run.bold ? 'bold ' : '500 ') + fontPx + 'px ' + family;
    ctx.font = f;
  };
  const lines = [[]];
  let curW = 0;
  // Favicons are preloaded by the caller (exportPNG) before we get here, so a
  // missing or failed one is already known at measure time — that matters,
  // because the icon's width has to be reserved during wrapping, not at draw
  // time. `favicons` is keyed by hostname; a null value means "did not load",
  // in which case nothing is reserved and nothing is drawn.
  const favicons = opts.favicons || {};
  const iconW = Math.round(fontPx * 1.15);   // icon box + trailing gap
  runs.forEach(run => {
    if(run.text === '\n'){ lines.push([]); curW = 0; return; }
    // Keep whitespace as separate chunks so wrapping breaks on it
    const parts = run.text.split(/(\s+)/);
    let firstChunk = true;
    parts.forEach(part => {
      if(!part) return;
      setFont(run);
      // Only the first visible chunk of a link run carries the icon — a
      // wrapped URL must not repeat it on every line.
      const fav = (firstChunk && run.favHost && favicons[run.favHost]) ? favicons[run.favHost] : null;
      const w = ctx.measureText(part).width + (fav ? iconW : 0);
      if(curW + w > maxWidth && lines[lines.length-1].length > 0 && part.trim()){
        lines.push([]); curW = 0;
      }
      lines[lines.length-1].push({ text:part, w, bold:run.bold, italic:run.italic, underline:run.underline, strike:run.strike, link:run.link, fav });
      curW += w;
      if(part.trim()) firstChunk = false;
    });
  });
  while(lines.length > 1 && lines[lines.length-1].length === 0) lines.pop();

  // Step 3: draw. Vertically centre block around y.
  const lineH = Math.round(fontPx * 1.35);
  const totalH = lines.length * lineH;
  let yy = y - totalH/2 + lineH/2;
  // Hyperlink colour (resolved from CSS var so it matches the live theme)
  const linkColor = (typeof getComputedStyle === 'function')
    ? (getComputedStyle(document.documentElement).getPropertyValue('--link').trim() || '#3a6ea5')
    : '#3a6ea5';
  ctx.fillStyle = color;
  lines.forEach(line => {
    const lineW = line.reduce((s, r) => s + r.w, 0);
    let xx = x;
    if(align === 'center') xx = x + (maxWidth - lineW)/2;
    else if(align === 'right') xx = x + (maxWidth - lineW);
    line.forEach(run => {
      setFont(run);
      const runColor = run.link ? linkColor : color;
      ctx.fillStyle = runColor;
      let tx = xx;
      if(run.fav){
        const box = Math.round(fontPx * 0.9);
        try{ ctx.drawImage(run.fav, xx, yy - box*0.78, box, box); }
        catch(e){ /* never let a bad icon abort the whole export */ }
        tx += iconW;
      }
      ctx.fillText(run.text, tx, yy);
      if(run.underline || run.strike){
        ctx.strokeStyle = runColor;
        ctx.lineWidth = Math.max(1, fontPx/15);
        ctx.beginPath();
        const ly = run.underline ? (yy + fontPx*0.38) : (yy - fontPx*0.18);
        // Underline only the text, not the icon.
        ctx.moveTo(tx, ly); ctx.lineTo(xx + run.w, ly);
        ctx.stroke();
      }
      xx += run.w;
    });
    yy += lineH;
  });
}
// Pick black-or-white for best contrast against a hex background
function pickContrast(hex){
  const h = (hex||'').replace('#','');
  if(h.length < 6) return '#23201b';
  const r=parseInt(h.slice(0,2),16), g=parseInt(h.slice(2,4),16), b=parseInt(h.slice(4,6),16);
  // luminance roughly per WCAG
  const L = (0.299*r + 0.587*g + 0.114*b) / 255;
  return L > 0.6 ? '#23201b' : '#ffffff';
}
function roundRect(ctx,x,y,w,h,r){ctx.beginPath();ctx.moveTo(x+r,y);ctx.arcTo(x+w,y,x+w,y+h,r);ctx.arcTo(x+w,y+h,x,y+h,r);ctx.arcTo(x,y+h,x,y,r);ctx.arcTo(x,y,x+w,y,r);ctx.closePath();}
function download(blob,name){const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);}

/* ---------- toast ---------- */
// How long a toast stays up: long enough to read (about 50 ms a character,
// 2–8 s), and at least 6 s for an error. An explicit `ms` wins.
const TOAST_ERROR_RE=/fail|could not|couldn|error|refused|cannot|can't|not valid|失败|无法|错误|拒绝/i;
function toastDuration(msg, ms){
  if(typeof ms==='number' && isFinite(ms) && ms>0) return Math.max(1000, ms);
  const len=String(msg==null?'':msg).length;
  let d=Math.min(8000, Math.max(2000, len*50));
  if(ms==='error' || (ms && ms.error) || TOAST_ERROR_RE.test(String(msg||''))) d=Math.max(d, 6000);
  return d;
}
let toastT;
function toast(msg, ms){
  const t=$('#toast');
  if(!t) return;
  t.textContent=msg;
  t.classList.add('show');
  clearTimeout(toastT);
  toastT=setTimeout(()=>t.classList.remove('show'), toastDuration(msg, ms));
}

function textEditContextTarget(target){
  if(!target || !target.closest) return null;
  if(target.closest('.rms-ctx, .rms-settings, .kb-card, .vf-card')) return null;
  return target.closest('textarea, input:not([type="button"]):not([type="submit"]):not([type="checkbox"]):not([type="radio"]):not([type="range"]):not([type="file"]), [contenteditable="true"], .edit-float, .node.editing');
}
function textEditHasSelection(){
  const field=focusedValueField() || (typeof openOverlayTextField==='function' && openOverlayTextField());
  if(field){
    const a=field.selectionStart, b=field.selectionEnd;
    return a!=null && b!=null && b>a;
  }
  const target=typeof openClipboardTarget==='function' ? openClipboardTarget() : null;
  if(target && typeof editorSelectedText==='function') return !!editorSelectedText(target);
  const s=typeof window!=='undefined' && window.getSelection && window.getSelection();
  return !!(s && s.rangeCount && !s.isCollapsed);
}
function closeTextEditContextMenu(){
  if(typeof document==='undefined' || !document.querySelectorAll) return;
  document.querySelectorAll('.text-edit-menu').forEach(p=>{ try{p.remove();}catch(_){} });
}
function nativeEditAction(act){
  try{
    const h=window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.rmsNative;
    if(h && typeof h.postMessage==='function'){
      h.postMessage({op:'edit', act:act});
      return true;
    }
  }catch(_){}
  return false;
}
function runTextEditAction(act){
  if(nativeEditAction(act)) return;
  if(act==='copy'){
    const text=typeof rmsClipboardCopy==='function' ? rmsClipboardCopy() : '';
    if(text && typeof writeClipboardText==='function') writeClipboardText(text);
    return;
  }
  if(act==='cut'){
    const text=typeof rmsClipboardCut==='function' ? rmsClipboardCut() : '';
    if(text && typeof writeClipboardText==='function') writeClipboardText(text);
    return;
  }
  if(act==='paste'){
    if(typeof navigator!=='undefined' && navigator.clipboard && navigator.clipboard.readText){
      navigator.clipboard.readText().then(t=>{ if(typeof rmsClipboardPaste==='function') rmsClipboardPaste(t); }).catch(()=>{});
    }
    return;
  }
  if(act==='selectAll' && typeof rmsClipboardSelectAll==='function') rmsClipboardSelectAll();
  if(act==='undo' && typeof rmsClipboardUndo==='function') rmsClipboardUndo();
  if(act==='redo' && typeof rmsClipboardRedo==='function') rmsClipboardRedo();
}
function showTextEditContextMenu(e){
  const target=textEditContextTarget(e && e.target);
  if(!target) return false;
  closeTextEditContextMenu();
  const p=document.createElement('div');
  p.className='rms-ctx text-edit-menu';
  const x0=(e && e.clientX)||8, y0=(e && e.clientY)||8;
  p.style.left=x0+'px';
  p.style.top=y0+'px';
  const hasSel=textEditHasSelection();
  const ro=typeof READONLY!=='undefined' && READONLY;
  const item=(act, label, enabled)=>`<button type="button" data-a="${act}" ${enabled?'':'disabled'}>${label}</button>`;
  p.innerHTML=
    item('undo', rmsTr('undo','Undo'), true)+
    item('redo', rmsTr('redo','Redo'), true)+
    '<div class="rms-ctx-sep"></div>'+
    item('cut', rmsTr('ctxCut','Cut'), hasSel && !ro)+
    item('copy', rmsTr('ctxCopy','Copy'), hasSel)+
    item('paste', rmsTr('ctxPaste','Paste'), !ro)+
    '<div class="rms-ctx-sep"></div>'+
    item('selectAll', rmsTr('ctxSelectAll','Select All'), true);
  document.body.appendChild(p);
  const r=p.getBoundingClientRect();
  if(r.right>innerWidth-8) p.style.left=Math.max(8, innerWidth-r.width-8)+'px';
  if(r.bottom>innerHeight-8) p.style.top=Math.max(8, innerHeight-r.height-8)+'px';
  p.addEventListener('mousedown', ev=>{
    ev.preventDefault();
    ev.stopPropagation();
  });
  p.querySelectorAll('button[data-a]').forEach(b=>{
    b.addEventListener('click', ev=>{
      ev.preventDefault();
      ev.stopPropagation();
      if(b.disabled) return;
      const act=b.dataset.a;
      closeTextEditContextMenu();
      runTextEditAction(act);
    });
  });
  setTimeout(()=>{
    const off=ev=>{
      if(!p.contains(ev.target)){
        closeTextEditContextMenu();
        document.removeEventListener('mousedown', off, true);
      }
    };
    document.addEventListener('mousedown', off, true);
  }, 0);
  return true;
}

// Kill Chromium / WKWebView's default context menu. App-owned menus (button
// shortcut bind, text edit, etc.) listen on the same event and still run.
function suppressNativeContextMenu(e){
  if(e && e.preventDefault) e.preventDefault();
  if(typeof showTextEditContextMenu==='function') showTextEditContextMenu(e);
}

/* ============================================================
   WIRE UP
   ============================================================ */
document.addEventListener('contextmenu', suppressNativeContextMenu, true);
document.addEventListener('contextmenu', onNodeContextMenu, true);
$('#newMap').onclick=createMap;
$('#newMapMenu')?.addEventListener('click', e => { e.stopPropagation(); showTemplatesMenu(); });
$('#emptyNew').onclick=createMap;
$('#addChild').onclick=()=>{ if(!map)return; addNode(sel||map.rootId,false); };
$('#addSiblingBtn')?.addEventListener('click', ()=>{
  if(!map) return;
  const id=sel||map.rootId;
  if(id===map.rootId) return;
  addNode(id,true);
});
window.addEventListener('rms-lang', ()=>{ if(typeof refreshLocaleChrome==='function') refreshLocaleChrome(); });
// Before printing, fit the whole map into view so nothing is clipped on paper.
let _rzReframeT=null;
window.addEventListener('resize', ()=>{
  clearTimeout(_rzReframeT);
  _rzReframeT=setTimeout(()=>{
    if(!map){ _markStage(); return; }
    _recenterForStageChange();
    updateMinimap();
  }, 160);
});
window.addEventListener('beforeprint', ()=>{ try{ fit(); }catch(e){} });

$('#layout').onclick=autoLayout;            // re-tidies node positions (does NOT move the camera)
// Collapse-all / expand-all toggle. If any collapsible node is currently
// expanded, the first click collapses everything; otherwise it expands all.
// Animates as an incremental cascade rather than jumping straight to the final state:
// collapsing proceeds deepest-branch-first (so a parent doesn't visually swallow a
// still-open child), expanding proceeds shallowest-first (children reveal only after
// their own parent has opened) — the same ordering tree UIs like VS Code's file
// explorer or Notion's outline use for a "collapse/expand all".
// "Collapse/expand all branches" steps the WHOLE map one depth level per click instead
// of jumping straight to fully expanded or fully collapsed. Collapsing closes the
// deepest still-open branch level first (so a shallow branch never visually swallows a
// still-open child); expanding opens the shallowest still-closed branch level first
// (children only reveal once their own parent has opened). Repeated clicks cycle:
// expand, expand, ... fully open -> collapse, collapse, ... fully closed -> expand
// again. The map's actual root is never itself a candidate to collapse — that would
// hide the whole map — only its descendants are.
let _collapseAllDir=null;
function stepCollapseAll(){
  if(!map) return null;
  // Unconditional walk: how many depth levels the WHOLE tree has, regardless of the
  // current fold state — this is only for reporting progress ("expanded 2/4"), not for
  // deciding what to fold/unfold below (that still only ever looks at what's currently
  // reachable, via the visibility-respecting walk further down).
  let totalDepth=-1;
  const walkAll=(id, depth)=>{
    childrenOf(id).forEach(c=>{
      if(childrenOf(c).length){ if(depth>totalDepth) totalDepth=depth; walkAll(c, depth+1); }
    });
  };
  walkAll(map.rootId, 0);
  const totalLevels=totalDepth+1;
  if(totalLevels<=0) return null;

  const branches=[];
  const walk=(id, depth)=>{
    childrenOf(id).forEach(c=>{
      if(childrenOf(c).length){
        branches.push({id:c, depth});
        if(!map.nodes[c].collapsed) walk(c, depth+1);
      }
    });
  };
  walk(map.rootId, 0);
  const hidden=branches.filter(b=>map.nodes[b.id].collapsed);
  const fullyExpanded=hidden.length===0;
  const openBranches=branches.filter(b=>!map.nodes[b.id].collapsed);
  const fullyCollapsed=openBranches.length===0;

  let dir=_collapseAllDir;
  if(!dir) dir = fullyExpanded ? 'collapse' : 'expand';   // no memory yet -> infer from current state
  if(dir==='collapse' && fullyCollapsed) dir='expand';     // exhausted (fully closed) -> flip
  if(dir==='expand' && fullyExpanded) dir='collapse';      // exhausted (fully open) -> flip
  _collapseAllDir=dir;

  if(dir==='expand'){
    const minDepth=Math.min(...hidden.map(b=>b.depth));
    hidden.filter(b=>b.depth===minDepth).forEach(b=>{ map.nodes[b.id].collapsed=false; });
    return {dir, step:minDepth+1, total:totalLevels};        // levels 0..minDepth are now open
  } else {
    const maxDepth=Math.max(...openBranches.map(b=>b.depth));
    openBranches.filter(b=>b.depth===maxDepth).forEach(b=>{ map.nodes[b.id].collapsed=true; });
    return {dir, step:totalLevels-maxDepth, total:totalLevels};   // levels maxDepth..totalLevels-1 are now closed
  }
}
$('#collapseAll')?.addEventListener('click', ()=>{
  if(!map) return;
  const st=stepCollapseAll();
  if(!st) return;
  pushHistory();
  autoLayout();
  const verb=st.dir==='collapse' ? rmsTr('collapsed','Collapsed') : rmsTr('expanded','Expanded');
  toast(st.step>=st.total
    ? rmsTr('collapseToastAll','%s all').replace('%s', verb)
    : rmsTr('collapseToastStep','%s %s/%s').replace('%s', verb).replace('%s', st.step).replace('%s', st.total));
});
$('#undo').onclick=undo; $('#redo').onclick=redo;
document.getElementById('mdToggle')?.addEventListener('click',()=>toggleMdMode());
$('#zoomIn').onclick=()=>zoom(1.15); $('#zoomOut').onclick=()=>zoom(.87);
$('#zoomFit').onclick=()=>{ const t=computeFitView(); if(t){ animateViewTo(t,220); userZoom=t.k; } saveMapView(); };
$('#minimap')?.addEventListener('mousedown', e=>{ e.stopPropagation(); minimapJump(e.clientX, e.clientY); });
$('#minimap')?.addEventListener('click', e=>e.stopPropagation());
// Click the zoom % to enter a custom value
(function(){
  const zv=$('#zoomVal');
  zv.addEventListener('click',()=>{
    zv.contentEditable='true';
    zv.textContent=Math.round(view.k*100);   // strip the % for easier editing
    zv.focus();
    const r=document.createRange(); r.selectNodeContents(zv);
    const s=getSelection(); s.removeAllRanges(); s.addRange(r);
  });
  const apply=()=>{
    zv.contentEditable='false';
    const v=parseFloat(String(zv.textContent).replace(/[^\d.]/g,''));
    if(Number.isFinite(v) && v>=10 && v<=300) setZoom(v); else applyView();
  };
  zv.addEventListener('blur',apply);
  zv.addEventListener('keydown',e=>{
    e.stopPropagation();
    if(e.key==='Enter'){ e.preventDefault(); zv.blur(); }
    if(e.key==='Escape'){ e.preventDefault(); applyView(); zv.blur(); }
  });
})();
// Wheel-zoom speed slider (0–100%), persisted. The number field is the same
// value so it can be typed as well as dragged.
(function(){
  const wrap=$('#wheelSpeed'), range=$('#wheelSpeedRange'), num=$('#wheelSpeedNum');
  if(!wrap||!range||!num) return;
  const paint=()=>{
    range.value=String(wheelSpeed);
    num.value=wheelSpeed+'%';
  };
  const commit=raw=>{
    wheelSpeed=clampWheelSpeed(parseFloat(String(raw).replace(/[^\d.]/g,'')));
    try{ localStorage.setItem(WHEEL_SPEED_KEY, String(wheelSpeed)); }catch(e){}
    paint();
  };
  paint();
  wrap.addEventListener('mousedown', e=>e.stopPropagation());
  wrap.addEventListener('wheel', e=>e.stopPropagation());
  range.addEventListener('input',()=>commit(range.value));
  num.addEventListener('focus',()=>{
    num.value=String(wheelSpeed);
    num.select();
  });
  num.addEventListener('blur',()=>commit(num.value));
  num.addEventListener('keydown',e=>{
    e.stopPropagation();
    if(e.key==='Enter'){ e.preventDefault(); num.blur(); }
    if(e.key==='Escape'){ e.preventDefault(); paint(); num.blur(); }
  });
})();
$('#menuExport').onclick=(e)=>{ e.stopPropagation(); exportMenu(); };
let _sideExpandedW = 268;   // cached logical width of the expanded sidebar
function persistSidebar(collapsed){
  document.documentElement.classList.toggle('side-collapsed', collapsed);
  try{ localStorage.setItem('mindspark:sidebar', collapsed?'1':'0'); }catch(e){}
}
function applySidebarCollapsed(collapsed){
  const side=$('#side'); if(!side) return;
  side.classList.toggle('collapsed', collapsed);
  persistSidebar(collapsed);
}
$('#toggleSide').onclick=()=>{
  const side=$('#side');
  // On phones the sidebar is a transform overlay (stage keeps full width), so no
  // reframe is needed there — let CSS slide it.
  const overlay = window.matchMedia('(max-width: 720px)').matches;
  const z=(typeof _uiZ==='function'?(_uiZ()||1):1);
  const sbNow = side.getBoundingClientRect().width / z;
  if(sbNow > 1) _sideExpandedW = sbNow;          // remember the expanded width
  // Capture the map-point at the viewport centre BEFORE the width changes.
  let cx,cy,has=false;
  if(map && !overlay){ const {w:SW,h:SH}=_stageSize(); cx=(SW/2-view.x)/view.k; cy=(SH/2-view.y)/view.k; has=isFinite(cx)&&isFinite(cy); }
  const collapsing = !side.classList.contains('collapsed');
  applySidebarCollapsed(collapsing);
  if(has){
    const {w:W0, h:H0} = _stageSize();           // still the pre-animation size this frame
    const W1 = collapsing ? (W0 + _sideExpandedW) : (W0 - _sideExpandedW);
    _reframeSmooth(cx, cy, W1, H0);
  }
};
// Desktop: honour the saved collapsed/expanded choice. Phones still start
// collapsed (overlay), but a later toggle is remembered for the next desktop load.
(function restoreSidebar(){
  const side=$('#side'); if(!side) return;
  const phone=window.matchMedia('(max-width: 720px)').matches;
  let collapsed=phone;
  if(!phone){
    try{ collapsed=localStorage.getItem('mindspark:sidebar')==='1'; }catch(e){ collapsed=false; }
  }
  side.classList.toggle('collapsed', collapsed);
  document.documentElement.classList.toggle('side-collapsed', collapsed);
})();
// Tapping the dimmed canvas while the phone overlay is open should close it.
if(window.matchMedia('(max-width: 720px)').matches){
  $('#stage').addEventListener('click', e=>{
    const side=$('#side');
    if(side.classList.contains('collapsed')) return;
    // Only close if the user tapped the dimming overlay (the ::after pseudo) —
    // which sits on top of all the topbar/zoombar at z-index 150. Easiest
    // proxy: tap landed on #stage or #viewport (not on a node or chrome).
    if(e.target.id==='stage' || e.target.id==='viewport'){
      applySidebarCollapsed(true);
    }
  });
}
const HINT_DISMISSED_KEY='rms:hintDismissed';
(function initHintBar(){
  const hint=$('#hint');
  if(!hint) return;
  let dismissed=false;
  try{ dismissed=localStorage.getItem(HINT_DISMISSED_KEY)==='1'; }catch(_){}
  if(dismissed){ hint.style.display='none'; return; }
  renderHintBar();
  $('#hintClose').onclick=()=>{
    hint.style.display='none';
    try{ localStorage.setItem(HINT_DISMISSED_KEY, '1'); }catch(_){}
  };
})();

/* ---------- UI scale (whole-interface zoom, persisted) ---------- */
// Auto scale by viewport size, continuous rather than stepped: interpolates
// linearly between MIN_S at a small/cramped viewport and MAX_S at a spacious one,
// using whichever of width/height is more constrained (so a wide-but-short window
// and a narrow-but-tall window both scale down correctly, not just one axis).
// This is the DEFAULT and stays live — see maybeReapplyAutoScale() below — unless
// the person picks a fixed percentage from the theme panel, which pins it.
const UI_SCALE_RANGE = { minW:1265, maxW:2545, minH:570, maxH:1305, minS:0.8, maxS:1.0 };
function autoScaleForViewport(w,h){
  const {minW,maxW,minH,maxH,minS,maxS}=UI_SCALE_RANGE;
  const clamp01=x=>Math.max(0,Math.min(1,x));
  const tw=clamp01((w-minW)/(maxW-minW)), th=clamp01((h-minH)/(maxH-minH));
  const t=Math.min(tw,th);   // the more cramped dimension decides
  return minS + t*(maxS-minS);
}
function isUiScaleAuto(){
  const v=parseFloat(localStorage.getItem('mindspark:uiScale'));
  return !(v && v>=0.5 && v<=2);
}
function getUiScale(){
  const v=parseFloat(localStorage.getItem('mindspark:uiScale'));
  if(v && v>=0.5 && v<=2) return v;                                   // explicit choice, pinned
  return autoScaleForViewport(window.innerWidth, window.innerHeight);  // auto: tracks the current viewport
}
function uiScaleBootCss(z, _wk){
  if(!(z && Math.abs(z-1)>0.001)) return '';
  return ':root{--ui-zoom:'+z+'}';
}
function applyUiScale(v){
  const z = (v && v>=0.5 && v<=2) ? v : 1;
  document.documentElement.style.zoom = '';
  document.documentElement.style.setProperty('--ui-zoom', String(z));
  const app=document.querySelector('.app');
  if(app){
    app.style.zoom = '';
    app.style.transformOrigin = '';
    app.style.transform = '';
    app.style.width = '';
    app.style.height = '';
  }
  const boot=document.getElementById('ui-zoom-boot');
  if(boot) boot.textContent = uiScaleBootCss(z);
  // Sidebar width follows --ui-zoom, so the stage got a new CSS-pixel size —
  // keep the centred map point centred, same as a window resize.
  if(typeof stage!=='undefined' && stage) _recenterForStageChange();
  if(typeof updateMinimap==='function' && map) updateMinimap();
}
function setUiScale(v){
  v = Math.min(2, Math.max(0.5, v||1));
  try{ localStorage.setItem('mindspark:uiScale', String(v)); }catch(e){}
  applyUiScale(v);
  toast(rmsTf('tUiScale','Interface scale: %s%', Math.round(v*100)));
}
function setUiScaleAuto(){
  try{ localStorage.removeItem('mindspark:uiScale'); }catch(e){}
  applyUiScale(getUiScale());
  toast(rmsTf('tUiScaleAuto','Interface scale: Auto (%s%)', Math.round(getUiScale()*100)));
}
// Keeps auto-scale genuinely responsive to the browser window instead of a
// snapshot frozen at whichever size the page happened to load at. Only acts
// while no explicit percentage is pinned, and only re-applies when the computed
// value actually moved (so it doesn't fight a mid-drag node resize/pan with
// zoom recalculation on every pixel of a window drag).
let _uiScaleResizeT=0;
window.addEventListener('resize', ()=>{
  clearTimeout(_uiScaleResizeT);
  _uiScaleResizeT=setTimeout(()=>{
    if(!isUiScaleAuto()) return;
    applyUiScale(getUiScale());
  }, 150);
});

/* ---------- Themes ---------- */
const THEMES = [
  {id:'light',           name:'Light',           swatch:['#f4efe6','#ffffff','#e0613a']},
  {id:'dark',            name:'Dark',            swatch:['#1e1e1e','#2d2d2d','#3794ff']},
  {id:'light-owl',       name:'Light Owl',       swatch:['#fbfbfb','#ffffff','#2aa298']},
  {id:'night-owl',       name:'Night Owl',       swatch:['#011627','#0b2942','#7e57c2']},
  {id:'catppuccin-light', name:'Catppuccin<br>Light', swatch:['#eff1f5','#e6e9ef','#8839ef']},
  {id:'catppuccin-dark',  name:'Catppuccin<br>Dark',  swatch:['#1e1e2e','#181825','#cba6f7']},
  {id:'rose-pine-moon',  name:'Rosé Pine<br>Moon',  swatch:['#232136','#393552','#c4a7e7']},
  {id:'rose-pine-dawn',  name:'Rosé Pine<br>Dawn',  swatch:['#faf4ed','#fffaf3','#907aa9']},
  {id:'github-light',    name:'GitHub Light',    swatch:['#ffffff','#f6f8fa','#0969da']},
  {id:'github-dark',     name:'GitHub Dark',     swatch:['#0d1117','#161b22','#58a6ff']},
  {id:'dracula',         name:'Dracula',         swatch:['#282a36','#44475a','#ff79c6']},
  {id:'nord',            name:'Nord',            swatch:['#2e3440','#434c5e','#88c0d0']}
];
// Shown in their own dedicated panel section, not mixed into the regular
// colour-theme grid above. Deliberately a different kind of thing from
// THEMES/MAP_STYLES — font + non-node chrome texture only, independent of
// both color (still controlled by whichever Colour Theme is active) and
// card/branch shape (still controlled by whichever Map Style is active).
// 'office' is the implicit default, same pattern as 'light' for themes —
// achieved by absence of the data-look attribute, not its own CSS block.
// Names are written to complete "I am ___" (the section's own label) —
// "I am in the Office" / "I am at Coffee Shop" / "I am back to School".
const LOOKS = [
  {id:'office',      name:'in the<br>Office',  font:'inherit'},
  {id:'coffee-shop', name:'at Coffee<br>Shop', font:'"PingFang SC",sans-serif'},
  {id:'handwritten', name:'back to<br>School', font:'"PingFang SC",sans-serif'}
];
const MAP_STYLES = [
  {id:'modern',  name:'Modern',  desc:'Soft cards, curved branches',      nameKey:'styleModern',  descKey:'styleModernDesc'},
  {id:'classic', name:'Classic', desc:'Rectangles, right-angle branches', nameKey:'styleClassic', descKey:'styleClassicDesc'},
  {id:'bubble',  name:'Bubble',  desc:'Pill cards, thick curves',         nameKey:'styleBubble',  descKey:'styleBubbleDesc'},
  {id:'sketch',  name:'Sketch',  desc:'Outlined cards, straight lines',   nameKey:'styleSketch',  descKey:'styleSketchDesc'}
];
/* ------------------------------------------------------------
   Layout presets.

   A preset SELECTS AND PARAMETERISES one of the placement engines this app
   implements — it does not define a new algorithm. That distinction is the
   whole design: 'balanced' keeps each child on whichever side it already had,
   'down' does org-chart width packing, 'timeline' chains an axis. Those are
   recursive procedures, not numbers, and the only way JSON could express them
   is by shipping executable code — which would then arrive inside every
   imported map file. So an imported layout picks an engine and tunes
   it, and every built-in below is written in exactly the schema an import must
   use, so there is no privileged path.

   Applying a preset writes map.layout (the engine) and map.layoutConfig (its
   options). Both travel with the map, so an exported map renders correctly for
   someone who has never seen the preset — only the picker entry is local.
   ------------------------------------------------------------ */
/* ------------------------------------------------------------
   Layout strategies and their parameters.

   Steps 1-3 established that every layout this app draws is one of four
   placement STRATEGIES with different numbers. This exposes those numbers, so
   a layout can be written as JSON rather than code — which is what makes a
   shared library of layouts possible without shipping executable plugins.

   Each strategy declares its parameters: enums list their allowed values,
   pairs are numeric [min,max]. Anything not listed here cannot be set, so a
   preset can only ever reach knobs the engines actually read.
   ------------------------------------------------------------ */
const LAYOUT_PARAMS = {
  tree: {
    axis:['x','y'], dir:[-1,1], split:['balanced','one-side'],
    rootAnchor:['origin','centered'],
    gapMain:[8,400], gapCross:[4,300],
  },
  chain: {
    axis:['x','y'], dir:[-1,1], start:['above','below'], alternate:'boolean',
    gap:[8,400], stem:[0,300], indent:[0,300], gapMain:[8,400], gapCross:[4,300],
    angle:[10,170],
  },
  radial: { ring:[60,600], startAngle:[-360,360], sweep:[30,360] },
  matrix: { colGap:[8,300], rowGap:[8,300], cellGap:[0,120], headGap:[8,300] },
  grid:   { columns:[1,8], gapX:[8,300], gapY:[8,300], rowGap:[0,120], indent:[0,120] },
};
// The built-in layouts, now expressed as strategy + parameters. These are the
// same values steps 1-3 verified against captured output, so naming a built-in
// engine and spelling out its parameters are two ways of saying one thing.
const ENGINE_PARAMS = {
  balanced:{ strategy:'tree',  params:{ axis:'x', dir: 1, split:'balanced', rootAnchor:'origin',   gapMain:70, gapCross:22 } },
  right:   { strategy:'tree',  params:{ axis:'x', dir: 1, split:'one-side', rootAnchor:'origin',   gapMain:70, gapCross:22 } },
  left:    { strategy:'tree',  params:{ axis:'x', dir:-1, split:'one-side', rootAnchor:'origin',   gapMain:70, gapCross:22 } },
  down:    { strategy:'tree',  params:{ axis:'y', dir: 1, split:'one-side', rootAnchor:'centered', sideName:'down', gapMain:22, gapCross:70 } },
  timeline:{ strategy:'chain', params:{ axis:'x', dir: 1, gap:70, stem:30, indent:26, alternate:true, start:'above', gapMain:70, gapCross:22 } },
  radial:  { strategy:'radial',params:{ ring:180, startAngle:-90, sweep:360 } },
  grid:    { strategy:'grid',  params:{ columns:3, gapX:60, gapY:60, rowGap:14, indent:24 } },
  matrix:  { strategy:'matrix',params:{ colGap:40, rowGap:24, cellGap:10, headGap:60 } },
  fishbone:{ strategy:'chain', params:{ axis:'x', dir:1, gap:70, stem:30, indent:26,
                                        alternate:true, start:'above', angle:35,
                                        gapMain:70, gapCross:22 } },
};

// Keeps only parameters the strategy declares, each within its allowed values.
// Unlike validateLayoutPreset() this REPAIRS rather than rejects: params arrive
// alongside a preset that is otherwise valid, so a single bad number should not
// discard the whole layout.
function validateLayoutParams(strategy, raw){
  const schema = LAYOUT_PARAMS[strategy];
  if(!schema) return {};
  const out = {};
  if(!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for(const [key, rule] of Object.entries(schema)){
    const v = raw[key];
    if(v === undefined) continue;
    if(rule === 'boolean'){ if(typeof v === 'boolean') out[key] = v; continue; }
    if(Array.isArray(rule) && typeof rule[0] === 'string'){ if(rule.includes(v)) out[key] = v; continue; }
    if(Array.isArray(rule)){
      if(typeof v !== 'number' || !isFinite(v)) continue;   // never coerce
      out[key] = Math.min(rule[1], Math.max(rule[0], Math.round(v)));
    }
  }
  return out;
}

// What autoLayout actually runs: a strategy plus a complete parameter set.
// Accepts a built-in engine name, a strategy name, or neither, and always
// returns something runnable — an unopenable map is never the right answer to
// a bad layout name.
function resolveLayout(name, params){
  const byEngine = ENGINE_PARAMS[name];
  const strategy = byEngine ? byEngine.strategy : (LAYOUT_PARAMS[name] ? name : 'tree');
  const base = byEngine ? byEngine.params : ENGINE_PARAMS.balanced.params;
  return { strategy, params: { ...base, ...validateLayoutParams(strategy, params) } };
}

const LAYOUT_ENGINES = ['balanced','right','left','down','timeline','radial','grid','matrix','fishbone'];
const BUILTIN_LAYOUTS = [
  {v:1, id:'balanced', name:'Balanced', desc:'Branches split left & right', engine:'balanced'},
  {v:1, id:'right',    name:'Right',    desc:'All branches grow right',     engine:'right'},
  {v:1, id:'left',     name:'Left',     desc:'All branches grow left',      engine:'left'},
  {v:1, id:'down',     name:'Down',     desc:'Org-chart, top to bottom',    engine:'down'},
  {v:1, id:'timeline', name:'Timeline', desc:'Sequence along an axis, sub-topics alternating',
        engine:'timeline'},
  {v:1, id:'radial',   name:'Radial',   desc:'Root at the centre, branches on rings', engine:'radial'},
  {v:1, id:'grid',     name:'Grid',     desc:'Top-level topics as cards, sub-topics as outlines',
        engine:'grid'},
  {v:1, id:'matrix',   name:'Matrix',   desc:'Columns and aligned rows, read like a table', engine:'matrix'},
  {v:1, id:'fishbone', name:'Fishbone', desc:'Spine with angled ribs, for cause-and-effect', engine:'fishbone'},
];
const CUSTOM_LAYOUTS_KEY = 'mindspark:layouts';

// A preset is per-device (localStorage), not per-map: it is a picker entry.
function loadCustomLayouts(){
  try{
    const raw = JSON.parse(localStorage.getItem(CUSTOM_LAYOUTS_KEY) || '[]');
    if(!Array.isArray(raw)) return [];
    return raw.map(validateLayoutPreset).filter(Boolean);
  }catch(e){ console.warn('could not read saved layouts:', e.message); return []; }
}
function saveCustomLayouts(list){
  try{ localStorage.setItem(CUSTOM_LAYOUTS_KEY, JSON.stringify(list)); return true; }
  catch(e){ console.warn('could not save layouts:', e.message); return false; }
}
function allLayouts(){ return BUILTIN_LAYOUTS.concat(loadCustomLayouts()); }
function findLayout(id){ return allLayouts().find(l=>l.id===id) || null; }

// Returns a clean preset, or null if it cannot be one. Null rather than
// defaults on purpose: a preset the user is importing should be REJECTED with
// a reason, not silently turned into something they did not ask for.
function validateLayoutPreset(raw){
  if(!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  // Either form is accepted: an engine name (shorthand for a built-in's
  // parameters) or a strategy with explicit params. A preset must name one.
  const hasEngine = LAYOUT_ENGINES.includes(raw.engine);
  const hasStrategy = typeof raw.strategy === 'string' && !!LAYOUT_PARAMS[raw.strategy];
  if(!hasEngine && !hasStrategy) return null;
  const id = typeof raw.id === 'string' ? raw.id.trim().slice(0,40) : '';
  const name = typeof raw.name === 'string' ? raw.name.trim().slice(0,24) : '';
  if(!/^[a-z0-9][a-z0-9-]*$/i.test(id) || !name) return null;
  const out = { v:1, id, name };
  if(hasEngine) out.engine = raw.engine;
  if(hasStrategy){
    out.strategy = raw.strategy;
    out.params = validateLayoutParams(raw.strategy, raw.params);
  } else if(raw.params){
    // Params given against an engine name: validate under that engine's strategy.
    out.params = validateLayoutParams(ENGINE_PARAMS[raw.engine].strategy, raw.params);
  }
  if(typeof raw.desc === 'string' && raw.desc.trim()) out.desc = raw.desc.trim().slice(0,80);
  // Options reuse the layout-config validator, so bounds live in one place.
  if(raw.options && typeof raw.options === 'object' && !Array.isArray(raw.options)){
    out.options = validateLayoutConfig(raw.options);
  }
  return out;
}

function applyTheme(id){
  opLog('theme', {theme:id||'light'});
  if(id && id!=='light') document.documentElement.setAttribute('data-theme', id);
  else document.documentElement.removeAttribute('data-theme');
  try{ localStorage.setItem('mindspark:theme', id||'light'); }catch(e){}
  // Colour theme doesn't change node size today, but re-render anyway rather
  // than assume that stays true forever — cheap, and matches applyLook below.
  if(map) render();
}
// "Look and feel" (Back to School, etc.) is font + chrome texture only —
// entirely CSS-driven (see :root[data-look=...] rules), so unlike the old
// isHandwrittenTheme() this needs no JS-side helper at all. Independent of
// applyTheme() (colors) and applyMapStyle() (card/branch shape) — all three
// are separate attributes that never override each other.
function applyLook(id){
  opLog('look', {look:id||'office'});
  if(id && id!=='office') document.documentElement.setAttribute('data-look', id);
  else document.documentElement.removeAttribute('data-look');
  try{ localStorage.setItem('mindspark:look', id||'office'); }catch(e){}
  // Two things need to happen here, not just a re-render:
  // 1) Web fonts load asynchronously — the very first time Caveat/Patrick
  //    Hand gets used in a session, the font file may still be downloading
  //    at the exact moment this render() runs synchronously below. The
  //    browser then measures nodes against a FALLBACK font's metrics, and
  //    once the real font actually finishes loading, silently swaps it in
  //    and resizes the node text — with nothing re-measuring on its own,
  //    since it's a browser-internal event this code otherwise never reacts
  //    to. Explicitly wait for the specific font this look uses, then
  //    re-render once it's genuinely ready, to catch whatever the first
  //    render() got wrong.
  // 2) A look's larger font-size can make a node grow taller than it was
  //    (nodes are width:max-content, and min-height is now a floor, not a
  //    cap — see the node rendering code). Sibling positions were computed
  //    for the OLD, smaller sizes, and nothing moves them just because a
  //    node above/beside them grew in place — so a taller node can start
  //    overlapping its neighbour. autoLayout() re-tidies based on current
  //    sizes, the same way it already runs after a manual resize-drag. It
  //    needs the explicit render() right before it, not just to run alone:
  //    autoLayout() only force-remeasures nodes with NO measurement yet,
  //    not ones with a stale measurement from before the font changed, so
  //    without this render() first it would compute positions from
  //    outdated sizes.
  if(map){ render(); autoLayout(); }
  const look=LOOKS.find(l=>l.id===id);
  if(look && look.font && look.font!=='inherit' && document.fonts && document.fonts.load){
    const fontName = look.font.split(',')[0];   // '"Caveat"' from '"Caveat",cursive' — the
                                                  // actual web font; the rest is just a
                                                  // fallback keyword that needs no loading
    document.fonts.load('1em '+fontName).then(()=>{ if(map){ render(); autoLayout(); } }).catch(()=>{});
  }
}
function applyMapStyle(id){
  if(!map) return;
  opLog('style', {theme:id});
  map.style = id;
  pushHistory(); render();
}
function applyMapLayout(id){
  if(!map) return;
  opLog('layout', {layout:id});
  // A preset id resolves to an engine plus options; both are written onto the
  // map so it stays portable for anyone who does not have this preset.
  const preset = findLayout(id);
  if(preset){
    map.layout = preset.engine;
    // Only a preset that actually carries options may replace the map's
    // settings. This used to `delete map.layoutConfig` otherwise, so simply
    // clicking the current layout again threw away everything the user had
    // set in the gear dialog.
    if(preset.options) map.layoutConfig = preset.options;
    // Structural params travel with the map, so a preset the recipient does
    // not have still renders the way its author intended.
    if(preset.params && Object.keys(preset.params).length) map.layoutParams = preset.params;
    else delete map.layoutParams;
    if(preset.strategy && !preset.engine) map.layout = preset.strategy;
    if(preset.id !== preset.engine) map.layoutPreset = preset.id; else delete map.layoutPreset;
  } else {
    map.layout = id;
    delete map.layoutPreset;
  }
  // Explicitly choosing a layout must re-assign the root children's sides so the
  // change actually takes effect (autoLayout's stable balanced mode otherwise
  // preserves a prior 'right' layout's sides and the map stays right-aligned).
  withChildIndex(()=>{
    if(id==='balanced') balanceRootSides();
    else if(id==='right') childrenOf(map.rootId).forEach(k=>{ map.nodes[k].side='right'; });
    else if(id==='left') childrenOf(map.rootId).forEach(k=>{ map.nodes[k].side='left'; });
  });
  pushHistory(); autoLayout(); fit();
}

let themePanel=null;
function closeThemePanel(){ if(themePanel){ themePanel.remove(); themePanel=null; } }
function buildSwatchHTML(t){
  return `<span class="theme-thumb" style="background:${t.swatch[0]}">
            <span class="t1" style="background:${t.swatch[1]}"></span>
            <span class="t2" style="background:${t.swatch[2]}"></span>
          </span>`;
}
function buildLookThumb(l){
  return `<span class="theme-thumb look-thumb" style="font-family:${l.font}">Aa</span>`;
}
function buildStyleThumb(id){
  // Small SVG preview showing two nodes + the branch style
  let path;
  if(id==='classic') path='M30,30 L45,30 L45,12 L60,12 M30,30 L45,30 L45,48 L60,48';
  else if(id==='sketch') path='M30,30 L60,12 M30,30 L60,48';
  else path='M30,30 C40,30 50,12 60,12 M30,30 C40,30 50,48 60,48';
  const radius = id==='bubble'? 8 : id==='classic'? 2 : id==='sketch'? 2 : 4;
  const stroke = id==='bubble'? 2.2 : 1.4;
  return `<span class="style-thumb">
    <svg viewBox="0 0 70 60" width="70" height="40">
      <rect x="12" y="22" width="22" height="16" rx="${radius}" fill="var(--accent)"/>
      <rect x="56" y="6"  width="14" height="12" rx="${radius}" fill="var(--node-bg,#fff)" stroke="var(--line)"/>
      <rect x="56" y="42" width="14" height="12" rx="${radius}" fill="var(--node-bg,#fff)" stroke="var(--line)"/>
      <path d="${path}" fill="none" stroke="var(--ink-soft)" stroke-width="${stroke}"/>
    </svg>
  </span>`;
}
function buildLayoutThumb(id){
  let svg;
  if(id==='radial') return `<span class="style-thumb"><svg viewBox="0 0 70 60" width="70" height="40">
    <path d="M35,30 L35,12 M35,30 L52,40 M35,30 L18,40" fill="none" stroke="var(--ink-soft)" stroke-width="1.2"/>
    <circle cx="35" cy="30" r="7" fill="var(--accent)"/>
    <circle cx="35" cy="10" r="5" fill="var(--node-bg,#fff)" stroke="var(--line)"/>
    <circle cx="54" cy="42" r="5" fill="var(--node-bg,#fff)" stroke="var(--line)"/>
    <circle cx="16" cy="42" r="5" fill="var(--node-bg,#fff)" stroke="var(--line)"/>
  </svg></span>`;
  if(id==='grid') return `<span class="style-thumb"><svg viewBox="0 0 70 60" width="70" height="40">
    <rect x="27" y="4" width="16" height="9" rx="2" fill="var(--accent)"/>
    <rect x="6"  y="20" width="26" height="15" rx="2" fill="var(--node-bg,#fff)" stroke="var(--line)"/>
    <rect x="38" y="20" width="26" height="15" rx="2" fill="var(--node-bg,#fff)" stroke="var(--line)"/>
    <rect x="6"  y="40" width="26" height="15" rx="2" fill="var(--node-bg,#fff)" stroke="var(--line)"/>
    <rect x="38" y="40" width="26" height="15" rx="2" fill="var(--node-bg,#fff)" stroke="var(--line)"/>
  </svg></span>`;
  if(id==='timeline') return `<span class="style-thumb"><svg viewBox="0 0 70 60" width="70" height="40">
    <path d="M10,30 L62,30" fill="none" stroke="var(--ink-soft)" stroke-width="1.2"/>
    <path d="M26,30 L26,16 L34,16 M46,30 L46,44 L54,44" fill="none" stroke="var(--ink-soft)" stroke-width="1.2"/>
    <rect x="4"  y="24" width="10" height="12" rx="2" fill="var(--accent)"/>
    <rect x="20" y="25" width="12" height="10" rx="2" fill="var(--node-bg,#fff)" stroke="var(--line)"/>
    <rect x="40" y="25" width="12" height="10" rx="2" fill="var(--node-bg,#fff)" stroke="var(--line)"/>
    <rect x="34" y="12" width="12" height="8" rx="2" fill="var(--node-bg,#fff)" stroke="var(--line)"/>
    <rect x="54" y="40" width="12" height="8" rx="2" fill="var(--node-bg,#fff)" stroke="var(--line)"/>
  </svg></span>`;
  if(id==='down') svg=`<svg viewBox="0 0 70 60" width="70" height="40">
    <rect x="28" y="6"  width="14" height="10" rx="2" fill="var(--accent)"/>
    <rect x="8"  y="36" width="14" height="10" rx="2" fill="var(--node-bg,#fff)" stroke="var(--line)"/>
    <rect x="28" y="36" width="14" height="10" rx="2" fill="var(--node-bg,#fff)" stroke="var(--line)"/>
    <rect x="48" y="36" width="14" height="10" rx="2" fill="var(--node-bg,#fff)" stroke="var(--line)"/>
    <path d="M35,16 L35,26 L15,26 L15,36 M35,26 L35,36 M35,26 L55,26 L55,36" fill="none" stroke="var(--ink-soft)" stroke-width="1.2"/>
  </svg>`;
  else if(id==='left') svg=`<svg viewBox="0 0 70 60" width="70" height="40">
    <rect x="50" y="22" width="14" height="12" rx="2" fill="var(--accent)"/>
    <rect x="6"  y="6"  width="16" height="10" rx="2" fill="var(--node-bg,#fff)" stroke="var(--line)"/>
    <rect x="6"  y="22" width="16" height="10" rx="2" fill="var(--node-bg,#fff)" stroke="var(--line)"/>
    <rect x="6"  y="38" width="16" height="10" rx="2" fill="var(--node-bg,#fff)" stroke="var(--line)"/>
    <path d="M50,28 C38,28 30,11 22,11 M50,28 L22,27 M50,28 C38,28 30,43 22,43" fill="none" stroke="var(--ink-soft)" stroke-width="1.2"/>
  </svg>`;
  else if(id==='right') svg=`<svg viewBox="0 0 70 60" width="70" height="40">
    <rect x="6"  y="22" width="14" height="12" rx="2" fill="var(--accent)"/>
    <rect x="48" y="6"  width="16" height="10" rx="2" fill="var(--node-bg,#fff)" stroke="var(--line)"/>
    <rect x="48" y="22" width="16" height="10" rx="2" fill="var(--node-bg,#fff)" stroke="var(--line)"/>
    <rect x="48" y="38" width="16" height="10" rx="2" fill="var(--node-bg,#fff)" stroke="var(--line)"/>
    <path d="M20,28 C32,28 40,11 48,11 M20,28 L48,27 M20,28 C32,28 40,43 48,43" fill="none" stroke="var(--ink-soft)" stroke-width="1.2"/>
  </svg>`;
  else svg=`<svg viewBox="0 0 70 60" width="70" height="40">
    <rect x="28" y="22" width="14" height="12" rx="2" fill="var(--accent)"/>
    <rect x="2"  y="8"  width="14" height="10" rx="2" fill="var(--node-bg,#fff)" stroke="var(--line)"/>
    <rect x="2"  y="38" width="14" height="10" rx="2" fill="var(--node-bg,#fff)" stroke="var(--line)"/>
    <rect x="52" y="8"  width="14" height="10" rx="2" fill="var(--node-bg,#fff)" stroke="var(--line)"/>
    <rect x="52" y="38" width="14" height="10" rx="2" fill="var(--node-bg,#fff)" stroke="var(--line)"/>
    <path d="M28,28 C22,28 22,13 16,13 M28,28 C22,28 22,43 16,43 M42,28 C48,28 48,13 52,13 M42,28 C48,28 48,43 52,43" fill="none" stroke="var(--ink-soft)" stroke-width="1.2"/>
  </svg>`;
  return `<span class="style-thumb">${svg}</span>`;
}

$('#varsBtn')?.addEventListener('click', showMapVariables);
$('#themeBtn').onclick=(e)=>{
  e.stopPropagation();
  if(themePanel){ closeThemePanel(); return; }
  closeAllMenus();
  const curTheme  = document.documentElement.getAttribute('data-theme') || 'light';
  const curLook   = document.documentElement.getAttribute('data-look')  || 'office';
  const curStyle  = (map && map.style)  || 'modern';
  const curLayout = (map && (map.layoutPreset || map.layout)) || 'balanced';
  themePanel=document.createElement('div');
  themePanel.className='theme-panel theme-panel-large';
  themePanel.innerHTML = `
    <div class="tp-section">
      <div class="tp-label">${rmsTr('themeColour','Colour theme')}</div>
      <div class="tp-grid">
        ${THEMES.map(t=>`
          <button class="theme-opt${t.id===curTheme?' active':''}" data-cat="theme" data-id="${t.id}">
            ${buildSwatchHTML(t)}<span class="theme-name">${rmsTr('themeName_'+t.id, t.name)}</span>
          </button>`).join('')}
      </div>
    </div>
    <div class="tp-section tp-section-special">
      <div class="tp-label">${rmsTr('themeLook','I am')}</div>
      <div class="tp-grid">
        ${LOOKS.map(l=>`
          <button class="theme-opt${l.id===curLook?' active':''}" data-cat="look" data-id="${l.id}">
            ${buildLookThumb(l)}<span class="theme-name">${({office:rmsTr('lookOffice',l.name),'coffee-shop':rmsTr('lookCoffee',l.name),handwritten:rmsTr('lookSchool',l.name)}[l.id]||l.name)}</span>
          </button>`).join('')}
      </div>
    </div>
    <div class="tp-section">
      <div class="tp-label">${rmsTr('themeStyle','Map style')}</div>
      <div class="tp-grid">
        ${MAP_STYLES.map(s=>`
          <button class="theme-opt${s.id===curStyle?' active':''}" data-cat="style" data-id="${s.id}" title="${rmsTh(s.descKey, s.desc)}">
            ${buildStyleThumb(s.id)}<span class="theme-name">${rmsTh(s.nameKey, s.name)}</span>
          </button>`).join('')}
      </div>
    </div>
    <div class="tp-section">
      <div class="tp-label">${rmsTr('themeLayout','Layout')}
        <button class="tp-cog" title="${rmsTr('themeLayoutJson','Layout settings (JSON)')}">\u2699</button>
      </div>
      <div class="tp-grid tp-scroll-row">
        ${allLayouts().map(l=>`
          <button class="theme-opt${l.id===curLayout?' active':''}" data-cat="layout" data-id="${escapeHtml(l.id)}" title="${escapeHtml(layoutDesc(l))}">
            ${buildLayoutThumb(l.id)}<span class="theme-name">${escapeHtml(layoutName(l))}</span>
          </button>`).join('')}
      </div>
    </div>
    <div class="tp-section">
      <div class="tp-label">${rmsTr('themeLayoutPresets','Layout presets')}</div>
      <div class="tp-grid tp-scroll-row tp-preset-row"><span class="tp-hint tp-preset-msg">${rmsTr('layoutPresetsLoading','Loading\u2026')}</span></div>
    </div>
    <div class="tp-section">
      <div class="tp-label">${rmsTr('themeSize','Display size')} <span class="tp-hint">${rmsTr('themeSizeHint','scales the whole interface')}</span></div>
      <div class="tp-scale">
        <button class="scale-opt${isUiScaleAuto()?' active':''}" data-scale="auto">${rmsTr('themeAuto','Auto')}</button>
        ${[80,90,100,110,125].map(p=>`
          <button class="scale-opt${(!isUiScaleAuto() && p===Math.round(getUiScale()*100))?' active':''}" data-scale="${p}">${p}%</button>`).join('')}
      </div>
    </div>`;
  document.body.appendChild(themePanel);
  positionPopup(themePanel, $('#themeBtn'), {align:'right'});
  themePanel.addEventListener('mousedown',ev=>ev.stopPropagation());

  // A horizontally scrolling row keeps the panel from growing a whole extra
  // line for one more layout, but scrolling sideways is easy to miss: most
  // mice have no horizontal wheel, so without help an option parked off-screen
  // is effectively invisible. Three affordances make it discoverable:
  //   - edge fades, shown only on the side that actually has more to reveal
  //   - a normal (vertical) wheel scrolls the row while the pointer is over it
  //   - the active option is scrolled into view when the panel opens
  // The cog is not a .theme-opt, so it is wired separately rather than going
  // through the category dispatch below.
  const cog = themePanel.querySelector('.tp-cog');
  if(cog) cog.onclick = ev => { ev.stopPropagation(); closeThemePanel(); showLayoutConfigForm(); };
  fillLayoutPresetRow(themePanel, curLayout);

  themePanel.querySelectorAll('.tp-scroll-row').forEach(row=>{
    const sync=()=>{
      const max = row.scrollWidth - row.clientWidth;
      row.classList.toggle('has-more-right', max > 1 && row.scrollLeft < max - 1);
      row.classList.toggle('has-more-left',  max > 1 && row.scrollLeft > 1);
    };
    row.addEventListener('scroll', sync, {passive:true});
    row.addEventListener('wheel', ev=>{
      // Only hijack a purely vertical wheel; a trackpad's horizontal gesture
      // already works and must not be doubled.
      if(Math.abs(ev.deltaY) <= Math.abs(ev.deltaX)) return;
      const max = row.scrollWidth - row.clientWidth;
      if(max <= 1) return;
      // Hand the wheel back to the panel once this row can go no further,
      // otherwise the pointer resting here would trap vertical scrolling.
      if((ev.deltaY < 0 && row.scrollLeft <= 0) || (ev.deltaY > 0 && row.scrollLeft >= max - 1)) return;
      ev.preventDefault();
      row.scrollLeft += ev.deltaY;
    }, {passive:false});
    // Reveal the current selection rather than always starting at the left.
    const act = row.querySelector('.theme-opt.active');
    if(act) act.scrollIntoView({block:'nearest', inline:'nearest'});
    requestAnimationFrame(sync);
  });
  themePanel.querySelectorAll('.theme-opt').forEach(opt=>{
    opt.onclick=ev=>{
      ev.stopPropagation();
      const cat=opt.dataset.cat, id=opt.dataset.id;
      if(cat==='theme') applyTheme(id);
      else if(cat==='look') applyLook(id);
      else if(cat==='style') applyMapStyle(id);
      else if(cat==='layout') applyMapLayout(id);
      // Clear active state across every section sharing this category, not
      // just the clicked button's own section (opt.closest('.tp-section')).
      // Each category lives in exactly one section again now that 'look' is
      // its own category rather than sharing 'theme' — but scoping by
      // data-cat across the whole panel is the more general, robust
      // approach regardless of how many sections a category happens to span.
      const sameCat = cat==='layout' ? '.theme-opt[data-cat="layout"], .theme-opt[data-cat="layout-preset"]' : `.theme-opt[data-cat="${cat}"]`;
      themePanel.querySelectorAll(sameCat).forEach(o=>o.classList.remove('active'));
      opt.classList.add('active');
    };
  });
  themePanel.querySelectorAll('.scale-opt').forEach(opt=>{
    opt.onclick=ev=>{
      ev.stopPropagation();
      if(opt.dataset.scale==='auto') setUiScaleAuto();
      else setUiScale(parseInt(opt.dataset.scale,10)/100);
      themePanel.querySelectorAll('.scale-opt').forEach(o=>o.classList.remove('active'));
      opt.classList.add('active');
      // Display-size density just changed, so the panel's previous fixed
      // position may no longer sit on the theme button. Reposition now and
      // once more after layout settles.
      const reposition=()=>{
        if(!document.body.contains(themePanel)) return;
        positionPopup(themePanel, $('#themeBtn'), {align:'right'});
      };
      reposition();
      requestAnimationFrame(()=>requestAnimationFrame(reposition));
    };
  });
};
document.addEventListener('click',e=>{
  if(themePanel && !themePanel.contains(e.target) && e.target.id!=='themeBtn') closeThemePanel();
});
// Apply saved theme at boot. For first-time visitors, follow the OS preference
// (prefers-color-scheme) so dark-mode users get dark by default.
try{
  let saved = localStorage.getItem('mindspark:theme');
  const RETIRED_THEMES = {'solarized-dark':'github-dark', 'solarized-light':'github-light', 'monokai':'catppuccin-dark', 'catppuccin':'catppuccin-dark'};   // replaced themes
  if(saved==='handwritten'){
    // Pre-refactor save: 'handwritten' used to be a data-theme value. Migrate
    // intent rather than silently dropping it — falls back to a real color
    // theme, and separately turns on the new Back to School look. Only sets
    // the localStorage key here, doesn't call applyLook() directly — that
    // happens once, below, as the single source of truth for applying the
    // look at boot (calling it here too would double-apply it: two renders,
    // two duplicate font-load requests, since applyLook() sets this same
    // key as a side effect and the line below reads it right back).
    saved=null;
    try{ localStorage.setItem('mindspark:look', 'handwritten'); }catch(e){}
  }
  if(saved && RETIRED_THEMES[saved]){ saved=RETIRED_THEMES[saved]; try{ localStorage.setItem('mindspark:theme', saved); }catch(e){} }
  if(saved) applyTheme(saved);
  else applyTheme(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
}catch(e){}
try{ applyLook(localStorage.getItem('mindspark:look') || 'office'); }catch(e){}

applyView();

// ===== Focus mode — hide all chrome, show only the canvas =====
function toggleFocusMode(){
  const on = !document.body.classList.contains('focus-mode');
  document.body.classList.toggle('focus-mode', on);
  let exit = $('#focusExit');
  if(on){
    if(!exit){
      exit = document.createElement('button');
      exit.id = 'focusExit'; exit.className = 'focus-exit';
      exit.innerHTML = '⛶ '+rmsTr('focusExit','Exit focus');
      exit.title = rmsTr('focusExitTitle','Exit focus mode (Esc)');
      exit.onclick = toggleFocusMode;
      document.body.appendChild(exit);
    }
    toast(rmsTr('focusToast','Focus mode — Esc to exit'));
  } else {
    exit?.remove();
  }
  // The viewport size changes when chrome is shown/hidden — wait for the layout
  // to settle, then smoothly animate the map back to centred (keeping zoom) so it
  // doesn't just jump sideways.
  requestAnimationFrame(()=>requestAnimationFrame(()=>animateViewTo(computeRecenterView(), 220)));
}
$('#focusBtn')?.addEventListener('click', toggleFocusMode);

// ===== Keyboard shortcuts help — press '?' to open =====
// Key column for rebindable actions comes from the current chord (Settings).
function helpChordLabel(id, fallback){
  const label=(typeof window!=='undefined' && window.rmsChordLabel && id) ? window.rmsChordLabel(id) : '';
  if(id==='help' && (!label || label==='⇧ /')) return '?';
  return label || fallback;
}
function keyboardHelpRows(tr){
  const ch=helpChordLabel;
  const or=(...xs)=>xs.filter(Boolean).join(' / ');
  return [
    [tr('kbBuilding','Building the map'),[
      [ch('addChild','Tab'),              tr('kbAddChild','Add a child node')],
      [ch('addSibling','Enter'),          tr('kbAddSibling','Add a sibling node')],
      [ch('addSiblingMod','⌘ ↩'),         tr('kbAddSiblingMod','Add a sibling node')],
      [ch('moveSiblingUp','⌥ ↑')+' / '+ch('moveSiblingDown','⌥ ↓'), tr('kbMoveSibling','Move / swap sibling node up / down')],
      [ch('moveSiblingUpAlt','⇧ ⌘ ↑')+' / '+ch('moveSiblingDownAlt','⇧ ⌘ ↓'), tr('kbMoveSiblingAlt','Same, if Option is taken by the OS')],
      [or(ch('editNode','F2'), tr('kbGDblClick','double-click')), tr('kbEdit','Edit the selected node')],
      [or(ch('deleteNode','⌫'), ch('deleteForward','⌦')), tr('kbRemove','Remove the selected node')],
      [ch('collapse',tr('keySpace','Space')),            tr('kbCollapse','Collapse / expand')],
      [ch('link','L'),                    tr('kbLink','Cross-link to another node')],
      ['⌘ C',                             tr('kbCopyMd','Copy the selected topic(s) as a Markdown outline')],
      ['⌘ V',                             tr('kbPasteChildren','Paste a copied subtree or an outline as children')],
      ['⌘ A',                             tr('kbSelectAll','Select every visible topic')],
      ['⇧ ⌘ A',                           tr('kbSelectSiblings','Select the topic and its siblings')],
      [tr('kbGRightClick','right-click a topic'), tr('kbNodeMenu','Topic menu: add, notes, marker, duplicate…')],
      [tr('kbGDrag','drag'),              tr('kbDrag','Move a topic (subtree follows)')],
      [tr('kbGDragCentre','drag onto centre'), tr('kbNest','Nest it as a child of that topic')],
      [tr('kbGDragEdge','drag onto top / bottom'), tr('kbReorder','Insert as a sibling / reorder')],
      [tr('kbGBoxSel','⌘ + drag canvas'), tr('kbBox','Box-select topics')],
      [tr('kbGCmdClick','⌘ + click'),     tr('kbMulti','Add / remove a topic from the selection')],
      [tr('kbGDragSel','drag a selection'), tr('kbDragSel','Move the selected topics together')],
    ]],
    [tr('kbNav','Navigation'),[
      ['↑ ↓ ← →',                         tr('kbArrows','Move selection between nodes')],
      [tr('kbGScroll','scroll'),          tr('kbScroll','Zoom canvas (mouse) / two-finger pinch (touch)')],
      [tr('kbGDragCanvas','drag canvas'), tr('kbPan','Pan the map')],
    ]],
    [tr('kbEditing','Editing text'),[
      ['⌘ B / I / U',                     tr('kbFormat','Bold / italic / underline the selection')],
      [tr('kbGListBtn','select + UL/OL button'), tr('kbLists','Make each selected line a bullet')],
      ['Tab',                             tr('kbSaveChild','Save and add a child node')],
      ['↩',                               tr('kbSaveSibling','Save and add a sibling node')],
      ['⇧ ↩',                             tr('kbNewline','Newline within the node text')],
      ['Esc',                             tr('kbEsc','Save the edit / close a popup')],
      ['⇧ Esc',                           tr('kbCancelEdit','Discard the edit and restore the text')],
    ]],
    [tr('kbToolsGroup','Find & tools'),[
      [ch('find','⌘ F'),                  tr('kbFind','Find in this map')],
      [ch('findReplace','⌘ H'),           tr('kbFindReplace','Find and replace')],
      [ch('openSettings','⌘ ,'),          tr('kbSettings','Open settings')],
      [ch('help','?'),                    tr('kbHelp','Show this list')],
    ]],
    [tr('kbHistory','History'),[
      [ch('undo','⌘ Z'),                  tr('kbUndo','Undo')],
      [ch('redo','⇧ ⌘ Z'),                tr('kbRedo','Redo')],
    ]]
  ];
}
function showKeyboardHelp(){
  document.querySelectorAll('.kb-help').forEach(m=>m.remove());
  const m = document.createElement('div');
  m.className = 'kb-help';
  const tr = (k, fallback) => rmsTr(k, fallback);
  const shortcuts = keyboardHelpRows(tr);
  const renderTable = group => `
    <h3>${escapeHtml(group[0])}</h3>
    <table>${group[1].map(r=>`<tr><td><kbd>${escapeHtml(r[0])}</kbd></td><td>${escapeHtml(r[1])}</td></tr>`).join('')}</table>`;
  const helpKey = escapeHtml(helpChordLabel('help','?'));
  m.innerHTML = `
    <div class="kb-backdrop"></div>
    <div class="kb-card">
      <button class="kb-close" aria-label="${tr('close','Close')}">×</button>
      <h2>${tr('kbTitle','Keyboard shortcuts')}</h2>
      <div class="kb-grid">${shortcuts.map(renderTable).join('')}</div>
      <p class="kb-foot">${tr('kbFootHtml','Press <kbd>?</kbd> any time to open this list.').replace('<kbd>?</kbd>', '<kbd>'+helpKey+'</kbd>')}</p>
    </div>`;
  document.body.appendChild(m);
  const close=()=>m.remove();
  m.querySelector('.kb-close').onclick = close;
  m.querySelector('.kb-backdrop').onclick = close;
  m.addEventListener('keydown', e=>{ if(e.key==='Escape'){ e.preventDefault(); close(); } });
  // Focus inside the dialog so its own Escape handler sees the key.
  m.querySelector('.kb-close').focus();
}
window.addEventListener('keydown', e=>{
  if(!rms('help', e, e.key === '?')) return;
  // Don't intercept when typing inside a text field / contentEditable
  if(e.target.isContentEditable) return;
  const tag = (e.target.tagName||'').toUpperCase();
  if(tag === 'INPUT' || tag === 'TEXTAREA') return;
  if(document.querySelector('.node.editing')) return;
  e.preventDefault();
  showKeyboardHelp();
});
// Esc exits focus mode (only when nothing else is open/focused)
window.addEventListener('keydown', e=>{
  if(e.key!=='Escape') return;
  if(!document.body.classList.contains('focus-mode')) return;
  // Don't fight with editing/notes — they handle Esc themselves
  if(topModalEl()) return;
  if(document.querySelector('.node.editing')) return;
  if(document.querySelector('.notes-popup')) return;
  e.preventDefault();
  toggleFocusMode();
}, true);

// ===== GitHub source/issue link =====
// Set this to your repo and the sidebar footer links will go live.
const GITHUB_URL = 'https://github.com/RocStone/roc-mind-spark';
(function wireGitHub(){
  const ghOk = GITHUB_URL && !GITHUB_URL.includes('YOUR_USERNAME');
  const repo = $('#ghRepoLink'), issue = $('#ghIssueLink');
  if(ghOk){
    if(repo) repo.href = GITHUB_URL;
    if(issue) issue.href = GITHUB_URL.replace(/\/$/, '') + '/issues/new?labels=bug';
  } else {
    // Until configured, point at the canonical readme so the buttons aren't dead.
    // Replace these in app.js (search for GITHUB_URL) to publish your own repo.
    [repo,issue].forEach(a=>{ if(a){ a.href='#'; a.addEventListener('click',e=>{
      e.preventDefault();
      toast('Set GITHUB_URL in app.js to your repo URL');
    }); }});
  }
})();

// First-run sample: seed the bundled "ML - Overview (Demo)" map as the user's own
// editable copy, so a brand-new sidebar isn't empty. Fetched (not embedded) to
// keep app.js lean; on failure (offline/missing) the caller falls back to a blank map.
async function seedDemoMap(){
  let demo;
  try{
    const r = await fetch('demo-map.json', { cache:'no-store' });
    if(!r.ok) return false;
    demo = await r.json();
  }catch(e){ return false; }
  if(!demo || !demo.rootId || !demo.nodes) return false;
  demo.id = uid();                 // a fresh id → the user's own copy
  demo.updated = Date.now();
  map = demo; sel = null;
  history=[]; hpos=-1; pushHistory();
  $('#mapTitle').value = map.title || 'ML - Overview (Demo)';
  autoLayout();
  const savedV=loadMapView(map.id);
  if(savedV) applyMapView(savedV); else fit();
  refreshList();
  try{ await saveMapNow(map); }catch(e){ console.warn('save after map load failed:', e.message); }
  return true;
}
function showStoreFailure(error){
  console.warn('Map storage unavailable:',error);
  const empty=$('#empty');
  if(empty && !map){
    empty.style.display='grid';
    empty.replaceChildren();
    const message=document.createElement('p'), retry=document.createElement('button');
    message.textContent=rmsTr('storageUnavailable','Could not load your maps. Your saved maps have not been changed.');
    retry.textContent=rmsTr('retry','Retry');
    retry.onclick=()=>{ retry.disabled=true; proceedBoot().catch(showStoreFailure); };
    empty.append(message,retry);
  }
  toast(rmsTr('storageUnavailable','Could not load your maps. Your saved maps have not been changed.'));
}
async function proceedBoot(){
  loadUserTemplates();   // merge any saved "My templates" into the catalog
  try{ const _mid=new URLSearchParams(location.search).get('map'); if(_mid && await loadMap(_mid)) return; }catch(e){}
  let idx=[];
  idx=await Store.list();
  if(idx && idx.length){
    const ok=await loadMap(idx[0].id);
    if(!ok) throw new Error('Could not open the saved map');
  } else {
    // Truly empty store: on first run, seed the demo sample instead of a blank map.
    if(!localStorage.getItem('mindspark:demoSeeded')){
      const seeded = await seedDemoMap();
      try{ localStorage.setItem('mindspark:demoSeeded','1'); }catch(e){}
      if(seeded) return;
    }
    createMap();
  }
}

// Called before switching to another map: close any version-history preview
// and make the title editable again.
function resetMapViewState(){
  cancelHistoryPreview();
  // History and diff belong to the map being left.
  document.querySelectorAll('.hist-panel, .diff-panel').forEach(p=>p.remove());
  READONLY=false;
  const t=$('#mapTitle'); if(t) t.readOnly=false;
}

(async()=>{
  // The inline <head> script guesses the auto scale before any page content exists,
  // to avoid a flash of the wrong size — but that's a measurement taken in a very
  // different layout context than this point (script tag sits at the very end of
  // body, so the whole page has been parsed by the time this runs). Re-apply it now,
  // in auto mode only, using this file's own calculation — the same one already used
  // whenever the user picks "Auto" by hand — so boot converges on the identical
  // result rather than trusting a guess taken before there was anything to measure.
  try{ if(isUiScaleAuto()) applyUiScale(getUiScale()); }catch(e){}
  requestAnimationFrame(()=>{ try{ if(isUiScaleAuto()) applyUiScale(getUiScale()); }catch(e){} });
  await initStore();
  await proceedBoot();
})().catch(e=>{
  console.error(e);
  showStoreFailure(e);
}).finally(()=>{
  // No rAF: the overlay parks the window off-screen, and rAF does not fire
  // on an occluded WKWebView. Ready must be synchronous after boot.
  if(typeof window.__rmsSignalReady==='function') window.__rmsSignalReady();
});
