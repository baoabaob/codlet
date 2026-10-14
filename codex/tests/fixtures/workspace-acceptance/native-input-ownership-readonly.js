// Test-only boolean/count ownership evidence. No draft text/documents, Native
// preference values, setters, sending, navigation, focus or backend requests.
import { loadedAsset, uniqueExport, componentSource } from '../../../frontend/src/host-discovery.js';
import { nativeMainInput } from '../../../frontend/src/adapter/workspace-dom.js';
export async function inspectNativeInputOwnership(document) {
  const shared=await import(loadedAsset('shared'));
  const brand=name=>uniqueExport(shared,value=>value?.__scopeBrand===name&&typeof value.id==='symbol',name);
  const native={composerScope:brand('ComposerScope'),ThreadScope:brand('ThreadScope'),RouteScope:brand('RouteScope'),
    draftKey:uniqueExport(shared,value=>typeof value==='function'&&value.length===1&&['gpt-draft:','draftThreadLocationId','library-preview:','widget-overlay:','clientThreadId'].every(marker=>componentSource(value).includes(marker)),'draft key')};
  const phases=[],diagnose=value=>{if(phases.length<16)phases.push(value);};diagnose.countsOnly=true;
  const input=nativeMainInput(document,native,diagnose);
  return Object.freeze({inputPresent:!!input,kind:input?.scope.value.kind??null,entrypoint:input?.scope.value.entrypoint??null,
    homePlacement:input?.input.getAttribute('data-composer-placement')==='home',
    draftConfirmed:!!input?.draft,composing:input?.controller.view.composing===true,phases:Object.freeze(phases)});
}
