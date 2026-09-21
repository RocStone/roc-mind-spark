// Async body executed by wk-app-eval.swift against the real canvas page.
// Isolated SQLite from md-table-e2e.mjs. Checks GFM tables in view vs edit mode.
const results=[];
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function check(condition,message){ if(!condition) throw new Error(message); results.push(message); }

for(let i=0;i<150 && !(typeof map!=='undefined' && map && map.id==='table-a');i++) await sleep(40);
check(map?.id==='table-a','real app booted with the isolated table map');
document.documentElement.classList.add('rms-wk');
render();
await sleep(40);

function nodeEl(id){ return document.querySelector('.node[data-id="'+id+'"]'); }
function tableIn(id){ return nodeEl(id)?.querySelector('table'); }

const tbl=nodeEl('tbl');
check(!!tbl && tbl.classList.contains('has-md-table'), 'a GFM-only topic gets has-md-table in view mode');
const tblTable=tableIn('tbl');
check(!!tblTable, 'view mode paints an HTML table');
check(tblTable.querySelector('th')?.textContent==='A' && tblTable.querySelector('td')?.textContent==='1',
  'header A and first cell 1 are visible');
check(!tbl.classList.contains('editing') && !tbl.querySelector('.node-text')?.isContentEditable,
  'the painted table is not in an editor');
check(getComputedStyle(tbl).overflow==='visible' && getComputedStyle(tbl).overflowX==='visible',
  'the table card does not clip overflow, so + stays outside');
select('tbl', false);
ensureNodeChrome(tbl);
const plus=tbl.querySelector('.h-child');
check(!!plus, 'selected GFM table still has the add-child plus');
const nr=tbl.getBoundingClientRect();
const pr=plus.getBoundingClientRect();
check(pr.left+0.5>=nr.right, 'add-child plus sits outside the right edge of the card');

const mix=nodeEl('mix');
check(!!mix && mix.classList.contains('has-md-table') && !!tableIn('mix'),
  'a topic with prose plus a GFM table still paints the table');
check((mix.querySelector('.node-md-text')?.textContent||'').indexOf('Notes')>=0,
  'surrounding prose stays next to the table');

const pipes=nodeEl('pipes');
check(!!pipes && !pipes.classList.contains('has-md-table') && !tableIn('pipes'),
  'a pipe line without a separator stays plain text');

startEdit('tbl');
await sleep(40);
const editing=document.querySelector('.node.editing');
check(editing && editing.dataset.id==='tbl', 'double-click path opens the GFM topic for edit');
check(!editing.querySelector('table'), 'edit mode shows Markdown source, not the painted table');
const src=(openEditorTextEl()?.textContent||editing.querySelector('.node-text')?.textContent||'');
check(src.indexOf('| A | B |')>=0 && src.indexOf('| --- | --- |')>=0,
  'edit mode keeps the original GFM source');
commitOpenEdit();
await sleep(40);
check(!document.querySelector('.node.editing') && !!tableIn('tbl'),
  'leaving edit paints the table again');

return JSON.stringify({environment:'WKWebView md-table',passed:results.length,checks:results},null,2);
