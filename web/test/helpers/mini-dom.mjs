// A tiny, dependency-free DOM good enough to run app.js's HTML sanitizers under
// node:test (the repo ships no jsdom). It implements only what those functions
// touch: <template>.content, innerHTML parse/serialize, childNodes mutation,
// attributes, textContent, and simple tag-name querySelector(All).
//
// The tokenizer follows the HTML spec where it matters for sanitizer tests:
// "/" between attributes acts as a separator (so <img/src=x/onerror=1> yields
// src and onerror attributes, exactly as a browser parses it), unquoted and
// single-quoted values, raw-text elements (script/style/…), comments.

const VOID = new Set(['area','base','br','col','embed','hr','img','input','link','meta','source','track','wbr']);
const RAW = new Set(['script','style','xmp','iframe','noembed','noframes','noscript','textarea','title']);
const ENT = { amp:'&', lt:'<', gt:'>', quot:'"', apos:"'", nbsp:' ', rarr:'→', larr:'←', hellip:'…', mdash:'—', ndash:'–', copy:'©' };

function decode(s){
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (m, e) => {
    if(e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return Object.prototype.hasOwnProperty.call(ENT, e.toLowerCase()) ? ENT[e.toLowerCase()] : m;
  });
}

class Node {
  constructor(type){ this.nodeType = type; this.parentNode = null; this.childNodes = []; }
  get firstChild(){ return this.childNodes[0] || null; }
  get lastChild(){ return this.childNodes[this.childNodes.length - 1] || null; }
  get parentElement(){ return this.parentNode && this.parentNode.nodeType === 1 ? this.parentNode : null; }
  get children(){ return this.childNodes.filter(c => c.nodeType === 1); }
  _detach(n){ if(n.parentNode){ const p = n.parentNode; const i = p.childNodes.indexOf(n); if(i >= 0) p.childNodes.splice(i, 1); n.parentNode = null; } }
  insertBefore(n, ref){
    if(n.nodeType === 11){ [...n.childNodes].forEach(c => this.insertBefore(c, ref)); return n; }
    this._detach(n);
    const i = ref ? this.childNodes.indexOf(ref) : -1;
    if(i < 0) this.childNodes.push(n); else this.childNodes.splice(i, 0, n);
    n.parentNode = this;
    return n;
  }
  appendChild(n){ return this.insertBefore(n, null); }
  removeChild(n){ this._detach(n); return n; }
  replaceChild(n, old){ this.insertBefore(n, old); this.removeChild(old); return old; }
  remove(){ this._detach(this); }
  replaceWith(n){ if(this.parentNode) this.parentNode.replaceChild(n, this); }
  get textContent(){
    if(this.nodeType === 3 || this.nodeType === 8) return this.nodeValue;
    return this.childNodes.filter(c => c.nodeType !== 8).map(c => c.textContent).join('');
  }
  set textContent(v){ this.childNodes.forEach(c => { c.parentNode = null; }); this.childNodes = []; if(v) this.appendChild(new Text(String(v))); }
  querySelectorAll(sel){
    const groups = sel.split(',').map(g => g.trim().toLowerCase().split(/\s+/));
    const out = [];
    const matches = (el, chain) => {
      if(el.localName !== chain[chain.length - 1]) return false;
      let k = chain.length - 2, p = el.parentElement;
      while(k >= 0 && p){ if(p.localName === chain[k]) k--; p = p.parentElement; }
      return k < 0;
    };
    const walk = n => n.childNodes.forEach(c => {
      if(c.nodeType !== 1) return;
      if(groups.some(g => matches(c, g))) out.push(c);
      walk(c);
    });
    walk(this);
    return out;
  }
  querySelector(sel){ return this.querySelectorAll(sel)[0] || null; }
}
class Text extends Node { constructor(v){ super(3); this.nodeValue = v; } }
class Comment extends Node { constructor(v){ super(8); this.nodeValue = v; } }
class Fragment extends Node { constructor(){ super(11); } }
class Element extends Node {
  constructor(tag){
    super(1);
    this.localName = tag.toLowerCase();
    this.tagName = this.localName.toUpperCase();
    this.attributes = [];
    if(this.localName === 'template') this.content = new Fragment();
  }
  getAttribute(n){ const a = this.attributes.find(a => a.name === n.toLowerCase()); return a ? a.value : null; }
  hasAttribute(n){ return this.getAttribute(n) !== null; }
  setAttribute(n, v){ n = n.toLowerCase(); const a = this.attributes.find(a => a.name === n); if(a) a.value = String(v); else this.attributes.push({ name:n, value:String(v) }); }
  removeAttribute(n){ n = n.toLowerCase(); this.attributes = this.attributes.filter(a => a.name !== n); }
  get dataset(){ const o = {}; this.attributes.forEach(a => { if(a.name.startsWith('data-')) o[a.name.slice(5)] = a.value; }); return o; }
  get innerHTML(){ return serializeChildren(this.localName === 'template' ? this.content : this, this.localName); }
  set innerHTML(html){
    const host = this.localName === 'template' ? this.content : this;
    host.childNodes.forEach(c => { c.parentNode = null; });
    host.childNodes = [];
    parseInto(host, String(html == null ? '' : html));
  }
  get outerHTML(){ return serializeNode(this, ''); }
}

