# Changelog

## 1.0.1

- Marketplace-ready packaging: PNG icon, real `publisher` id, `repository` metadata so the
  Marketplace can resolve relative README links.
- Built with the official `vsce` CLI; the hand-maintained `vsix/` manifest is gone.

## 1.0.0

- Initial release.
- Editor context menu: send selected code range to the current DSH conversation.
- Explorer context menu: send a file or directory absolute path.
- Automatic endpoint/token discovery through `~/.dsh/vscode-bridge.json`.
- Queueing when no DSH conversation is open.
- Status command and output channel.
