import type {RendererUi} from '../types/renderer-ui';
import type {RuntimeManageMethods} from '../types/runtime-manage';
import type {HttpBody, HttpChannelExchange, HttpChannelRequest} from '../types/host';
import type {TrafficRequest, readCodexJsonBody} from '../types/codex-traffic';
import type {TrafficRequest as BundledTrafficRequest} from '../codex/host/codex-traffic';
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
const combinedUpdate: RuntimeManageMethods['installCombinedUpdate']['params']={candidateId:'core-candidate',targetId:'official-target'};
void combinedUpdate;
// @ts-expect-error Combined update consent must bind the official target identity.
const unboundCombinedUpdate: RuntimeManageMethods['installCombinedUpdate']['params']={candidateId:'core-candidate'};
void unboundCombinedUpdate;

const absentHostBody: HttpChannelRequest['body']=null;
const absentTrafficBody: TrafficRequest['body']=null;
const absentBundledBody: BundledTrafficRequest['body']=null;
void absentHostBody;void absentTrafficBody;void absentBundledBody;
// @ts-expect-error The body key is present even when no body was supplied.
const missingHostBody: Pick<HttpChannelRequest,'body'>={};
void missingHostBody;

async function consumeHostBody(request: HttpChannelRequest) {
  // @ts-expect-error A bodyless Native request has no HttpBody methods.
  const unguarded: HttpBody=request.body;
  void unguarded;
  if(request.body===null)return;
  for await(const chunk of request.body){const bytes:Uint8Array=chunk;void bytes;}
}
async function forwardHostBody(request: HttpChannelRequest, exchange: HttpChannelExchange) {
  const response=await exchange.forward({url:'https://example.invalid/',method:request.method,body:request.body});
  const body:HttpBody|null=response.body;
  // @ts-expect-error A bodyless upstream response has no cancellation methods.
  const unguarded:HttpBody=response.body;
  void unguarded;
  if(body!==null)await body.cancelAndWait();
}
declare const readJsonBody: typeof readCodexJsonBody;
async function readTrafficBody(request: TrafficRequest|BundledTrafficRequest) {
  // @ts-expect-error Parsing a nullable Native body requires a non-null branch.
  const unguarded=readJsonBody(request);
  void unguarded;
  if(request.body===null)return null;
  return readJsonBody({headers:request.headers,body:request.body});
}
void consumeHostBody;void forwardHostBody;void readTrafficBody;
