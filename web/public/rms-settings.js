/* In-app settings + right-click custom shortcuts. Local chords only fire
   while this page is focused (the overlay is open). The native shell owns
   the one global hotkey: show / hide. */
(function(){
  const CANVAS_KEY = 'rms:canvasShortcuts';
  const BUTTON_KEY = 'rms:buttonShortcuts';
  const t = (k) => (window.rmsT ? window.rmsT(k) : k);

  function canvasMeta(){
    return [
      { id:'openSettings', title:t('scOpenSettings'), group:'scGroupGeneral' },
      { id:'help', title:t('scHelp'), group:'scGroupGeneral' },
      { id:'addChild', title:t('scAddChild'), group:'scGroupBuild' },
      { id:'addSibling', title:t('scAddSibling'), group:'scGroupBuild' },
      { id:'addSiblingMod', title:t('scAddSiblingMod'), group:'scGroupBuild' },
      { id:'editNode', title:t('scEditNode'), group:'scGroupBuild' },
      { id:'deleteNode', title:t('scDeleteNode'), group:'scGroupBuild' },
      { id:'deleteForward', title:t('scDeleteForward'), group:'scGroupBuild' },
      { id:'collapse', title:t('scCollapse'), group:'scGroupBuild' },
      { id:'link', title:t('scLink'), group:'scGroupBuild' },
      { id:'moveSiblingUp', title:t('scMoveSiblingUp'), group:'scGroupNav' },
      { id:'moveSiblingDown', title:t('scMoveSiblingDown'), group:'scGroupNav' },
      { id:'moveSiblingUpAlt', title:t('scMoveSiblingUpAlt'), group:'scGroupNav' },
      { id:'moveSiblingDownAlt', title:t('scMoveSiblingDownAlt'), group:'scGroupNav' },
      { id:'undo', title:t('scUndo'), group:'scGroupHistory' },
      { id:'redo', title:t('scRedo'), group:'scGroupHistory' },
      { id:'find', title:t('scFind'), group:'scGroupHistory' },
      { id:'findReplace', title:t('scFindReplace'), group:'scGroupHistory' },
    ];
  }

  const defaults = {
    openSettings: { key:',', code:'Comma', meta:true, ctrl:false, alt:false, shift:false },
    addChild: { key:'Tab', code:'Tab', meta:false, ctrl:false, alt:false, shift:false },
    addSibling: { key:'Enter', code:'Enter', meta:false, ctrl:false, alt:false, shift:false },
    addSiblingMod: { key:'Enter', code:'Enter', meta:true, ctrl:false, alt:false, shift:false },
    editNode: { key:'F2', code:'F2', meta:false, ctrl:false, alt:false, shift:false },
    deleteNode: { key:'Backspace', code:'Backspace', meta:false, ctrl:false, alt:false, shift:false },
    deleteForward: { key:'Delete', code:'Delete', meta:false, ctrl:false, alt:false, shift:false },
    collapse: { key:' ', code:'Space', meta:false, ctrl:false, alt:false, shift:false },
    link: { key:'l', code:'KeyL', meta:false, ctrl:false, alt:false, shift:false },
    moveSiblingUp: { key:'ArrowUp', code:'ArrowUp', meta:false, ctrl:false, alt:true, shift:false },
    moveSiblingDown: { key:'ArrowDown', code:'ArrowDown', meta:false, ctrl:false, alt:true, shift:false },
    moveSiblingUpAlt: { key:'ArrowUp', code:'ArrowUp', meta:true, ctrl:false, alt:false, shift:true },
    moveSiblingDownAlt: { key:'ArrowDown', code:'ArrowDown', meta:true, ctrl:false, alt:false, shift:true },
    undo: { key:'z', code:'KeyZ', meta:true, ctrl:false, alt:false, shift:false },
    redo: { key:'z', code:'KeyZ', meta:true, ctrl:false, alt:false, shift:true },
    find: { key:'f', code:'KeyF', meta:true, ctrl:false, alt:false, shift:false },
    findReplace: { key:'h', code:'KeyH', meta:true, ctrl:false, alt:false, shift:false },
    help: { key:'/', code:'Slash', meta:false, ctrl:false, alt:false, shift:true },
  };

  function loadJSON(key, fallback){
    try{ return JSON.parse(localStorage.getItem(key)||'') || fallback; }catch(e){ return fallback; }
  }
  function saveJSON(key, val){ try{ localStorage.setItem(key, JSON.stringify(val)); }catch(e){} }

  function canvasMap(){
    return Object.assign({}, defaults, window.__RMS_SHORTCUTS__||{}, loadJSON(CANVAS_KEY, {}));
  }
  function buttonMap(){ return loadJSON(BUTTON_KEY, {}); }

  function applyCanvas(){
    window.__RMS_SHORTCUTS__ = canvasMap();
  }

  function specFromEvent(e){
    return {
      key: e.key,
      code: e.code,
      meta: !!e.metaKey,
      ctrl: !!e.ctrlKey,
      alt: !!e.altKey,
      shift: !!e.shiftKey,
    };
  }
  function hasMod(spec){ return !!(spec && (spec.meta || spec.ctrl || spec.alt || spec.shift)); }
  function specLabel(spec){
    if(!spec) return t('notSet');
    const bits=[];
    if(spec.ctrl) bits.push('⌃');
    if(spec.alt) bits.push('⌥');
    if(spec.shift) bits.push('⇧');
    if(spec.meta) bits.push('⌘');
    let key = spec.key || '';
    if(key===' ') key='Space';
    if(key==='Meta'||key==='Control'||key==='Alt'||key==='Shift') return bits.join(' ') || '…';
    const glyphs = {
      Enter:'↩', Tab:'Tab', ' ':'Space', Space:'Space',
      Backspace:'⌫', Delete:'⌦', Escape:'Esc',
      ArrowUp:'↑', ArrowDown:'↓', ArrowLeft:'←', ArrowRight:'→',
      ',':',', '/':'/',
    };
    if(glyphs[key]) key = glyphs[key];
    else if(key.length===1) key=key.toUpperCase();
    return bits.length ? bits.join(' ') + ' ' + key : key;
  }
  window.rmsSpecLabel = specLabel;
  window.rmsChordLabel = function(id){
    const spec = canvasMap()[id];
    return spec ? specLabel(spec) : '';
  };
  function sameSpec(a, b){
    if(!a || !b) return false;
    const keyA=(a.code||'') === (b.code||'') || ((a.key||'').toLowerCase()===(b.key||'').toLowerCase());
    return keyA && !!a.meta===!!b.meta && !!a.ctrl===!!b.ctrl && !!a.alt===!!b.alt && !!a.shift===!!b.shift;
  }
  function canvasConflict(id, spec){
    const canvas=canvasMap();
    const names=canvasMeta();
    for(let i=0;i<names.length;i++){
      const item=names[i];
      if(item.id===id) continue;
      if(sameSpec(canvas[item.id], spec)) return item.title;
    }
    const native=window.__RMS_NATIVE__||{};
    if(native.toggle && sameSpec(native.toggle, spec)) return t('showHide');
    return null;
  }
  function buttonNameForSpec(spec, skipId){
    const btns=buttonMap();
    for(const bid in btns){
      if(skipId && bid===skipId) continue;
      if(sameSpec(btns[bid], spec)){
        const el=findButton(bid);
        return el ? buttonLabel(el) : t('btn');
      }
    }
    return null;
  }
  function buttonConflict(id, spec){
    const canvasClash=canvasConflict(null, spec);
    if(canvasClash) return canvasClash;
    return buttonNameForSpec(spec, id);
  }

  function nativePost(payload){
    try{ window.webkit.messageHandlers.rmsNative.postMessage(payload); }catch(e){}
  }

  let ctx=null, listening=null;

  window.__rmsNativeState = function(state){
    window.__RMS_NATIVE__ = state || {};
    const login = document.getElementById('rmsLoginToggle');
    if(login) login.checked = !!(state && state.login);
    const tog = document.getElementById('rmsToggleChord');
    if(tog && !(listening && listening.kind==='toggle')) tog.textContent = (state && state.toggleDisplay) || 'Caps + Q';
  };

  window.__rmsToggleListenDone = function(){
    listening=null;
    paintSettings();
  };

  function hasNativeBridge(){
    try{ return !!(window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.rmsNative); }
    catch(e){ return false; }
  }
  function isReservedToggleSpec(spec){
    if(!spec) return false;
    const comma = spec.code==='Comma' || spec.key===',';
    return !!(comma && spec.meta && !spec.ctrl && !spec.alt && !spec.shift);
  }

  function buttonId(el){
    if(!el) return '';
    if(el.id) return 'id:'+el.id;
    if(el.dataset && el.dataset.a) return 'act:'+el.dataset.a;
    const title=(el.getAttribute('title')||'').trim();
    if(title) return 'title:'+title.slice(0,48);
    const text=(el.textContent||'').trim().replace(/\s+/g,' ');
    return 'text:'+text.slice(0,32);
  }
  function buttonLabel(el){
    if(el.dataset && el.dataset.a){
      const names={
        task:t('actTask'), child:t('scAddChild'), sibling:t('scAddSibling'), edit:t('scEditNode'),
        del:t('scDeleteNode'), collapse:t('scCollapse'), notes:t('actNotes'), marker:t('actMarker'), cite:t('actCite'),
        href:t('actHref'), image:t('actImage'), bold:t('actBold'), italic:t('actItalic'), strike:t('actStrike'), underline:t('actUnderline'),
        ul:t('actUl'), ol:t('actOl'),
      };
      return names[el.dataset.a] || el.dataset.a;
    }
    if(el.id){
      const names={
        settingsBtn:t('idSettings'), addChild:t('scAddChild'), addSiblingBtn:t('scAddSibling'),
        undo:t('scUndo'), redo:t('scRedo'),
        searchBtn:t('scFind'), layout:t('idLayout'), collapseAll:t('idCollapseAll'),
        mdToggle:t('idMarkdown'), themeBtn:t('idTheme'), menuExport:t('idExport'),
        focusBtn:t('idFocus'), newMap:t('idNewMap'),
      };
      if(names[el.id]) return names[el.id];
    }
    return (el.getAttribute('title')||el.textContent||t('btn')).trim().slice(0,40);
  }
  function findButton(id){
    if(id.startsWith('id:')) return document.getElementById(id.slice(3));
    if(id.startsWith('act:')) return document.querySelector('[data-a="'+CSS.escape(id.slice(4))+'"]');
    if(id.startsWith('title:')) return document.querySelector('[title="'+id.slice(6).replace(/"/g,'\\"')+'"]');
    return null;
  }
  function fireButton(id){
    if(id==='act:task' && typeof cycleTask==='function' && typeof sel!=='undefined' && sel){
      cycleTask(sel);
      return;
    }
    const el = findButton(id);
    if(el) el.click();
  }

  function closeCtx(){
    if(ctx){ ctx.remove(); ctx=null; }
    listening=null;
  }

  function showCtx(el, x, y){
    closeCtx();
    const id=buttonId(el);
    const bound=buttonMap()[id];
    const menu=document.createElement('div');
    menu.className='rms-ctx';
    menu.style.left=x+'px';
    menu.style.top=y+'px';
    menu.innerHTML =
      '<button data-op="bind">'+(bound?t('changeShortcut'):t('addShortcut'))+'</button>'+
      (bound ? '<button data-op="clear">'+t('clear')+' '+specLabel(bound)+'</button>' : '');
    document.body.appendChild(menu);
    const rect=menu.getBoundingClientRect();
    if(rect.right>innerWidth-8) menu.style.left=Math.max(8, innerWidth-rect.width-8)+'px';
    if(rect.bottom>innerHeight-8) menu.style.top=Math.max(8, innerHeight-rect.height-8)+'px';
    ctx=menu;
    menu.addEventListener('mousedown', ev=>ev.stopPropagation());
    menu.addEventListener('click', ev=>{
      const op=ev.target && ev.target.dataset && ev.target.dataset.op;
      if(op==='clear'){
        const all=buttonMap(); delete all[id]; saveJSON(BUTTON_KEY, all);
        closeCtx(); paintSettings(); return;
      }
      if(op==='bind'){
        listening={ kind:'button', id, label:buttonLabel(el) };
        menu.innerHTML='<div class="rms-ctx-wait">'+t('pressKey')+'</div>';
      }
    });
  }

  function eligible(el){
    if(!el || !el.closest) return null;
    if(el.closest('.rms-settings, .rms-ctx, .vf-card, .kb-card, .picker, input, textarea, [contenteditable="true"]')) return null;
    return el.closest('button, .tb, [data-a], .handle');
  }

  document.addEventListener('contextmenu', e=>{
    e.preventDefault();
    const el=eligible(e.target);
    if(el) showCtx(el, e.clientX, e.clientY);
  }, true);

  document.addEventListener('mousedown', e=>{
    if(ctx && !ctx.contains(e.target)) closeCtx();
  }, true);

  window.addEventListener('keydown', e=>{
    if(!listening && e.key==='Escape' && document.querySelector('.rms-settings')){
      document.querySelector('.rms-settings').remove();
      e.preventDefault();
      return;
    }
    if(listening){
      if(e.key==='Escape'){
        if(listening.kind==='toggle') nativePost({ op:'cancelToggleListen' });
        closeCtx(); listening=null; paintSettings(); return;
      }
      if(e.key==='Meta'||e.key==='Control'||e.key==='Alt'||e.key==='Shift') return;
      e.preventDefault(); e.stopPropagation();
      const spec=specFromEvent(e);
      if(listening.kind==='button' && !hasMod(spec)){
        if(typeof toast==='function') toast(t('shortcutNeedsMod'));
        closeCtx();
        return;
      }
      if(listening.kind==='toggle'){
        // Native shell records Command / Hyper. JS keydown often never sees them
        // on an accessory overlay, or drops Control from a Caps-as-Hyper chord.
        if(hasNativeBridge()) return;
        if(isReservedToggleSpec(spec) || !hasMod(spec)) return;
        nativePost(Object.assign({ op:'setToggle' }, spec));
      } else if(listening.kind==='canvas'){
        const clash=canvasConflict(listening.id, spec) || buttonNameForSpec(spec, null);
        if(clash){
          if(typeof toast==='function') toast(t('shortcutConflict').replace('%s', clash));
          closeCtx(); listening=null; paintSettings(); return;
        }
        const all=loadJSON(CANVAS_KEY, {});
        all[listening.id]=spec;
        saveJSON(CANVAS_KEY, all);
        applyCanvas();
        if(window.rmsApplyI18n) window.rmsApplyI18n();
        if(typeof refreshLocaleChrome==='function') refreshLocaleChrome();
      } else if(listening.kind==='button'){
        const clash=buttonConflict(listening.id, spec);
        if(clash){
          if(typeof toast==='function') toast(t('shortcutConflict').replace('%s', clash));
          closeCtx(); listening=null; paintSettings(); return;
        }
        const all=buttonMap();
        all[listening.id]=spec;
        saveJSON(BUTTON_KEY, all);
      }
      closeCtx();
      listening=null;
      paintSettings();
      return;
    }
    if(isImeEvent && isImeEvent(e)) return;
    if(rms && rms('openSettings', e, (e.metaKey||e.ctrlKey) && !e.altKey && e.key===',')){
      e.preventDefault(); e.stopPropagation();
      openSettings();
      return;
    }
    const binds=buttonMap();
    const now=specFromEvent(e);
    for(const id in binds){
      if(sameSpec(binds[id], now)){
        if(['INPUT','TEXTAREA'].includes(e.target.tagName) || e.target.isContentEditable){
          if(!hasMod(binds[id])) continue;
        }
        e.preventDefault(); e.stopPropagation();
        fireButton(id);
        return;
      }
    }
  }, true);

  function openSettings(){
    const existing=document.querySelector('.rms-settings');
    if(existing){ nativePost({ op:'cancelToggleListen' }); listening=null; existing.remove(); return; }
    nativePost({ op:'getState' });
    applyCanvas();
    document.querySelectorAll('.rms-settings').forEach(n=>n.remove());
    const lang = window.rmsLang ? window.rmsLang() : 'en';
    const m=document.createElement('div');
    m.className='rms-settings var-form';
    m.innerHTML=`
      <div class="vf-backdrop"></div>
      <div class="vf-card rms-set-card">
        <button class="vf-close" aria-label="${t('close')}">×</button>
        <h2>${t('settings')}</h2>
        <p class="vf-sub">${t('settingsSub')}</p>
        <div class="rms-set-sec">
          <h3>${t('language')}</h3>
          <div class="rms-row">
            <span>${t('language')}</span>
            <div class="rms-lang" role="radiogroup" aria-label="${t('language')}">
              <button type="button" data-lang="en"${lang==='en'?' class="on" aria-pressed="true"':' aria-pressed="false"'}>English</button>
              <button type="button" data-lang="zh"${lang==='zh'?' class="on" aria-pressed="true"':' aria-pressed="false"'}>中文</button>
            </div>
          </div>
        </div>
        <div class="rms-set-sec">
          <h3>${t('startup')}</h3>
          <label class="rms-check"><input type="checkbox" id="rmsLoginToggle"> ${t('launchAtLogin')}</label>
        </div>
        <div class="rms-set-sec">
          <h3>${t('overlay')}</h3>
          <div class="rms-row"><span>${t('showHide')}</span><button type="button" class="rms-chord" id="rmsToggleChord" data-rec="toggle">Caps + Q</button></div>
        </div>
        <div class="rms-set-sec">
          <h3>${t('canvas')}</h3>
          <p class="vf-sub" style="margin:0 0 8px">${t('canvasHelp')}</p>
          <div id="rmsCanvasRows"></div>
        </div>
        <div class="rms-set-sec">
          <h3>${t('buttonShortcuts')}</h3>
          <p class="vf-sub" style="margin:0 0 8px">${t('buttonShortcutsHelp')}</p>
          <div id="rmsButtonRows"></div>
        </div>
      </div>`;
    document.body.appendChild(m);
    const close=()=>{ nativePost({ op:'cancelToggleListen' }); listening=null; m.remove(); };
    m.querySelector('.vf-close').onclick=close;
    m.querySelector('.vf-backdrop').onclick=close;
    m.querySelector('#rmsLoginToggle').onchange=ev=>nativePost({ op:'setLogin', on:ev.target.checked });
    m.querySelectorAll('.rms-lang [data-lang]').forEach(btn=>{
      btn.onclick=()=>{
        const next=btn.dataset.lang;
        if(!next || next===(window.rmsLang ? window.rmsLang() : 'en')) return;
        if(window.rmsSetLang) window.rmsSetLang(next);
        nativePost({ op:'cancelToggleListen' });
        listening=null;
        m.remove();
        openSettings();
      };
    });
    m.addEventListener('click', ev=>{
      const rec=ev.target && ev.target.dataset && ev.target.dataset.rec;
      if(!rec) return;
      if(rec==='toggle'){
        listening = { kind:'toggle' };
        ev.target.textContent=t('pressKey');
        nativePost({ op:'listenToggle' });
        return;
      }
      listening = { kind:'canvas', id:rec };
      ev.target.textContent=t('pressKey');
    });
    paintSettings();
  }
  window.rmsOpenSettings = openSettings;

  function paintSettings(){
    const root=document.querySelector('.rms-settings');
    if(!root) return;
    const native=window.__RMS_NATIVE__||{};
    const login=root.querySelector('#rmsLoginToggle');
    if(login) login.checked=!!native.login;
    const tog=root.querySelector('#rmsToggleChord');
    if(tog && !listening) tog.textContent=native.toggleDisplay||'Caps + Q';
    const canvas=canvasMap();
    const box=root.querySelector('#rmsCanvasRows');
    if(box){
      let lastGroup='';
      box.innerHTML=canvasMeta().map(item=>{
        const head = item.group && item.group!==lastGroup
          ? '<div class="rms-sub">'+t(item.group)+'</div>'
          : '';
        lastGroup=item.group||lastGroup;
        return head+'<div class="rms-row"><span>'+item.title+'</span>'+
          '<button type="button" class="rms-chord" data-rec="'+item.id+'">'+specLabel(canvas[item.id])+'</button></div>';
      }).join('');
    }
    const btns=buttonMap();
    const list=root.querySelector('#rmsButtonRows');
    if(list){
      const ids=Object.keys(btns);
      if(!ids.length){ list.innerHTML='<div class="rms-empty">'+t('noButtonShortcuts')+'</div>'; }
      else {
        list.innerHTML=ids.map(id=>{
          const el=findButton(id);
          const name=el?buttonLabel(el):id;
          return '<div class="rms-row"><span>'+name+'</span><span class="rms-chord-static">'+specLabel(btns[id])+'</span>'+
            '<button type="button" class="rms-clear" data-clear="'+id+'">'+t('clear')+'</button></div>';
        }).join('');
        list.querySelectorAll('[data-clear]').forEach(b=>b.onclick=()=>{
          const all=buttonMap(); delete all[b.dataset.clear]; saveJSON(BUTTON_KEY, all); paintSettings();
        });
      }
    }
  }

  applyCanvas();
  nativePost({ op:'setLanguage', lang: (window.rmsLang ? window.rmsLang() : 'en') });
  document.getElementById('settingsBtn')?.addEventListener('click', openSettings);
})();
