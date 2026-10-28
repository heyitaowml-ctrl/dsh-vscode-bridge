# DSH VSCode Bridge

Send a VS Code selection or a file path into the conversation you already have open in
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) — as an `@path`
reference, inserted at the composer caret. It does **not** send the message for you.

> **This package is only the DSH half.** It needs the companion VS Code extension to do
> anything; installing this alone gives you an idle bridge. Both halves are in the
> [repository](https://github.com/heyitaowml-ctrl/dsh-vscode-bridge):
> `dsh-vscode-bridge/` (this package) and `vscode-dsh-bridge/` (the extension).

## Install

**1 · DSH half** — one command, then refresh the DSH page once:

```sh
dsh plugin --profile <profile> add dsh-vscode-bridge-he
```

**2 · VS Code half** — pick one:

- **Extensions view:** open VS Code → Extensions → `…` → **Install from VSIX…** → choose
  [`dist/dsh-vscode-bridge.vsix`](https://github.com/heyitaowml-ctrl/dsh-vscode-bridge/raw/master/dist/dsh-vscode-bridge.vsix)
- **Terminal:**
  ```sh
  code --install-extension dsh-vscode-bridge.vsix
  ```

Reload the VS Code window afterwards (`Ctrl+Shift+P` → **Developer: Reload Window**); the
commands appear under **DSH** in the editor and Explorer context menus.

The extension discovers the Host by itself: DSH writes its endpoint and token to
`~/.dsh/vscode-bridge.json` (override with `DSH_VSCODE_BRIDGE_FILE`) on every start, so
there is no token to copy by hand.

### Finding out whether the extension is connected

The composer shows a small `⚠ VS Code 未连接` pill until the extension has sent its first
reference. It disappears on first use and stays hidden afterwards; the `×` dismisses it for
the current page.

Zero references is the only signal the Host has, so the pill cannot tell "extension not
installed" apart from "installed but never used" — it deliberately says *not connected*
rather than *not installed*. If you have just installed the extension and the pill stays,
reload the VS Code window.

## Usage

- Select lines, right-click in the editor → **DSH: 发送选中代码到 DSH 对话**
- Right-click a file or folder in the Explorer → **DSH: 发送文件路径到 DSH 对话**
- Switch back to DSH: the reference is already at the caret, and nothing has been sent.

```text
@C:\project\src\main.ts (lines 12-28)
@C:\project\src\main.ts
@"C:\project\my folder\main.ts" (line 7)
```

Line markers are inclusive and 1-based; the prompt section `vscode-references` tells the
model to read that range rather than guess.

## Architecture

```text
VS Code extension
  └─ HTTP POST /dsh-vscode/attach (Bearer token)
       └─ DSH Host plugin (this package)
            └─ SSE /dsh-vscode/events
                 └─ DSH browser plugin
                      └─ conversation.input.left → InputActions.insertText()
```

When no DSH conversation is open, attachments are queued in memory and flushed to the next
browser session that connects.

## Endpoints

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| POST | `/dsh-vscode/attach` | Bearer token | Queue or deliver one reference |
| GET | `/dsh-vscode/events` | `token` + `channel` query | SSE stream consumed by the browser half |
| GET | `/dsh-vscode/config` | same-origin page | Supplies the browser half with the current token/channel |
| GET | `/dsh-vscode/health` | none | Connection, queue and `attachments` count for the status command |

`/health` and the SSE `hello` frame both report `attachments` (how many references the
extension has ever sent to this Host instance) and `lastAttachAt`. That pair drives the
composer hint above.

## Notes

- Paths are sent absolute, so DSH does not have to share a workspace with VS Code.
- The browser half renders nothing except the connection hint.
- **The bridge is loopback-only by design.** The Host binds locally, every request carries a
  per-process bearer token, and the token file is regenerated on each start.
- This package is unrelated to [`dsh-vscode-bridge`](https://www.npmjs.com/package/dsh-vscode-bridge)
  on npm, which is a different plugin by a different author.

## License

MulanPSL-2.0
