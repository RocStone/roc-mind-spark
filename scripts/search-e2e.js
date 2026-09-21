// Async body executed by wk-app-eval.swift against the real canvas page.
// Isolated SQLite from search-e2e.mjs. Exercises the same find widget a user uses.
const results=[];
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function check(condition,message){ if(!condition) throw new Error(message); results.push(message); }

for(let i=0;i<150 && !(typeof map!=='undefined' && map && map.id==='search-a');i++) await sleep(40);
check(map?.id==='search-a','real app booted with the isolated search map');
document.documentElement.classList.add('rms-wk');

function nodeEl(id){ return document.querySelector('.node[data-id="'+id+'"]'); }
function searchInput(){ return document.getElementById('search'); }
function searchWrap(){ return document.getElementById('searchWrap'); }

function pressFind(){
  window.dispatchEvent(new KeyboardEvent('keydown',{
    key:'f', code:'KeyF', metaKey:true, ctrlKey:false, altKey:false, shiftKey:false,
    bubbles:true, cancelable:true
  }));
}
function pressEnterInSearch(){
  const input=searchInput();
  input.dispatchEvent(new KeyboardEvent('keydown',{
    key:'Enter', code:'Enter', bubbles:true, cancelable:true
  }));
}
function typeQuery(q){
  const input=searchInput();
  input.value=q;
  input.dispatchEvent(new Event('input',{bubbles:true}));
}

check(!nodeEl('kernel') && !nodeEl('distro') && !!nodeEl('mint') && !!nodeEl('tools'),
  'folded linux nodes are absent from the canvas; the visible linux mint card is present');
check(map.nodes.tools.collapsed===true && map.nodes.os.collapsed===true,
  'tools and os start folded');

pressFind();
check(searchWrap().classList.contains('open') && document.activeElement===searchInput(),
  '⌘F opens find and focuses the search box');

typeQuery('linux');
check(searchMatches.length===3 && searchMatches[0]==='kernel' && searchMatches[1]==='distro' && searchMatches[2]==='mint',
  'find lists folded hits in tree order: kernel, distro, mint');
check(!nodeEl('kernel'),
  'typing the query does not yet unfold a branch');

pressEnterInSearch();
check(map.nodes.tools.collapsed===false && !!nodeEl('kernel'),
  'first Enter unfolds tools and paints linux kernel');
check(nodeEl('kernel')?.classList.contains('match-current'),
  'the current hit is marked match-current');
check(document.activeElement===searchInput(),
  'caret stays in the search box after Enter');
check(document.getElementById('searchCount')?.textContent==='1 / 3',
  'counter shows 1 / 3');

pressEnterInSearch();
check(map.nodes.tools.collapsed===true && !nodeEl('kernel'),
  'second Enter refolds the unmodified kernel chain');
check(map.nodes.os.collapsed===false && !!nodeEl('distro') && nodeEl('distro').classList.contains('match-current'),
  'second Enter unfolds os and lands on linux distro');
check(document.activeElement===searchInput(),
  'caret stays in the search box on the second Enter');

pressEnterInSearch();
check(map.nodes.os.collapsed===true && !nodeEl('distro'),
  'third Enter refolds the unmodified distro chain');
check(!!nodeEl('mint') && nodeEl('mint').classList.contains('match-current'),
  'third Enter lands on the already-visible linux mint card');

pressEnterInSearch();
check(map.nodes.tools.collapsed===false && !!nodeEl('kernel') && nodeEl('kernel').classList.contains('match-current'),
  'fourth Enter wraps to linux kernel and unfolds tools again');

map.nodes.kernel.text='linux kernel edited';
pressEnterInSearch();
check(map.nodes.tools.collapsed===false && !!nodeEl('kernel'),
  'after editing kernel, leaving it keeps the tools chain open');
check(map.nodes.os.collapsed===false && !!nodeEl('distro') && nodeEl('distro').classList.contains('match-current'),
  'next hit still unfolds os');

pressFind();
check(!searchWrap().classList.contains('open'),
  '⌘F while find is open closes the box');
check(document.getElementById('search').value==='',
  'closing find clears the query');

pressFind();
check(searchWrap().classList.contains('open') && document.activeElement===searchInput(),
  '⌘F opens find again after a close');
pressFind();
check(!searchWrap().classList.contains('open'),
  'a second ⌘F closes find on a fresh open');

return JSON.stringify({environment:'WKWebView find',passed:results.length,checks:results},null,2);