function escText(s){ return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/ /g, '&nbsp;'); }
function escAttr(s){ return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/ /g, '&nbsp;'); }
function serializeNode(n, parentTag){
  if(n.nodeType === 3) return RAW.has(parentTag) ? n.nodeValue : escText(n.nodeValue);
  if(n.nodeType === 8) return '<!--' + n.nodeValue + '-->';
  if(n.nodeType === 11) return serializeChildren(n, '');
  const attrs = n.attributes.map(a => ' ' + a.name + '="' + escAttr(a.value) + '"').join('');
  if(VOID.has(n.localName)) return '<' + n.localName + attrs + '>';
  const inner = n.localName === 'template' ? serializeChildren(n.content, 'template') : serializeChildren(n, n.localName);
  return '<' + n.localName + attrs + '>' + inner + '</' + n.localName + '>';
}
function serializeChildren(host, tag){ return host.childNodes.map(c => serializeNode(c, tag)).join(''); }

// --- tokenizer + naive tree builder ----------------------------------------
function parseInto(root, html){
  const stack = [root];
  const cur = () => stack[stack.length - 1];
  const hostOf = el => (el.localName === 'template' ? el.content : el);
  const addText = t => { if(!t) return; const h = hostOf(cur()); const last = h.lastChild; if(last && last.nodeType === 3) last.nodeValue += t; else h.appendChild(new Text(t)); };
  let i = 0; const L = html.length;
  while(i < L){
    const lt = html.indexOf('<', i);
    if(lt < 0){ addText(decode(html.slice(i))); break; }
    if(lt > i) addText(decode(html.slice(i, lt)));
    i = lt;
    if(html.startsWith('<!--', i)){
      const end = html.indexOf('-->', i + 4);
      const v = end < 0 ? html.slice(i + 4) : html.slice(i + 4, end);
      hostOf(cur()).appendChild(new Comment(v));
      i = end < 0 ? L : end + 3; continue;
    }
    if(html[i + 1] === '!' || html[i + 1] === '?'){
      const end = html.indexOf('>', i); i = end < 0 ? L : end + 1; continue;   // doctype / bogus comment
    }
    if(html[i + 1] === '/'){
      const m = /^<\/([a-zA-Z][^\s/>]*)[^>]*>?/.exec(html.slice(i));
      if(!m){ addText('<'); i++; continue; }
      const tag = m[1].toLowerCase();
      for(let k = stack.length - 1; k > 0; k--){ if(stack[k].localName === tag){ stack.length = k; break; } }
      i += m[0].length; continue;
    }
    if(!/[a-zA-Z]/.test(html[i + 1] || '')){ addText('<'); i++; continue; }
    // start tag
    let j = i + 1, name = '';
    while(j < L && !/[\s/>]/.test(html[j])) name += html[j++];
    const el = new Element(name);
    let selfClose = false;
    for(;;){
      while(j < L && (/\s/.test(html[j]) || html[j] === '/')){ if(html[j] === '/' && html[j + 1] === '>') selfClose = true; j++; }
      if(j >= L){ break; }
      if(html[j] === '>'){ j++; break; }
      let an = html[j++];
      while(j < L && !/[\s/>=]/.test(html[j])) an += html[j++];
      while(j < L && /\s/.test(html[j])) j++;
      let av = '';
      if(html[j] === '='){
        j++; while(j < L && /\s/.test(html[j])) j++;
        const q = html[j];
        if(q === '"' || q === "'"){ const e = html.indexOf(q, j + 1); av = html.slice(j + 1, e < 0 ? L : e); j = e < 0 ? L : e + 1; }
        else { while(j < L && !/[\s>]/.test(html[j])) av += html[j++]; }
      }
      an = an.toLowerCase();
      if(!el.hasAttribute(an)) el.attributes.push({ name:an, value:decode(av) });
    }
    i = j;
    hostOf(cur()).appendChild(el);
    if(RAW.has(el.localName)){
      const close = new RegExp('</' + el.localName + '\\s*>', 'i');
      const rest = html.slice(i); const m = close.exec(rest);
      const raw = m ? rest.slice(0, m.index) : rest;
      if(raw) el.appendChild(new Text(el.localName === 'textarea' || el.localName === 'title' ? decode(raw) : raw));
      i += m ? m.index + m[0].length : rest.length;
      continue;
    }
    if(!VOID.has(el.localName) && !selfClose) stack.push(el);
  }
}

export function makeDocument(){
  return {
    createElement: tag => new Element(tag),
    createTextNode: v => new Text(String(v)),
    createDocumentFragment: () => new Fragment(),
  };
}

// A minimal DOMParser: parseFromString(html, 'text/html') -> { body }.
export class DOMParser {
  parseFromString(html){
    const body = new Element('body');
    body.innerHTML = html;
    return { body, documentElement: body, querySelector: s => body.querySelector(s) };
  }
}
