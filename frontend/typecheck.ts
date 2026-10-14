import type {RendererUi} from '../types/renderer-ui';
declare const ui: RendererUi;
const neutral=ui.container(undefined,{styled:false}),controls=ui.container();
const scheduled=ui.mountReact(neutral,null,{
  overlay:controls,
  scope:{contains:node=>neutral.contains(node)||controls.contains(node)},
  onCommit(revision){const version:number=revision;void version;},
});
const revision:number=scheduled.render(null,{sync:false});void revision;
ui.removeContainer(neutral);ui.removeContainer(controls);
ui.page({label:'Example',icon:'Cube',render:()=>ui.React.createElement(ui.components.Button,{color:'primary',variant:'solid',size:'md',children:'Run'})});
ui.React.createElement(ui.components.Switch,{checked:true,onCheckedChange(value){const checked:boolean=value;void checked;}});
ui.React.createElement(ui.components.Checkbox,{checked:false,onCheckedChange(value){const checked:boolean|'indeterminate'=value;void checked;}});
// @ts-expect-error No renderer approximation API remains.
ui.button({text:'Old button'});
// @ts-expect-error Use the official Button color contract.
ui.React.createElement(ui.components.Button,{color:'invented'});
