# DSH ↔ VSCode 上下文桥接

把 VS Code 里选中的代码范围，或文件的绝对路径，直接添加到**当前 DSH 对话的输入框**。它不会自动发送消息，你可以继续在 DSH 里补充问题，类似 Cursor 的“Add to Chat”。

## 交付物

| 路径 | 内容 |
| --- | --- |
| [`dsh-vscode-bridge/`](dsh-vscode-bridge/) | DSH bundle：Host HTTP/SSE 服务 + 浏览器端输入框注入 |
| [`vscode-dsh-bridge/`](vscode-dsh-bridge/) | VS Code 扩展源码 |
| [`dist/dsh-vscode-bridge-1.0.0.vsix`](dist/dsh-vscode-bridge-1.0.0.vsix) | 可直接安装的 VS Code 扩展包 |
| [`dist/dsh-vscode-bridge-1.0.4.zip`](dist/dsh-vscode-bridge-1.0.4.zip) | DSH bundle 的单文件分发包（Windows 解压后安装） |
| [`dist/dsh-vscode-bridge-1.0.4.tgz`](dist/dsh-vscode-bridge-1.0.4.tgz) | 同一 bundle 的 tar.gz 分发包（带正斜杠路径，跨平台） |
| [`dist/local-dsh-vscode-bridge-1.0.4.tgz`](dist/local-dsh-vscode-bridge-1.0.4.tgz) | **npm 格式 tarball**，可托管到 Gitee 后用 URL 直接安装 |
| [`scripts/build-vsix.ps1`](scripts/build-vsix.ps1) | 重新构建 VSIX |
| [`tests/bridge-e2e.mjs`](tests/bridge-e2e.mjs) | Host 路由 / 队列 / SSE 回归测试 |
| [`tests/test-extension.cjs`](tests/test-extension.cjs) | 用 mock `vscode` 走通扩展命令的集成测试 |

## 当前状态

- DSH bundle `@local/dsh-vscode-bridge@1.0.4` 已安装到 `desktop` profile，状态为 `active`。
- 1.0.4 修复：客户端订阅从 `conversation.composer.dock` 移到 `conversation.input.left`，新会话 hero 区在发送第一条消息前也能收到 VSCode 路径。
- VS Code 扩展 `local.dsh-vscode-bridge@1.0.0` 已通过 VSIX 安装。
- DSH 页面已重载，浏览器端客户端已连接（`clients: 1`）。
- 已在真实 DSH 页面中验证：新会话未发送消息时，Host 收到附件后输入框直接出现
  `@C:\...\package.json (lines 1-5)`，且没有自动发送。
- VS Code 当时没有运行，因此**右键菜单的实际渲染没有截图验证**；但扩展的 `package.json` 菜单贡献、命令注册、选区/文件参数计算和真实 HTTP 发送都已验证。

测试过程中写入输入框的示例引用已经清空。

## 使用

1. 启动 DSH 桌面端，打开一个对话。
2. 在 VS Code 中打开文件：
   - 选中若干行 → 编辑器右键 → **DSH: 发送选中代码到 DSH 对话**
   - 不选中内容 → 编辑器右键 → **DSH: 发送文件路径到 DSH 对话**
   - 资源管理器中右键文件/文件夹 → **DSH: 发送文件路径到 DSH 对话**
3. 切回 DSH。引用已经出现在当前对话的输入框，光标位置保持不变。
4. 输入你的问题，正常发送。

发送示例：

```text
@C:\project\src\main.ts (lines 12-28)
@C:\project\src\main.ts
@"C:\project\my folder\main.ts" (line 7)
```

- 代码段会以**绝对路径 + 1-based 闭区间行号**表示。
- 文件会以**绝对路径**表示；目录会带尾部 `/`。
- 路径包含空格时使用 `@"..."` 形式。
- DSH Host 插件还注册了 `vscode-references` 提示段，告诉模型 `(lines A-B)` 应该按范围读取，而不是只凭路径猜测。

### 如果 VS Code 已经在运行

安装 VSIX 后，VS Code 通常需要重载窗口才能出现新命令：

`Ctrl+Shift+P` → **Developer: Reload Window**

### 如果 DSH 页面是旧的

安装/重载 DSH bundle 后，刷新 DSH 页面即可。当前页面已由我们重载并连接成功；以后重启 DSH 会重新写入 token，扩展每次发送都会重新读取，不需要手动改配置。

## 上传到 Gitee 后如何安装 DSH 端

仓库地址：<https://gitee.com/HYTWML/dsh-vscode-bridge>

### 方式 A：用 npm tarball URL 直接安装（推荐）

把 [`dist/local-dsh-vscode-bridge-1.0.4.tgz`](dist/local-dsh-vscode-bridge-1.0.4.tgz) 上传到 Gitee 仓库或 Release，取得可直接下载的 URL，然后让 DSH 执行：

```text
plugin_manager install_bundle target="https://gitee.com/HYTWML/dsh-vscode-bridge/raw/master/dist/local-dsh-vscode-bridge-1.0.4.tgz"
```

也可以用 Gitee Release 附件的下载链接替换上面的 URL。这个文件是标准 npm tarball（根目录为 `package/`，内含 `package.json`、`cordis.patch.yml`、`index.js`、`client.js` 等），适合 DSH 的 tarball 安装。

- 仓库需要是公开可读的；私有仓库需要本机 Git/pnpm 已配置 Gitee 凭据。
- Gitee 的 `raw` 链接如果返回 HTML 而不是文件，请改用 Release 附件链接。

