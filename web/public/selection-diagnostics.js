// Loaded only by the installed app's explicit --selection-trace launch option.
// Collect times and coordinates, never document contents or clipboard data.
(()=>{
  const nativeRAF=window.requestAnimationFrame.bind(window);
  const nativeCancel=window.cancelAnimationFrame.bind(window);
  let trace=null, heartbeat=0, number=0;
  const now=()=>performance.now();
  function emit(payload){ window.webkit.messageHandlers.rmsNative.postMessage({op:'selectionTrace',payload}); }
  function add(kind,data={}){
    if(trace && trace.events.length<20000) trace.events.push({kind,t:now(),...data});
  }
  function wrap(proto,key){
    const original=proto[key];
    if(!original) return;
    proto[key]=function(...args){
      if(!trace) return original.apply(this,args);
      const start=now();
      try{ return original.apply(this,args); }
      finally{ add(key,{start,duration:now()-start}); }
    };
  }
  wrap(Document.prototype,'caretRangeFromPoint');
  wrap(Range.prototype,'getClientRects');
  window.requestAnimationFrame=callback=>nativeRAF(timestamp=>{
    if(!trace) return callback(timestamp);
    const start=now();
    try{ return callback(timestamp); }
    finally{ add('raf-callback',{name:callback.name,start,timestamp,duration:now()-start}); }
  });
  function tick(timestamp){
    if(!trace) return;
    add('display-tick',{timestamp});
    heartbeat=nativeRAF(tick);
  }
  window.addEventListener('mousedown',event=>{
    const editor=event.target.closest?.('#mdEditor, .edit-float-text, .node.editing .node-text');
    if(!editor || event.button!==0) return;
    if(trace) finish('superseded');
    const text=editor.textContent;
    const box=editor.getBoundingClientRect();
    trace={kind:'page-gesture',number:++number,timeOrigin:performance.timeOrigin,
      editor:editor.id==='mdEditor'?'markdown':'node',
      meta:{chars:text.length,maxLine:Math.max(...text.split('\n').map(x=>x.length)),
        scrollWidth:editor.scrollWidth,scrollTop:editor.scrollTop,scrollLeft:editor.scrollLeft,
        width:box.width,height:box.height,left:box.left,top:box.top,
        viewportWidth:innerWidth,viewportHeight:innerHeight,devicePixelRatio,
        canvasNodes:document.querySelectorAll('.node').length,focused:document.hasFocus(),hidden:document.hidden},events:[]};
    add('mousedown',{x:event.clientX,y:event.clientY,eventTime:event.timeStamp});
    heartbeat=nativeRAF(tick);
  },true);
  window.addEventListener('mousemove',event=>add('mousemove',{x:event.clientX,y:event.clientY,eventTime:event.timeStamp}),true);
  document.addEventListener('selectionchange',()=>{
    const selection=window.getSelection();
    add('selectionchange',{anchorOffset:selection?.anchorOffset,focusOffset:selection?.focusOffset});
  });
  function finish(reason){
    if(!trace) return;
    add('finish',{reason});
    const payload=trace;trace=null;
    nativeCancel(heartbeat);
    emit(payload);
  }
  window.addEventListener('mouseup',event=>{
    if(!trace) return;
    add('mouseup',{x:event.clientX,y:event.clientY,eventTime:event.timeStamp});
    // Include the app's mouseup/click work, but do not read geometry or alter
    // selection while sampling. Actual presentation is measured in screen frames.
    setTimeout(()=>finish('mouseup'),80);
  },true);
  window.addEventListener('blur',()=>finish('blur'));
})();
