import { build } from 'esbuild';
import postcss from 'postcss';
import tailwind from '@tailwindcss/postcss';
import selectorParser from 'postcss-selector-parser';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const base = dirname(fileURLToPath(import.meta.url));
const root = resolve(base, '..'), out = resolve(base, '.build');
const officialRequire = createRequire(resolve(base, 'node_modules/@openai/apps-sdk-ui/package.json'));
const artifacts = new Map(), usedPackages = new Set();
function collectPackages(meta) {
  for (const output of Object.values(meta.outputs)) for (const [name, value] of Object.entries(output.inputs)) {
    if (!value.bytesInOutput) continue;
    const match=/^(.*node_modules\/(?:@[^/]+\/)?[^/]+)\//.exec(name.replaceAll('\\','/'));
    if (match) usedPackages.add(resolve(base,match[1]));
  }
}
await mkdir(out, { recursive: true });
const bridge = {
  name: 'owned-radix-portals',
  setup(b) {
    b.onLoad({filter: /[\\/]react-dom[\\/]cjs[\\/]react-dom-client\.production\.js$/}, async args => {
      let source=await readFile(args.path,'utf8');
      const changes=[
        ['((ownerDocument[listeningMarker] = !0),','(codletMarkSelectionDocument(ownerDocument, listeningMarker),'],
        ['targetContainer.addEventListener(domEventName, eventSystemFlags, !1);','codletAddUIEventListener(targetContainer, domEventName, eventSystemFlags);'],
      ];
      for(const [from,to] of changes){
        if(source.indexOf(from)<0||source.indexOf(from)!==source.lastIndexOf(from))throw new Error('React document event integration changed; review SDK lifetime ownership');
        source=source.replace(from,to);
      }
      const owner=JSON.stringify(resolve(base,'src/react-document-events.js'));
      return {contents:'"use strict";\nconst { markSelectionDocument: codletMarkSelectionDocument, addUIEventListener: codletAddUIEventListener } = require('+owner+');\n'+source,loader:'js'};
    });
    b.onResolve({filter: /^radix-ui$/}, () => ({path: resolve(base, 'src/radix-bridge.jsx')}));
    b.onResolve({filter: /^radix-original$/}, () => ({path: officialRequire.resolve('radix-ui').replace(/\.js$/, '.mjs')}));
    b.onLoad({filter: /[\\/]useEscCloseStack\.js$/}, async args => {
      let source=await readFile(args.path,'utf8');
      const changes=[
        ['useEffect, useId','useContext, useEffect, useId'],
        ['if (evt.key === "Escape")','if (evt.key === "Escape" && (!evt.defaultPrevented || ownedEscape.has(evt)) && !evt.isComposing && !evt.altKey && !evt.ctrlKey && !evt.metaKey && !evt.shiftKey)'],
        ['const [firstHandler] = handlers;','const firstHandler = handlers.find(handler => handler.scope?.contains(evt.target));'],
        ['evt.preventDefault();','evt.preventDefault(); evt.stopPropagation();'],
        ['const id = useId();','const id = useId(); const scope = useContext(PortalScope);'],
        ['const handler = { id, callback: latestCallback };','const handler = { id, callback: latestCallback, scope };'],
        ['[id, listening, latestCallback]','[id, listening, latestCallback, scope]'],
      ];
      for(const [from,to] of changes){if(!source.includes(from))throw new Error('Upstream Escape hook changed; review scope integration');source=source.replace(from,to);}
      return {contents:'import { PortalScope, ownedEscape } from '+JSON.stringify(resolve(base,'src/portal-context.jsx'))+';\n'+source,loader:'js'};
    });
    b.onLoad({filter: /[\\/]react-use-escape-keydown[\\/]dist[\\/]index\.mjs$/}, async args => {
      let source=await readFile(args.path,'utf8');
      const changes=[
        ['const onEscapeKeyDown = useCallbackRef(onEscapeKeyDownProp);','const onEscapeKeyDown = useCallbackRef(onEscapeKeyDownProp); const scope = React.useContext(PortalScope);'],
        ['if (event.key === "Escape")','if (event.key === "Escape" && scope?.contains(event.target) && !event.defaultPrevented && !event.isComposing && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey)'],
        ['[onEscapeKeyDown, ownerDocument]','[onEscapeKeyDown, ownerDocument, scope]'],
      ];
      for(const [from,to] of changes){if(!source.includes(from))throw new Error('Radix Escape hook changed; review scope integration');source=source.replace(from,to);}
      return {contents:'import { PortalScope } from '+JSON.stringify(resolve(base,'src/portal-context.jsx'))+';\n'+source,loader:'js'};
    });
  },
};
const result = await build({ absWorkingDir: base, entryPoints: ['src/runtime.jsx'], bundle: true, write: false,
  outfile: resolve(out,'runtime.js'), format:'iife', globalName:'CodletOfficialUI', target:'chrome130', minify:true,
  metafile:true, legalComments:'inline', conditions:['style'], define:{'process.env.NODE_ENV':'"production"'}, plugins:[bridge] });