### 方式 B：Git URL 安装

仅当**仓库根目录就是 DSH bundle**（根目录有带 `dsh.bundle.patch` 的 `package.json`）时：

```text
plugin_manager install_bundle target="git+https://gitee.com/HYTWML/dsh-vscode-bridge.git"
```

当前工作区的 bundle 位于 `dsh-vscode-bridge/` 子目录，因此直接对当前仓库根使用 Git URL 不会把子目录当成包；这种情况请使用方式 A，或单独建一个 bundle 根仓库。

### 方式 C：下载 zip/tgz 后本地安装

把 [`dist/dsh-vscode-bridge-1.0.4.zip`](dist/dsh-vscode-bridge-1.0.4.zip) 或 [`dist/dsh-vscode-bridge-1.0.4.tgz`](dist/dsh-vscode-bridge-1.0.4.tgz) 下载并解压，然后把解压出来的 `dsh-vscode-bridge` 目录作为 target：

```text
plugin_manager install_bundle target="C:\path\to\dsh-vscode-bridge"
```

### VS Code 端

从 Gitee 下载：

```text
https://gitee.com/HYTWML/dsh-vscode-bridge/raw/master/dist/dsh-vscode-bridge-1.0.0.vsix
```

然后安装：

```powershell
Invoke-WebRequest -UseBasicParsing `
  -Uri 'https://gitee.com/HYTWML/dsh-vscode-bridge/raw/master/dist/dsh-vscode-bridge-1.0.0.vsix' `
  -OutFile "$env:TEMP\dsh-vscode-bridge-1.0.0.vsix"
code --install-extension "$env:TEMP\dsh-vscode-bridge-1.0.0.vsix" --force
```

> 本机当前安装的是 `~/.dsh/bundles/local-dsh-vscode-bridge-1.0.4.tgz`。如果改成从 Gitee 安装同一个包，需要先 `remove_bundle` 当前的 `@local/dsh-vscode-bridge`，否则会报 `already-installed`。

## 工作原理

```text
VS Code 扩展
  │  POST /dsh-vscode/attach（Bearer token）
  ▼
DSH Host 插件（本仓库 dsh-vscode-bridge）
  │  内存队列 + SSE /dsh-vscode/events
  ▼
DSH 浏览器插件（conversation.composer.dock 的隐藏组件）
  │  InputActions.captureInsertion() + insertText()
  ▼
当前对话的输入框
```

- Host 插件在 `~/.dsh/vscode-bridge.json` 写入 `{ url, token, channel }`（可用 `DSH_VSCODE_BRIDGE_FILE` 覆盖）。文件以 `0o600` 模式写入；Windows 上的最终权限由用户目录 ACL 决定。
- VS Code 扩展每次发送前重新读取该文件，因此 DSH 重启/换端口后无需手动同步 token。
- 没有打开的 DSH 对话时，Host 会把引用放入内存队列（最多 100 条），下一个浏览器会话连接时按顺序补发。
- DSH Desktop 的页面运行在 `dsh-app://app/`。桌面壳会把非静态资源请求连同认证 Cookie 转发给 Host，因此浏览器端使用相对路径 `/dsh-vscode/*` 即可，普通浏览器标签页也兼容。
- 只接受回环地址（`localhost` / `127.0.0.1` / `::1`），避免把 token 发到远端。

## 端点

| 方法 | 路径 | 鉴权 | 用途 |
| --- | --- | --- | --- |
| POST | `/dsh-vscode/attach` | Bearer token | 接收一条选区/文件引用 |
| GET | `/dsh-vscode/events` | `token` + `channel` query | 浏览器端 SSE 长连接 |
| GET | `/dsh-vscode/config` | 同源页面 / Desktop 转发的认证请求 | 给浏览器端下发 token/channel |
| GET | `/dsh-vscode/health` | 无 | VS Code “显示桥接状态”命令使用 |

## 排查

- **VS Code 提示找不到配置**：确认 DSH 正在运行，且 DSH 侧 bundle 已启用；然后运行 **DSH: 显示 DSH 桥接状态**，或在 DSH 页面刷新一次。
- **VS Code 提示 401**：DSH 重启后 token 会变化；扩展会自动重新读取。若仍失败，刷新 DSH 页面再试。
- **DSH 输入框没出现引用**：运行 **DSH: 显示 DSH 桥接状态**；若显示 `clients: 0`，说明没有已打开的 DSH 对话，引用会排队，打开对话后自动补发。
- **查看 DSH 侧健康状态**：

  ```powershell
  Invoke-RestMethod http://127.0.0.1:52094/dsh-vscode/health
  ```

- VS Code 日志：输出面板 → `DSH Bridge`。

## 开发 / 重新构建

```powershell
# 重新打 VSIX
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\build-vsix.ps1

# 同时安装到本机 VS Code
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\build-vsix.ps1 -Install
```

DSH bundle 是本地链接安装。修改 `dsh-vscode-bridge/` 后，需要重新加载该 bundle 或重启 DSH；本地链接意味着这个工作区目录不能删除/移动。

## 卸载

- DSH：`plugin_manager` → `remove_bundle`，目标 `@local/dsh-vscode-bridge`。
- VS Code：`code --uninstall-extension local.dsh-vscode-bridge`。
- 可选：删除 `~/.dsh/vscode-bridge.json`。
