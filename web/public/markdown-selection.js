/* WKWebView drag selection. The browser supplies glyph geometry; this module
 * owns only the temporary highlight and commits a native selection on release.
 * No map, Markdown parser, persistence, or canvas state belongs here. */
function mdSelectionIndex(root){
  const entries=[], starts=new WeakMap(), ends=new WeakMap();
  let length=0;
  function walk(node){
    starts.set(node, length);
    if(node.nodeType===3){
      entries.push({node, start:length, end:length+node.nodeValue.length});
      length+=node.nodeValue.length;
    } else if(node.nodeType===1 && (node===root || node.getAttribute('contenteditable')!=='false')){
      for(const child of node.childNodes) walk(child);
    }
    ends.set(node, length);
  }
  walk(root);
  function offset(node, at){
    if(!starts.has(node)) return null;
    if(node.nodeType===3) return starts.get(node)+Math.max(0, Math.min(at, node.nodeValue.length));
    const child=node.childNodes[at];
    return child && starts.has(child) ? starts.get(child) : ends.get(node);
  }
  function point(at){
    at=Math.max(0, Math.min(at, length));
    let lo=0, hi=entries.length;
    while(lo<hi){
      const mid=(lo+hi)>>1;
      if(entries[mid].end<at) lo=mid+1; else hi=mid;
    }
    const entry=entries[lo];
    return entry ? {node:entry.node, offset:at-entry.start} : {node:root, offset:0};
  }
  return {length, offset, point};
}

// Inline elements and their text may report overlapping rectangles. Union the
// overlaps so syntax-highlight spans do not paint the same glyph twice.
function mdSelectionRects(rects, box){
  const rows=[];
  for(const r of rects){
    const top=Math.max(box.top, r.top), bottom=Math.min(box.bottom, r.bottom);
    const left=Math.max(box.left, r.left), right=Math.min(box.right, Math.max(r.right, r.left+2));
    if(bottom<=top || right<=left) continue;
    rows.push({left, right, top, bottom});
  }
  rows.sort((a,b)=>a.top-b.top || a.left-b.left);
  const merged=[];
  for(const row of rows){
    const prev=merged[merged.length-1];
    if(prev && Math.abs(prev.top-row.top)<1 && Math.abs(prev.bottom-row.bottom)<1 && row.left<=prev.right+1){
      prev.right=Math.max(prev.right, row.right);
    } else merged.push(row);
  }
  return merged;
}

