import assert from 'node:assert/strict';
import test from 'node:test';
import {uiFixture,tick} from './support/ui-fixture.mjs';

test('neutral scheduled roots coalesce and retire pending commits',async t=>{
  const f=uiFixture();t.after(()=>f.dispose());
  const ui=f.context.ui.create(),node=ui.container(undefined,{styled:false}),commits=[];
  assert.equal(node.closest('[data-codlet-official-ui]'),null);
  assert.equal(node.getAttribute('style'),null);
  const root=ui.mountReact(node,'first',{onCommit:r=>commits.push(r)});
  const revision=root.render('latest');
  assert.equal(node.textContent,'');
  await tick();
  assert.equal(node.textContent,'latest');assert.deepEqual(commits,[revision]);
  root.render('cancelled');root.unmount();await tick();
  assert.equal(node.textContent,'');assert.deepEqual(commits,[revision]);
  ui.mountReact(node,'immediate',{sync:true});assert.equal(node.textContent,'immediate');
  ui.removeContainer(node);ui.removeContainer(node);assert.equal(node.isConnected,false);
  assert.throws(()=>ui.mountReact(node,'retired'),/belong/);
});

test('unchanged theme produces no container mutations and new containers do not rewrite existing ones',async t=>{
  const f=uiFixture();t.after(()=>f.dispose());
  const ui=f.context.ui.create(),node=ui.container();await tick();
  const records=[];const observer=new f.window.MutationObserver(batch=>records.push(...batch));
  observer.observe(node,{attributes:true});t.after(()=>observer.disconnect());
  ui.container();f.document.documentElement.classList.add('unrelated');await tick();
  assert.equal(records.length,0);
  f.document.documentElement.dataset.theme='dark';await tick();
  assert.equal(node.dataset.theme,'dark');assert.ok(records.length>0);
});

test('a container created during a transient theme change reconciles to the final theme',async t=>{
  const f=uiFixture();t.after(()=>f.dispose());
  const ui=f.context.ui.create(),first=ui.container();
  f.document.documentElement.classList.add('prime-theme-cache');await tick();
  f.document.documentElement.dataset.theme='dark';
  const transient=ui.container();assert.equal(transient.dataset.theme,'dark');
  f.document.documentElement.dataset.theme='light';await tick();
  assert.equal(first.dataset.theme,'light');assert.equal(transient.dataset.theme,'light');
});

test('scheduled updates preserve child state and effects; explicit sync reports after child layout',async t=>{
  const f=uiFixture();t.after(()=>f.dispose());
  const ui=f.context.ui.create(),node=ui.container(undefined,{styled:false}),events=[];
  let mounts=0,cleanups=0;
  function Child({value}){
    ui.React.useLayoutEffect(()=>{mounts++;return()=>cleanups++;},[]);
    ui.React.useLayoutEffect(()=>{events.push('layout:'+value);},[value]);
    return ui.React.createElement('output',null,value);
  }
  const root=ui.mountReact(node,ui.React.createElement(Child,{value:1}),{sync:true,onCommit:r=>events.push('commit:'+r)});
  assert.deepEqual(events,['layout:1','commit:1']);
  root.render(ui.React.createElement(Child,{value:2}),{sync:false});
  assert.equal(node.textContent,'1');await tick();assert.equal(node.textContent,'2');
  const revision=root.render(ui.React.createElement(Child,{value:3}));
  assert.equal(node.textContent,'3');assert.deepEqual(events.slice(-2),['layout:3','commit:'+revision]);
  assert.equal(mounts,1);root.unmount();assert.equal(cleanups,1);
});

test('retirement cancels scheduled commits and keeps other owners alive',async t=>{
  const f=uiFixture();t.after(()=>f.dispose());const baseline=f.observers.size;
  const a=f.context.ui.create(),b=f.context.ui.create(),node=a.container(undefined,{styled:false}),other=b.container();
  let commits=0;const root=a.mountReact(node,'pending',{onCommit:()=>commits++});
  b.mount(other,'other');b.removeContainer(node);assert.equal(node.isConnected,true);
  a.dispose();await tick();assert.equal(commits,0);assert.equal(node.isConnected,false);assert.equal(other.textContent,'other');
  assert.throws(()=>root.render('late'),{code:'ui_disposed'});b.dispose();assert.equal(f.observers.size,baseline);
});

test('removeContainer releases a throwing root, including its pending work',async t=>{
  const f=uiFixture();t.after(()=>f.dispose());const ui=f.context.ui.create(),node=ui.container();
  function Broken(){ui.React.useLayoutEffect(()=>()=>{throw Error('expected cleanup failure');},[]);return 'owned';}
  const root=ui.mountReact(node,ui.React.createElement(Broken),{sync:true});
  root.render('pending',{sync:false});assert.throws(()=>ui.removeContainer(node),/expected cleanup failure/);
  assert.equal(node.isConnected,false);assert.equal(node.childElementCount,0);await tick();
  assert.doesNotThrow(()=>ui.removeContainer(node));assert.throws(()=>root.render('late'),/retired/);
});

test('neutral content and styled controls share state and Escape scope in one root',async t=>{
  const f=uiFixture();t.after(()=>f.dispose());const ui=f.context.ui.create(),h=ui.React.createElement;
  const neutral=ui.container(undefined,{styled:false}),controls=ui.container(),overlay=ui.container();
  let cleanups=0,escapes=0;
  function View(){
    const [count,setCount]=ui.React.useState(0);ui.useEscCloseStack(true,()=>escapes++);
    ui.React.useEffect(()=>()=>cleanups++,[]);
    return h(ui.React.Fragment,null,h('output',null,count),ui.createPortal(h(ui.components.Button,{'aria-label':'Increment',onClick:()=>setCount(value=>value+1)},'Add'),controls));
  }
  ui.mountReact(neutral,h(View),{sync:true,overlay,scope:{contains:target=>[neutral,controls,overlay].some(node=>node.contains(target))}});
  await f.click('Increment');assert.equal(neutral.textContent,'1');assert.equal(neutral.closest('[data-codlet-official-ui]'),null);
  await f.key(f.control('Increment'),'Escape');assert.equal(escapes,1);
  await f.key(f.document.getElementById('host-editor'),'Escape');assert.equal(escapes,1);
  ui.removeContainer(neutral);assert.equal(cleanups,1);assert.equal(controls.childElementCount,0);
  ui.removeContainer(controls);ui.removeContainer(overlay);
});
