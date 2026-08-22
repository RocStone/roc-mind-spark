/* In-app settings + right-click custom shortcuts. Local chords only fire
   while this page is focused (the overlay is open). The native shell owns
   the one global hotkey: show / hide. */
(function(){
  const CANVAS_KEY = 'rms:canvasShortcuts';
  const BUTTON_KEY = 'rms:buttonShortcuts';
  const t = (k) => (window.rmsT ? window.rmsT(k) : k);

  function canvasMeta(){
    return [
      { id:'openSettings', title:t('scOpenSettings') },
      { id:'addChild', title:t('scAddChild') },
      { id:'addSibling', title:t('scAddSibling') },
      { id:'editNode', title:t('scEditNode') },
      { id:'deleteNode', title:t('scDeleteNode') },
      { id:'collapse', title:t('scCollapse') },
      { id:'link', title:t('scLink') },
      { id:'undo', title:t('scUndo') },
      { id:'redo', title:t('scRedo') },
      { id:'find', title:t('scFind') },
      { id:'help', title:t('scHelp') },
    ];
  }

  const defaults = {
    openSettings: { key:',', code:'Comma', meta:true, ctrl:false, alt:false, shift:false },
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
    if(key==='Meta'||key==='Control'||key==='Alt'||key==='Shift') return bits.join('') || '…';
    if(key.length===1) key=key.toUpperCase();
    return bits.join('') + key;
  }
  function sameSpec(a, b){
    if(!a || !b) return false;
    const keyA=(a.code||'') === (b.code||'') || ((a.key||'').toLowerCase()===(b.key||'').toLowerCase());
    return keyA && !!a.meta===!!b.meta && !!a.ctrl===!!b.ctrl && !!a.alt===!!b.alt && !!a.shift===!!b.shift;
  }

  function nativePost(payload){
    try{ window.webkit.messageHandlers.rmsNative.postMessage(payload); }catch(e){}
  }

  window.__rmsNativeState = function(state){
    window.__RMS_NATIVE__ = state || {};
    const login = document.getElementById('rmsLoginToggle');
    if(login) login.checked = !!(state && state.login);
    const tog = document.getElementById('rmsToggleChord');
    if(tog) tog.textContent = (state && state.toggleDisplay) || '⌥⇧⌘Q';
  };

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
        task:t('actTask'), child:t('actChild'), sibling:t('actSibling'), edit:t('actEdit'),
        del:t('actDel'), collapse:t('actCollapse'), notes:t('actNotes'), marker:t('actMarker'), cite:t('actCite'),
        image:t('actImage'), bold:t('actBold'), italic:t('actItalic'), strike:t('actStrike'), underline:t('actUnderline'),
        ul:t('actUl'), ol:t('actOl'),
      };
      return names[el.dataset.a] || el.dataset.a;
    }
    if(el.id){
      const names={
        settingsBtn:t('idSettings'), addChild:t('idAddChild'), undo:t('idUndo'), redo:t('idRedo'),
        searchBtn:t('idSearch'), layout:t('idLayout'), collapseAll:t('idCollapseAll'),
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

  let ctx=null, listening=null;

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
      if(e.key==='Escape'){ closeCtx(); listening=null; return; }
      if(e.key==='Meta'||e.key==='Control'||e.key==='Alt'||e.key==='Shift') return;
      e.preventDefault(); e.stopPropagation();
      const spec=specFromEvent(e);
      if(listening.kind==='button' && !hasMod(spec)){
        if(typeof toast==='function') toast(t('shortcutNeedsMod'));
        closeCtx();
        return;
      }
      if(listening.kind==='toggle'){
        nativePost(Object.assign({ op:'setToggle' }, spec));
      } else if(listening.kind==='canvas'){
        const all=loadJSON(CANVAS_KEY, {});
        all[listening.id]=spec;
        saveJSON(CANVAS_KEY, all);
        applyCanvas();
      } else if(listening.kind==='button'){
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
    if(existing){ existing.remove(); return; }
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
            <select id="rmsLangSelect" class="rms-lang">
              <option value="en"${lang==='en'?' selected':''}>English</option>
              <option value="zh"${lang==='zh'?' selected':''}>中文</option>
            </select>
          </div>
        </div>
        <div class="rms-set-sec">
          <h3>${t('startup')}</h3>
          <label class="rms-check"><input type="checkbox" id="rmsLoginToggle"> ${t('launchAtLogin')}</label>
        </div>
        <div class="rms-set-sec">
          <h3>${t('overlay')}</h3>
          <div class="rms-row"><span>${t('showHide')}</span><button type="button" class="rms-chord" id="rmsToggleChord" data-rec="toggle">⌥⇧⌘Q</button></div>
        </div>
        <div class="rms-set-sec">
          <h3>${t('canvas')}</h3>
          <div id="rmsCanvasRows"></div>
        </div>
        <div class="rms-set-sec">
          <h3>${t('buttonShortcuts')}</h3>
          <p class="vf-sub" style="margin:0 0 8px">${t('buttonShortcutsHelp')}</p>
          <div id="rmsButtonRows"></div>
        </div>
      </div>`;
    document.body.appendChild(m);
    const close=()=>m.remove();
    m.querySelector('.vf-close').onclick=close;
    m.querySelector('.vf-backdrop').onclick=close;
    m.querySelector('#rmsLoginToggle').onchange=ev=>nativePost({ op:'setLogin', on:ev.target.checked });
    m.querySelector('#rmsLangSelect').onchange=ev=>{
      if(window.rmsSetLang) window.rmsSetLang(ev.target.value);
      m.remove();
      openSettings();
    };
    m.addEventListener('click', ev=>{
      const rec=ev.target && ev.target.dataset && ev.target.dataset.rec;
      if(!rec) return;
      listening = rec==='toggle' ? { kind:'toggle' } : { kind:'canvas', id:rec };
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
    if(tog && !listening) tog.textContent=native.toggleDisplay||'⌥⇧⌘Q';
    const canvas=canvasMap();
    const box=root.querySelector('#rmsCanvasRows');
    if(box){
      box.innerHTML=canvasMeta().map(item=>
        '<div class="rms-row"><span>'+item.title+'</span>'+
        '<button type="button" class="rms-chord" data-rec="'+item.id+'">'+specLabel(canvas[item.id])+'</button></div>'
      ).join('');
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
