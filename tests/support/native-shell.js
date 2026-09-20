import * as React from 'react';
import * as DOM from 'react-dom';
import * as Client from 'react-dom/client';
export {React,DOM,Client};
const h=React.createElement;
export function SidebarItem({label,icon,isActive,onClick,...props}){
  return h('button',{className:'sidebar-item',onClick,'aria-current':isActive?'page':undefined,'aria-label':props['aria-label']},icon?h(icon,{className:isActive?'native-active-icon':''}):null,label);
}
export function mount({fragmentRouteRoot=false}={}){
  const listeners=new Set(),history=[{pathname:'/local/start',search:'',hash:'',state:null}];let index=0;
  const navigator={get location(){return history[index];},listen(fn){listeners.add(fn);return()=>listeners.delete(fn);},push(to,state){history.splice(++index);history[index]=typeof to==='string'?{pathname:to,search:'',hash:'',state}:to;listeners.forEach(fn=>fn());},replace(to,state){history[index]=typeof to==='string'?{pathname:to,search:'',hash:'',state}: {...to,state};listeners.forEach(fn=>fn());},go(delta){index=Math.max(0,Math.min(history.length-1,index+delta));listeners.forEach(fn=>fn());}};
  function Route() {throw Error('Route descriptor must never render');}
  const collection=[h(Route,{path:'/inbox',element:h('p',null,'Inbox')}),h(Route,{path:'/connector/oauth_callback',element:null}),h(Route,{path:'/local/start',element:h('input',{id:'native-composer'})})];
  const routeChildren=[h(Route,{path:'/avatar-overlay',element:null,key:'avatar'}),h(Route,{children:fragmentRouteRoot?h(React.Fragment,{children:collection}):collection,key:'main'})];
  const tree=h(Route,{children:fragmentRouteRoot?h(React.Fragment,null,...routeChildren):routeChildren});
  function Routes({children,navigator}){
    const location=React.useSyncExternalStore(navigator.listen,()=>navigator.location);
    const walk=element=>{if(element?.props?.path===location.pathname||element?.props?.path?.endsWith('/*')&&location.pathname.startsWith(element.props.path.slice(0,-2)))return element;for(const child of React.Children.toArray(element?.props?.children)){const match=walk(child);if(match)return match;}};
    return h('main',{'data-app-shell-focus-area':'main'},walk(children)?.props.element??h('p',null,'Native page'));
  }
  const rootNode=document.createElement('div');rootNode.id='root';document.body.appendChild(rootNode);const root=Client.createRoot(rootNode);
  DOM.flushSync(()=>root.render(h(React.Fragment,null,h('nav',null,h(SidebarItem,{label:'Scheduled',animatedIcon:'sidebar-tasks',onClick:()=>navigator.push('/inbox')})),h(Routes,{navigator,children:tree}))));
  return {navigator,tree,routes:collection,Route,dispose:()=>DOM.flushSync(()=>root.unmount())};
}