function createMarkdownSelection(editor, layer, onCommit){
  let drag=null, raf=0, listeners=null;
  const win=editor.ownerDocument.defaultView, doc=editor.ownerDocument;
  function range(){
    return drag ? {s:Math.min(drag.anchor, drag.end), e:Math.max(drag.anchor, drag.end)} : null;
  }
  function cancel(){
    if(raf) win.cancelAnimationFrame(raf);
    raf=0;
    if(listeners) listeners.abort();
    listeners=null; drag=null;
    layer.replaceChildren();
    editor.classList.remove('md-drag-sel');
  }
  function hit(x,y,box){
    x=Math.max(box.left+1, Math.min(x, box.right-1));
    y=Math.max(box.top+1, Math.min(y, box.bottom-1));
    const caret=doc.caretRangeFromPoint(x,y);
    return caret ? drag.index.offset(caret.startContainer, caret.startOffset) : null;
  }
  function paint(box){
    const selected=range();
    if(!selected || selected.s===selected.e){ layer.replaceChildren(); return; }
    // Only ask WebKit for rectangles within the visible slice. A selection
    // spanning thousands of lines must not enumerate thousands of rectangles.
    const first=hit(box.left+drag.padLeft, box.top+1, box);
    const last=hit(box.right-1, box.bottom-1, box);
    const start=Math.max(selected.s, first==null ? selected.s : first);
    const end=Math.min(selected.e, last==null ? selected.e : last);
    if(end<start){ layer.replaceChildren(); return; }
    const a=drag.index.point(start), b=drag.index.point(end);
    const selection=doc.createRange();
    selection.setStart(a.node,a.offset); selection.setEnd(b.node,b.offset);
    const rects=mdSelectionRects(selection.getClientRects(),box);
    // Read all geometry before updating the highlight. Reuse nodes between
    // frames; no innerHTML parsing or repeated layout reads inside this loop.
    while(layer.children.length>rects.length) layer.lastElementChild.remove();
    rects.forEach((r,i)=>{
      let item=layer.children[i];
      if(!item){ item=doc.createElement('i'); layer.appendChild(item); }
      item.style.cssText='left:'+(r.left-box.left)+'px;top:'+(r.top-box.top)+'px;width:'+(r.right-r.left)+'px;height:'+(r.bottom-r.top)+'px';
    });
  }
  function update(timestamp, scroll){
    if(!drag) return false;
    const box=editor.getBoundingClientRect();
    const dt=Math.min(32, Math.max(0, timestamp-drag.time));
    drag.time=timestamp;
    const dx=drag.x<box.left+16 ? -1 : drag.x>box.right-16 ? 1 : 0;
    const dy=drag.y<box.top+16 ? -1 : drag.y>box.bottom-16 ? 1 : 0;
    const oldX=editor.scrollLeft, oldY=editor.scrollTop;
    if(scroll){
      editor.scrollLeft+=dx*dt*0.7;
      editor.scrollTop+=dy*dt*0.7;
    }
    const end=hit(drag.x,drag.y,box);
    if(end!=null) drag.end=end;
    paint(box);
    return editor.scrollLeft!==oldX || editor.scrollTop!==oldY;
  }
  function frame(timestamp){
    raf=0;
    if(update(timestamp,true)) schedule();
  }
  function schedule(){ if(drag && !raf) raf=win.requestAnimationFrame(frame); }
  function finish(event){
    if(!drag) return;
    if(event){ drag.x=event.clientX; drag.y=event.clientY; }
    update(win.performance.now(),false);
    const {anchor,end,index}=drag;
    cancel();
    const a=index.point(anchor), b=index.point(end), sel=win.getSelection();
    sel.setBaseAndExtent(a.node,a.offset,b.node,b.offset);
    if(onCommit) onCommit();
  }
  editor.addEventListener('mousedown', event=>{
    // Double/triple click remain WebKit word/paragraph selection. Composition
    // stays native until the IME has committed its marked text.
    if(event.button!==0 || event.detail>1 || event.isComposing) return;
    cancel();
    editor.focus();
    const index=mdSelectionIndex(editor), sel=win.getSelection();
    const anchor=event.shiftKey && sel ? index.offset(sel.anchorNode,sel.anchorOffset) : null;
    const css=win.getComputedStyle(editor);
    drag={index,anchor:0,end:0,x:event.clientX,y:event.clientY,time:win.performance.now(),padLeft:parseFloat(css.paddingLeft)||0};
    const start=hit(drag.x,drag.y,editor.getBoundingClientRect());
    if(start==null){ cancel(); return; }
    event.preventDefault();
    drag.anchor=anchor==null ? start : anchor;
    drag.end=start;
    // Clear the previous native highlight while using the custom one.
    const point=index.point(drag.anchor);
    sel.setBaseAndExtent(point.node,point.offset,point.node,point.offset);
    editor.classList.add('md-drag-sel');
    listeners=new AbortController();
    const options={capture:true,signal:listeners.signal};
    win.addEventListener('mousemove', move=>{
      // NSEvent-backed WK drags can report buttons=0; mouseup/blur own cleanup.
      drag.x=move.clientX; drag.y=move.clientY;
      schedule();
    },options);
    win.addEventListener('mouseup',finish,options);
    win.addEventListener('blur',cancel,options);
    doc.addEventListener('visibilitychange',()=>{ if(doc.hidden) cancel(); },options);
    editor.addEventListener('scroll',schedule,{passive:true,signal:listeners.signal});
    // DOM-changing edits invalidate the gesture's one-time text index.
    editor.addEventListener('beforeinput',()=>finish(),options);
    editor.addEventListener('compositionstart',()=>finish(),options);
    schedule();
  });
  return {range,cancel,get active(){ return !!drag; }};
}
