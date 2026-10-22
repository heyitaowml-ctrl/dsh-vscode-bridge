# DSH VSCode Bridge

Adds a bridge between VS Code and the current DSH conversation.

- VS Code right-click on a selection → `DSH: 发送选中代码到 DSH 对话`
- VS Code right-click on a file in the Explorer → `DSH: 发送文件路径到 DSH 对话`
- DSH receives an `@absolute/path` reference (plus `(line N)` / `(lines A-B)` for a selection) and inserts it at the current composer caret. It does **not** auto-send the message.

## Architecture

```text
VS Code extension
  └─ HTTP POST /dsh-vscode/attach (Bearer token)
       └─ DSH Host plugin (this package)
            └─ SSE /dsh-vscode/events
                 └─ DSH browser plugin
                      └─ conversation.composer.dock → InputActions.insertText()
```

The Host half writes its endpoint and token to `~/.dsh/vscode-bridge.json` (override with `DSH_VSCODE_BRIDGE_FILE`). The VS Code extension reads that file automatically, so no manual token copying is needed. The token file is regenerated when the DSH process/plugin starts.

When no DSH conversation is open, attachments are queued in memory and flushed to the next browser session that connects.

## DSH-side install

This directory is a local DSH bundle. Install it with:

```text
plugin_manager install_bundle target=C:\...\dsh-vscode-bridge
```

After installation, refresh the DSH page once (the client plugin and its injected bridge config are added to the page boot). The bundle is enabled in the profile and survives restarts.

## Endpoints

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| POST | `/dsh-vscode/attach` | Bearer token | Queue/deliver one reference |
| GET | `/dsh-vscode/events` | `token` + `channel` query | SSE stream for the browser half |
| GET | `/dsh-vscode/config` | same-origin page (or Desktop's authenticated forwarded request) | Supplies the browser half with the current token/channel |
| GET | `/dsh-vscode/health` | none | Connection/queue status for the VS Code status command |

The DSH Desktop renderer runs at `dsh-app://app/` and forwards non-asset
requests to the Host with its authentication cookie, so the browser half uses
relative `/dsh-vscode/*` URLs and works both in the Desktop window and in a
normal browser tab.

## Notes

- Paths are sent as absolute paths so DSH does not depend on its workspace matching the VS Code workspace.
- The prompt section `vscode-references` teaches the model that `(lines A-B)` means an inclusive 1-based range to read.
- The browser half renders nothing; it only subscribes and inserts.
- The bridge is loopback-only by design.
