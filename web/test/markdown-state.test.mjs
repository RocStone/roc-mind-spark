import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadFns, extractFunction, extractConst } from './helpers/load-app-fns.mjs';

function parser(){
  let counter=0;
  return loadFns(['parseMarkdownOutline','mdInlineToHtml','escapeHtml'],{uid:()=>`new-${++counter}`,INLINE_HTML_RE:extractConst('INLINE_HTML_RE')}).parseMarkdownOutline;
}

describe('Markdown editor node identity',()=>{
  const nodes={
    root:{id:'root',text:'Root',parent:null,side:'root'},
    a:{id:'a',text:'Old',parent:'root',side:'right',marker:'⭐',width:220,color:'#ffeeaa'},
    b:{id:'b',text:'Other',parent:'root',side:'left'}
  };
  test('editing text preserves IDs, marker, width, color and valid link endpoints',()=>{
    const lineMap=[];
    const result=parser()('# Root\n- Changed\n- Other','Map',{
      previousNodes:nodes,nodeIdsByLine:['root','a','b'],lineMap
    });
    assert.equal(result.rootId,'root');
    assert.equal(result.nodes.a.text,'Changed');
    assert.equal(result.nodes.a.marker,'⭐');
    assert.equal(result.nodes.a.width,220);
    assert.equal(result.nodes.a.color,'#ffeeaa');
    assert.equal(result.nodes.b.parent,'root');
    assert.deepEqual(lineMap,['root','a','b']);
    assert.ok(result.nodes.a && result.nodes.b, 'the existing a → b link still resolves');
  });
  test('inserting a node does not apply stale path-indexed metadata to its neighbor',()=>{
    const text='<!-- mindspark\n{"nodes":{"0.0":{"color":"#badbad"}}}\n-->\n\n# Root\n- New\n- Old\n- Other';
    const result=parser()(text,'Map',{
      previousNodes:nodes,nodeIdsByLine:[,,,, 'root',undefined,'a','b'],lineMap:[]
    });
    assert.equal(result.nodes.a.color,'#ffeeaa');
    const added=Object.values(result.nodes).find(n=>n.text==='New');
    assert.ok(added && added.id!=='a');
    assert.equal(added.color,undefined);
  });
  test('removing syntax removes its formatting and task state',()=>{
    const previous={...nodes,a:{...nodes.a,task:'done',bold:true,html:'<pre>old</pre>',notes:'old'}};
    const result=parser()('# Root\n- Plain','Map',{
      previousNodes:previous,nodeIdsByLine:['root','a'],lineMap:[]
    });
    assert.equal(result.nodes.a.task,undefined);
    assert.equal(result.nodes.a.bold,undefined);
    assert.equal(result.nodes.a.html,undefined);
    assert.equal(result.nodes.a.notes,undefined);
    assert.equal(result.nodes.b,undefined);
  });
  test('file imports allocate independent IDs',()=>{
    const parse=parser();
    const first=parse('# Root\n- Child','Map'),second=parse('# Root\n- Child','Map');
    assert.notEqual(first.rootId,second.rootId);
    assert.ok(Object.keys(first.nodes).every(id=>!second.nodes[id]));
  });
  test('source line mapping includes fences and blank lines',()=>{
    const lineMap=[];
    const result=parser()('# Root\n\n```js\nconst x=1;\n```\n- Old','Map',{
      previousNodes:nodes,nodeIdsByLine:['root',,undefined,,, 'a'],lineMap
    });
    assert.equal(lineMap[0],'root');
    assert.equal(lineMap[5],'a');
    assert.match(result.nodes[lineMap[2]].html,/const x=1/);
  });
});

describe('pending Markdown synchronization',()=>{
  function harness(extra=''){
    return new Function('clearTimeout',`
      let mdMode=true,_mdSyncing=false,_mdComposing=false,_mdTimer=42,calls=0;
      function applyMdToMap(){ calls++; }
      ${extractFunction('flushMdEdits')}
      ${extra}
      return {flushMdEdits,get calls(){return calls;},get timer(){return _mdTimer;}};
    `)(()=>{});
  }
  test('flush commits once and consumes the pending timer',()=>{
    const h=harness(); h.flushMdEdits(); h.flushMdEdits();
    assert.equal(h.calls,1); assert.equal(h.timer,0);
  });
  test('does not parse marked IME text or recurse during model synchronization',()=>{
    for(const flag of ['_mdComposing','_mdSyncing']){
      const h=harness(`${flag}=true;`); h.flushMdEdits();
      assert.equal(h.calls,0); assert.equal(h.timer,42);
    }
  });
});
