# Windows directory activation — Preview 2

Opening a registered plugin or the installation/log directory previously called
`ShellExecuteW` from a short-lived background STA. Explorer could open behind the
client. A synchronous Shell dispatch alone was reproduced as insufficient when
the launcher did not hold foreground permission.

The session-owned native bridge now exposes a fixed foreground handoff. It checks
that the retained Core owner is alive and that the foreground window belongs to
this launched client, then calls `AllowSetForegroundWindow` for that Core only.
There is no arbitrary PID parameter, global foreground permission, input
simulation, topmost window, or attach to unrelated applications. The handoff is
requested only for the existing management directory operations. If unavailable,
opening still works with the ordinary Windows foreground restrictions.

Directory dispatch uses `ShellExecuteExW` with a fixed folder class and explore
verb, `SW_SHOWNORMAL`, `SEE_MASK_NOASYNC`, and `SEE_MASK_FLAG_LOG_USAGE`. The
existing path validation, registry lookup and directory pins remain in place.
The native bridge's initialization and updater interception ABI is unchanged.

References:
- [Windows foreground permission](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-allowsetforegroundwindow)
- [Shell dispatch flags](https://learn.microsoft.com/en-us/windows/win32/api/shellapi/ns-shellapi-shellexecuteinfow)

Validation:
- Windows Rust regressions: 42 passed; interactive acceptance passed separately
- `cargo clippy --locked --lib -- -D warnings`: passed
- Native restart interception and immediate-child-exit tests, including rejection
  of foreground requests from a headless or exited client
- Opt-in `foreground_client_hands_directory_activation_to_core`: a separate local
  window grants its Core permission; opening a unique directory makes that exact
  Explorer window foreground; the now-background client rejects further grants
- Local GUI regressions: 30 passed, covering both languages and the Codex draft
  action. The removal sentence uses shared typography, baseline alignment and a
  wrapping link with explicit spacing

The GUI bundle was reloaded successfully in the current installed instance. Core
changes require closing that instance and installing Preview 2. MSI upgrade on
the user's live installation is deliberately left to the user, since this task
is running inside that client.
