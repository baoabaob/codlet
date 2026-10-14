// Codlet's functional icons share one 1.5-unit line weight on a 24-unit grid.
// Use the owning renderer's React; never bundle a second React into a plugin.
export const pluginPuzzlePath='M6.25 4H15.2c1.68 0 2.52 0 3.16.33a3 3 0 0 1 1.31 1.31C20 6.28 20 7.12 20 8.8v6.45A2.75 2.75 0 0 1 17.25 18H15a.5.5 0 0 0-.5.5 2.5 2.5 0 0 1-5 0A.5.5 0 0 0 9 18H6.25A2.25 2.25 0 0 1 4 15.75V14a.5.5 0 0 1 .5-.5 2.5 2.5 0 0 0 0-5A.5.5 0 0 1 4 8V6.25A2.25 2.25 0 0 1 6.25 4Z';
const path=d=>['path',{d}],circle=(cx,cy,r)=>['circle',{cx,cy,r}],dot=(cx,cy)=>['circle',{cx,cy,r:.65,fill:'currentColor',stroke:'none'}];
const shapes={
  ArrowLeft:[path('M19 12H5m6-6-6 6 6 6')],
  ArrowUpRight:[path('M6 18 18 6M7 6h11v11')],
  ChevronDown:[path('m6 9 6 6 6-6')],
  Plus:[path('M12 5v14M5 12h14')],
  X:[path('m6 6 12 12M6 18 18 6')],
  Search:[circle(10.5,10.5,6.5),path('m15.25 15.25 5 5')],
  Download:[path('M12 3v12m-5-5 5 5 5-5M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3')],
  Regenerate:[path('M20 4v5h-5M4 20v-5h5M19.5 8A8 8 0 0 0 5.3 5.3L4 7m.5 9a8 8 0 0 0 14.2 2.7L20 17')],
  ArrowRotateCw:[path('M20 4v5h-5m4.5-1a8 8 0 1 0 .5 7')],
  FolderOpen:[path('M3 18V6a2 2 0 0 1 2-2h4l3 3h6a2 2 0 0 1 2 2v2M3 18l2.4-6.3a1 1 0 0 1 .94-.7H21l-2.4 7.3a1 1 0 0 1-.95.7H4a1 1 0 0 1-1-1Z')],
  ExternalLink:[path('M13 4h7v7m-9 2 9-9M9 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3')],
  Cube:[path('m12 3 8 4.5v9L12 21l-8-4.5v-9L12 3Zm0 9 8-4.5M12 12 4 7.5M12 12v9')],
  CodeSquareSlash:[path('M6 3h12a3 3 0 0 1 3 3v12a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3V6a3 3 0 0 1 3-3Zm2 6-3 3 3 3m8-6 3 3-3 3m-3-8-2 10')],
  PluginPuzzle:[path(pluginPuzzlePath)],
  Globe:[circle(12,12,9),['ellipse',{cx:12,cy:12,rx:3.5,ry:9}],path('M3 12h18')],
  InfoCircle:[circle(12,12,9),path('M12 11v6'),dot(12,7.5)],
  ExclamationMarkCircle:[circle(12,12,9),path('M12 7v6'),dot(12,16.5)],
  QuestionMarkCircle:[circle(12,12,9),path('M9.4 8.7a2.65 2.65 0 0 1 5.2.7c0 2-2.6 2-2.6 4'),dot(12,17)],
  TriangleExclamationErrorWarning:[path('m10.4 4.8-7.8 13.4A1.85 1.85 0 0 0 4.2 21h15.6a1.85 1.85 0 0 0 1.6-2.8L13.6 4.8a1.85 1.85 0 0 0-3.2 0ZM12 9v5'),dot(12,17.5)],
  Star:[path('m12 3 2.8 5.7 6.3.9-4.55 4.45 1.08 6.25L12 17.35l-5.63 2.95 1.08-6.25L2.9 9.6l6.3-.9L12 3Z')]
};
export function createCodletIcons(React,fallback={}){
  const icons={...fallback};
  for(const [name,elements] of Object.entries(shapes)){
    icons[name]=function Icon({className='',filled=false,...props}){
      return React.createElement('svg',{width:'1em',height:'1em',viewBox:'0 0 24 24',fill:filled&&name==='PluginPuzzle'?'currentColor':'none',stroke:filled&&name==='PluginPuzzle'?'none':'currentColor',strokeWidth:1.5,strokeLinecap:'round',strokeLinejoin:'round','aria-hidden':true,focusable:false,...props,className:('codlet-line-icon '+className).trim()},
        ...elements.map(([tag,attributes],key)=>React.createElement(tag,{...attributes,key})));
    };
  }
  return icons;
}
