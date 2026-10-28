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

**2 · VS Code half** — easiest is the **一键安装** button next to the
`⚠ VS Code 未连接` pill in the composer: the Host runs `code --install-extension` against the
VSIX bundled in this package, so nothing is downloaded. It only runs when you click, and it
needs a `code` CLI it can find (PATH first, then the usual install locations for Windows,
macOS and Linux); if it cannot find one it says so and you install manually:

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

### Where the one-click install looks for `code`

VS Code's installer adds `code` to PATH only when its "Add to PATH" box was left checked, and
a portable or custom-directory install never does. The Host therefore searches, in order:

1. `DSH_VSCODE_CLI` — an explicit path, if you set one
2. the Host's own PATH resolution, for `code`, `code-insiders`, `codium`
3. the Windows registry (`App Paths\Code.exe`), which is the only record of a **custom install
   directory** that never reached PATH — this is what makes a custom install work
4. well-known absolute locations (`%LOCALAPPDATA%\Programs\Microsoft VS Code\bin\code.cmd`,
   `Program Files`, and the macOS/Linux equivalents)

If none of them match, the pill says `cli_not_found` and lists what it tried; set
`DSH_VSCODE_CLI` to your `code` shim to settle it.

### Offline behaviour

`dsh plugin add dsh-vscode-bridge-he` is a single download and brings everything with it —
the Host, the browser half and the `.vsix` (about 82 kB unpacked). The one-click install then
runs `code --install-extension` against that **local** VSIX, so it needs no network at all.
Nothing in the Host or browser half fetches a remote URL; the only external link is the
manual-install page, which opens in a browser and is optional.

### Finding out whether the extension is installed

When the extension is missing, the composer shows a red `⚠ VS Code 扩展未安装` pill with
**一键安装**, **重新检测** and **手动** actions. It disappears once the extension is present.

**Presence is decided by looking, not by remembering.** The Host reads the editor's own
`extensions.json` registry — the only authoritative record of what that editor considers
installed — falling back to the folder layout only for editors that keep no registry:

| Probe | Meaning | Pill |
| --- | --- | --- |
| `installed` | the registry names it (or, with no registry, a matching folder exists) | hidden |
| `absent` | an editor exists and does not have it, **even if leftover folders do** | **shown** |
| `unknown` | no editor directory exists at all (or it is unreadable) | falls back to remembered state |

The registry is what makes this reliable. `code --install-extension` can unpack the VSIX and
still leave the editor's registry untouched — a ghost folder that looks installed but whose
commands never load. Trusting the folder hid the hint for exactly that case; the probe now
reports `absent` and `/health` exposes `extensionRegistered: false` when only the folder
matched. The install endpoint therefore answers `installed_not_registered` instead of
claiming success in that situation.

"Not found" is only trustworthy when there was somewhere to look, so on a layout the Host
cannot recognise it defers to `vscode-bridge-state.json` (next to `vscode-bridge.json`;
override the paths with `DSH_VSCODE_BRIDGE_STATE` and `DSH_VSCODE_EXTENSION_DIRS`).

So if you delete the extension in VS Code, DSH notices on the next page load and offers to
reinstall — that is what the pill is for. Earlier versions recorded "installed" forever and
went silent after a manual uninstall; counting references was worse still, because that
counter starts at zero on every DSH start.

An open page also re-probes every 30 seconds and whenever the tab regains focus, so a
mid-session uninstall brings the pill back without reloading the page.

**Settings → VS Code 桥接** is the permanent home for this: it shows the probe result, the
extension version and path, and offers 立即扫描 / 一键安装 / 手动安装说明. Use it when the pill is
hidden but you want to confirm the extension is really there.

Editing `vscode-bridge-state.json` by hand is safe: a UTF-8 BOM is stripped before parsing.

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
| POST | `/dsh-vscode/install-extension` | same-origin page only | One-click install of the bundled VSIX via the local `code` CLI |

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
