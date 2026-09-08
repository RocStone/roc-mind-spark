import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadFns } from './helpers/load-app-fns.mjs';

const {mdSelectionIndex,mdSelectionRects}=loadFns(['mdSelectionIndex','mdSelectionRects']);
const text=value=>({nodeType:3,nodeValue:value});
const element=(children,editable=null)=>({nodeType:1,childNodes:children,getAttribute:()=>editable});

test('selection index handles syntax spans, Unicode UTF-16 offsets and element boundaries',()=>{
  const a=text('中文🙂'),b=text('bold'),span=element([b]),root=element([a,span,text('\nend')]);
  const index=mdSelectionIndex(root);
  assert.equal(index.length,12);
  assert.equal(index.offset(root,1),4);
  assert.equal(index.offset(span,1),8);
  assert.equal(index.offset(b,2),6);
  assert.deepEqual(index.point(6),{node:b,offset:2});
  assert.equal(index.offset({},0),null);
});

test('readonly editor still supports selection; noneditable annotations are excluded',()=>{
  const a=text('a'),chip=element([text('annotation')],'false'),b=text('b');
  const index=mdSelectionIndex(element([a,chip,b],'false'));
  assert.equal(index.length,2);
  assert.equal(index.offset(b,1),2);
});

test('selection paint clips offscreen rows and merges duplicate inline rectangles',()=>{
  const rows=mdSelectionRects([
    {left:-10,right:30,top:10,bottom:25},
    {left:0,right:20,top:10,bottom:25},
    {left:30,right:90,top:10,bottom:25},
    {left:10,right:50,top:130,bottom:145},
    {left:0,right:20,top:30,bottom:45}
  ],{left:0,right:80,top:0,bottom:100});
  assert.deepEqual(rows,[{left:0,right:80,top:10,bottom:25},{left:0,right:20,top:30,bottom:45}]);
});
