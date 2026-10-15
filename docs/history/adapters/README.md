# Retired Adapter documentation

These files were imported from `baoabaob/codlet-plugins` at commit `dcdf5166ba10acb54086f95ac28fefed556b560e`. The [move inventory](../document-moves.json) records each original path and hash. Markdown links now resolve from this directory; historical versions, commands, measurements and limitations retain their original meaning.

| Record | Historical scope |
| --- | --- |
| [Adapters](spec/adapters.md) | Former UI/Desktop provider contracts |
| [Workspace API](workspace-api.md) | Pre-consolidation workspace consumer contract |
| [Workspace review](spec/workspace-review.md) | Research, Native evidence and open issues |
| [Traffic](spec/traffic.md) and [request chain](spec/request-chain.md) | Former provider source boundaries and controlled acceptance |
| [Windows startup](spec/windows-startup-bootstrap.md) | Native launch research |
| [Known issues](known-issues.md) | Earlier client/profile and release observations |

Core now owns the maintained implementation, profiles and Native probes under [codex](../../../codex/README.md). New consumers use the [Core Codex SDK](../../spec/codex.md) and [Workspace contract](../../spec/workspace.md). Separate Adapter installation and publishing are retired from v1; historical Adapter repositories and Release downloads remain useful for older installations.

Do not run the commands here unchanged as current product instructions. Use [Core development](../../development.md) and the [current Native driver guide](../../../codex/scripts/README.md).
