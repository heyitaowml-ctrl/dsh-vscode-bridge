# DSH VSCode Bridge

VS Code 与 DSH 之间的上下文桥接。它把当前选中的代码范围或文件绝对路径添加到**当前 DSH 对话的输入框**，不会自动发送消息。

## 功能

- 在编辑器中选中代码 → 右键 → **DSH: 发送选中代码到 DSH 对话**
- 在资源管理器中右键文件/文件夹 → **DSH: 发送文件路径到 DSH 对话**
- 没有选中内容时，在编辑器右键会发送当前文件
- 发送内容形如：

  ```text
  @C:\project\src\main.ts (lines 12-28)
  @C:\project\src\main.ts
  @"C:\project\my folder\main.ts" (line 7)
  ```

- 如果 DSH 对话没有打开，引用会排队；打开 DSH 后自动插入。

## 安装

先确认已安装并启用 DSH 侧的 `@local/dsh-vscode-bridge` bundle，然后：

1. 在 VS Code 中打开扩展视图（`Ctrl+Shift+X`）。
2. 点击右上角 `...` → **Install from VSIX...**。
3. 选择 `dsh-vscode-bridge-1.0.0.vsix`。
4. 重新加载 VS Code 窗口。

也可以使用命令行：

```powershell
code --install-extension .\dsh-vscode-bridge-1.0.0.vsix --force
```

## 配置

通常不需要配置。扩展会自动读取 DSH 写入的 `~/.dsh/vscode-bridge.json`，其中包含当前 DSH 的地址和令牌。

如 DSH 使用了非默认位置，可设置：

| 设置 | 默认 | 说明 |
| --- | --- | --- |
| `dsh.bridge.url` | 空 | 手动指定 DSH 地址；留空则读取配置文件 |
| `dsh.bridge.token` | 空 | 手动指定令牌；一般留空 |
| `dsh.bridge.tokenFile` | 空 | 手动指定桥接配置文件路径 |

令牌只发送到本机回环地址（`localhost` / `127.0.0.1` / `::1`）。

## 使用

1. 启动 DSH，打开一个对话。
2. 在 VS Code 中选中代码，右键选择 **DSH: 发送选中代码到 DSH 对话**。
3. 切回 DSH，引用已经出现在输入框中；继续输入你的问题并发送。

## 命令

| 命令 | 说明 |
| --- | --- |
| `DSH: 发送选中代码到 DSH 对话` | 发送当前选区，或当前文件（无选区时） |
| `DSH: 发送文件路径到 DSH 对话` | 发送活动文件或资源管理器中选中的文件/目录 |
| `DSH: 显示 DSH 桥接状态` | 查看 DSH 是否已连接、队列长度、服务地址 |
| `DSH: 打开 DSH 桥接设置` | 打开本扩展的设置 |

## 排查

- **提示“未找到 DSH 桥接配置”**：确认 DSH 正在运行，并且 DSH 侧插件已安装；然后刷新 DSH 页面。
- **提示“令牌已失效”**：DSH 重启后会重新生成令牌；本扩展每次发送都会重新读取配置文件，通常只需重试。
- **提示“无法连接 DSH”**：确认 DSH 窗口开着，地址是 `http://127.0.0.1:52094` 这类本机地址。
- **DSH 输入框没有出现引用**：确认 DSH 页面已刷新；运行 **DSH: 显示 DSH 桥接状态** 查看是否有已连接的客户端。
- 日志：输出面板 → `DSH Bridge`。

## 开发

- 扩展是纯 JavaScript，无构建步骤。
- 修改 `extension.js` 后在 VS Code 中按 `F5` 启动 Extension Development Host 调试。
- 重新打包 VSIX：在仓库根目录运行 `scripts/build-vsix.ps1`。