const rawCss = result.outputFiles.find(file=>file.path.endsWith('.css')).text;
// esbuild emits dependency CSS before entry CSS. Establish Tailwind's layer
// order first so the later reset cannot override upstream control styles.
let css = (await postcss([tailwind({base})]).process('@layer theme, base, components, utilities;\n' + rawCss, {from:resolve(out,'runtime.css')})).css;
const ast = postcss.parse(css);
const scope = ':where([data-codlet-official-ui])';
ast.walkRules(rule => {
  if (rule.parent?.type === 'atrule' && /keyframes$/.test(rule.parent.name)) return;
  rule.selector = selectorParser(selectors => {
    selectors.each(selector => {
      let rooted = false;
      selector.walk(node => {
        if ((node.type === 'pseudo' && [':root',':host'].includes(node.value)) || (node.type === 'tag' && ['html','body'].includes(node.value))) {
          node.replaceWith(selectorParser().astSync(scope).nodes[0].nodes[0].clone()); rooted = true;
        }
      });
      if (!rooted) {
        const first = selector.nodes[0];
        if (first?.type === 'attribute' && first.attribute === 'data-theme') selector.prepend(selectorParser().astSync(scope).nodes[0].nodes[0].clone());
        else if (selector.toString().startsWith(':where([data-theme')) {
          selector.prepend(selectorParser().astSync(scope).nodes[0].nodes[0].clone());
        } else {
          selector.prepend(selectorParser.combinator({value:' '})); selector.prepend(selectorParser().astSync(scope).nodes[0].nodes[0].clone());
        }
      }
    });
  }).processSync(rule.selector);
});
// Namespace generated Tailwind custom properties and animation names; no global reset touches the host.
css = ast.toString().replaceAll('--tw-', '--codlet-tw-');
const compiled = postcss.parse(css), animations = new Map();
compiled.walkAtRules(/keyframes$/, rule=>{ const old=rule.params; rule.params='codlet-sdk-'+old; animations.set(old,rule.params); });
compiled.walkDecls(decl=>{ for(const [old,next] of animations) if(decl.prop.includes('animation') || decl.prop.startsWith('--animate-')) decl.value=decl.value.replace(new RegExp('(^|[ ,])'+old+'(?=[ ,]|$)','g'),'$1'+next); });
compiled.walkAtRules('font-face',rule=>rule.remove()); // The selected controls do not use KaTeX fonts.
// Keep our layer names from changing the host's Tailwind cascade order.
css='@layer codlet-sdk {\n'+compiled.toString()+'\n}';
const js=result.outputFiles.find(file=>file.path.endsWith('.js')).text.replace('"__CODLET_OFFICIAL_CSS__"',JSON.stringify(css)).replace(/[ \t]+$/gm,'');
if (js.includes('__CODLET_OFFICIAL_CSS__')) throw new Error('CSS embedding failed');
const banner='// Generated by frontend/build.mjs; edit frontend/src. OpenAI Apps SDK UI 0.2.2, React 19.2.0.\n';
artifacts.set(resolve(root,'bundled/runtime/ui.js'),banner+'(() => { '+js+'; return CodletOfficialUI.default; })()\n');
artifacts.set(resolve(out,'runtime.css'),css);
artifacts.set(resolve(out,'metafile.json'),JSON.stringify(result.metafile,null,2));
collectPackages(result.metafile);
const pageResult=await build({absWorkingDir:base,entryPoints:['src/page.js'],bundle:true,write:false,format:'iife',globalName:'CodletPage',target:'chrome130',minify:true});
artifacts.set(resolve(root,'bundled/runtime/page.js'),'// Generated by frontend/build.mjs; edit frontend/src/page.js.\n(() => { '+pageResult.outputFiles[0].text+'; return CodletPage.default; })()\n');
for (const [entry, destination] of [['src/examples/ui-controls.jsx','examples/ui-controls/renderer.js'],['src/examples/desktop-m3-m4.jsx','examples/desktop-m3-m4/renderer.js']]) {
  const result=await build({absWorkingDir:base,entryPoints:[entry],bundle:true,write:false,metafile:true,format:'cjs',platform:'browser',jsxFactory:'h',jsxFragment:'React.Fragment',target:'chrome130',minify:false,legalComments:'inline',define:{'process.env.NODE_ENV':'"production"'},loader:{'.css':'text','.svg':'text'}});
  artifacts.set(resolve(root,destination),banner+result.outputFiles[0].text);collectPackages(result.metafile);
}
const trafficResult=await build({absWorkingDir:base,entryPoints:[resolve(root,'runtime/host-traffic.cjs')],bundle:true,write:false,metafile:true,format:'cjs',platform:'node',target:'node24',minify:false,legalComments:'inline',nodePaths:[resolve(base,'node_modules')]});
artifacts.set(resolve(root,'runtime/host-traffic-bundle.cjs'),'// Generated by frontend/build.mjs from runtime/host-traffic.cjs; Core traffic SDK bindings.\n'+trafficResult.outputFiles[0].text);
collectPackages(trafficResult.metafile);
const sourceClient=await build({absWorkingDir:base,entryPoints:[resolve(root,'runtime/plaintext-source-client.cjs')],bundle:true,write:false,metafile:true,format:'cjs',platform:'node',target:'node24',minify:false,legalComments:'inline'});
artifacts.set(resolve(root,'runtime/plaintext-source-client-bundle.cjs'),'// Generated by frontend/build.mjs from runtime/plaintext-source-client.cjs; generic authorized launch-source client.\n'+sourceClient.outputFiles[0].text);
const notices = new Map(), missingLicenses=[];
for (const directory of usedPackages) {
  const pkg=JSON.parse(await readFile(resolve(directory,'package.json'),'utf8'));
  const key=pkg.name+'@'+pkg.version;if(notices.has(key))continue;
  let license;
  for(const name of ['LICENSE','LICENSE.md','LICENSE.txt','license','license.md']) {
    try {license=await readFile(resolve(directory,name),'utf8');break;}catch(error){if(error.code!=='ENOENT')throw error;}
  }
  if(!license)try{license=await readFile(resolve(base,'licenses',key.replaceAll('/','__')+'.txt'),'utf8');}catch(error){if(error.code!=='ENOENT')throw error;}
  if(!license){missingLicenses.push(key);continue;}
  notices.set(key,key+' ('+pkg.license+')\n\n'+license.trim());
}
if(missingLicenses.length)throw new Error('Missing bundled dependency notices: '+missingLicenses.join(', '));
const licenseText=('Generated from the packages contributing code/styles to checked-in JavaScript bundles.\n\n'+[...notices].sort(([a],[b])=>a.localeCompare(b)).map(([,text])=>text).join('\n\n------------------------------------------------------------\n\n')+'\n').replace(/[ \t]+$/gm,'');
artifacts.set(resolve(root,'docs/THIRD_PARTY_UI_LICENSES.txt'),licenseText);
// The executable-only update payload also carries the full upstream notices
// through include_str!, without changing its audited file allowlist.
const runtimePath=resolve(root,'bundled/runtime/ui.js');
artifacts.set(runtimePath,artifacts.get(runtimePath)+'\n/*\n'+licenseText.replaceAll('*/','* /')+'*/\n');
// Compile and validate every output before replacing any checked-in bundle.
for(const [path,contents] of artifacts)await writeFile(path,contents);
console.log('Built Core UI SDK, Host traffic runtime and examples; official plugins build independently.');
