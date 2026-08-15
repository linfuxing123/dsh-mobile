# DSH Mobile

<p align="center">
  <b>📱 手机远程控制电脑 Agent</b> · <i>Phone-first remote control for your desktop AI agent</i>
  <br><br>
  <img alt="license" src="https://img.shields.io/badge/license-MIT-blue.svg">
  <img alt="node" src="https://img.shields.io/badge/node-%E2%89%A520-green.svg">
  <img alt="pwa" src="https://img.shields.io/badge/PWA-ready-3b82f6.svg">
  <img alt="platform" src="https://img.shields.io/badge/platform-Windows-lightgrey.svg">
</p>

手机端远程控制电脑 **DSH Agent** 的工具。出门在外用手机给电脑里的 agent 发指令，agent 在电脑上自主干活，完成后把结果回传、并推送通知到手机。

> 解决的是「屏幕镜像远程桌面（ToDesk/向日葵/RDP）在手机上不好用」的问题：
> 不把小屏幕拿来拖鼠标，而是把 agent 的**对话接口**做成手机优先的聊天 App —— 文字 / 语音 / 拍照 / 一键快捷指令，结果异步回传 + 完成通知。

## 功能特性 Features

- 💬 聊天式指令：文字 / 🎤 语音转文字 / 📷 拍照识图 / ⚡ 快捷指令一键发送
- ⚡ 结果实时流式显示，Markdown 渲染
- 🔔 任务完成：应用内提示音 + 震动；后台经 Bark / ntfy / Server酱 推原生通知
- 🔐 密码 + 签名 Cookie 鉴权，回环反代穿透 DSH 的浏览器信任边界
- 🌐 Tailscale 加密远程访问（免费、免公网 IP、免端口转发），可安装为 PWA

## 它是什么

```
手机浏览器(PWA) ──Tailscale 加密──▶ dsh-mobile 网关 ──回环──▶ DSH web (127.0.0.1:3080)
      ▲                                 │
      └──── 任务完成通知 (Bark / ntfy / 微信Server酱) ◀──┘
```

- **`server.js`**：网关。做四件事——① 托管手机端 PWA；② 把 DSH 的 `/api/*`（HTTP + 两个 WebSocket 下行流）反向代理到本机回环的 DSH web，并改写 `Host`/`Origin`/fetch 元数据以通过 DSH 的浏览器信任边界；③ 加了一层**密码 + 签名 Cookie** 鉴权（DSH 的 web 层本来没有鉴权，远程暴露必须有）；④ 监听 mux 流，在「被手机 watch 的会话」完成时触发通知。
- **`public/`**：手机优先的 PWA（聊天式界面，语音输入、快捷指令、拍照/相册、Markdown 结果、完成提示音/震动）。
- **`scripts/`**：`make-icons.js`（生成图标）、`smoke.js`（冒烟测试）、`e2e.js`（端到端测试）。

## 前提

1. 电脑上 **DSH web 已在运行**：`dsh --profile web`（默认 `127.0.0.1:3080`）。建议在你想让 agent 干活的目录里启动它。
2. **Node.js ≥ 20**（用到了全局 `fetch` / `crypto`）。

## 安装与启动

```powershell
cd dsh-mobile
npm install
npm start          # 或双击 start.cmd
```

首次启动会自动生成 `config.json`（含随机访问密码 + 会话密钥），并在控制台打印登录密码。也可以改 `config.json`：

```jsonc
{
  "host": "0.0.0.0",            // 监听地址，0.0.0.0 = 局域网/Tailscale 都能访问
  "port": 3090,                 // 网关端口
  "dshTarget": "http://127.0.0.1:3080",  // DSH web 地址（一般不用改）
  "password": "改成你的密码",     // 手机登录密码（或用环境变量 DSH_MOBILE_PASSWORD 覆盖）
  "notify": { "bark": "", "ntfy": "", "serverchan": "" }   // 完成通知，见下
}
```

改密码：编辑 `config.json` 的 `password`，或启动前设环境变量 `DSH_MOBILE_PASSWORD`。重启生效。

## 访问方式

### 方式一：同一 WiFi（局域网，最快验证）

手机浏览器打开 `http://<电脑局域网IP>:3090`。查 IP：`ipconfig`。注意：普通 HTTP 下浏览器会**禁用语音输入**（Web Speech 需要安全上下文），其余功能正常。

### 方式二：出门在外（Tailscale + HTTPS，推荐）

Tailscale 给手机和电脑建一个加密的虚拟内网，同时提供 `*.ts.net` 的 HTTPS 证书，这样语音输入和「添加到主屏幕」都可用。

1. **电脑**：装 Tailscale（<https://tailscale.com/download>），登录。装完 `tailscale` 命令可用。
2. **手机**：应用商店装 Tailscale 客户端，登录**同一个账号**。两台设备都会得到一个 `100.x.x.x` 内网 IP。
3. **电脑开 HTTPS 反代**（二选一）：

   - **推荐用 `tailscale serve`**：
     ```powershell
     tailscale serve --bg 3090
     ```
     之后用 `https://<电脑的机器名>.<你的tailnet>.ts.net` 访问（机器名在 Tailscale 控制台可查，例如 `https://my-pc.tailxxxx.ts.net`）。
   - 或 **HTTPS 证书 + 自反代**：`tailscale cert <机器名>.<tailnet>.ts.net` 拿证书，再交给任意反代（Caddy/Nginx）套到 `127.0.0.1:3090`。网关本身也支持 `wss`（HTTPS 下自动切 `wss://`）。

4. 手机 Tailscale 开着的情况下，浏览器访问上面的 HTTPS 地址 → 输入密码 → 就能用了；点浏览器菜单「添加到主屏幕」可安装成 App。

## 手机端怎么用

- **发指令**：底部输入框打字回车发送；或点 🎤 **语音**说（说完自动填入）；或点 ⚡ **快捷指令**一键发送；或点 📷 **拍照/选图**发给 agent 识别（依赖 agent 所用模型是否支持图像）。
- **快捷指令**：点 ⚡ → 「管理」→ 每行一条，保存后点一下即发送。
- **看结果**：agent 干活时文字实时流式显示，工具调用折叠成「🛠」小标签；完成后弹提示 + 震动 + 提示音。
- **会话**：左上 ☰ 看历史会话、开新任务。每个会话有独立上下文（可续聊）。
- **等待授权/提问**：agent 请求批准或问问题时，会弹出选项卡片，点选后继续。

## 完成通知（后台也能收到）

出门玩时手机浏览器多半在后台，靠网页本身收不到通知，所以由**网关**在任务完成时推送原生通知。三选一，把对应配置填进 `config.json` 的 `notify`：

| 服务 | 适用 | 配置 |
|---|---|---|
| **Bark**（iOS 首选） | iPhone | App Store 装 Bark，复制推送地址 `https://api.day.app/你的KEY`，填到 `notify.bark` |
| **ntfy**（安卓/iOS，免账号） | 通用 | 装 ntfy App，订阅一个随机主题名，`https://ntfy.sh/你的主题` 填到 `notify.ntfy` |
| **Server酱**（微信） | 微信用户 | <https://sct.ftqq.com> 用微信登录拿 SendKey，填到 `notify.serverchan` |

填好后重启网关。手机 App 里订阅同一主题/保持 Bark/Server酱 登录即可收到「✅ 任务完成」。

## 验证

```powershell
node scripts/smoke.js     # 鉴权 + RPC 代理 + mux WebSocket 冒烟
node scripts/e2e.js       # 端到端：建会话 → 发指令 → 收 agent 回复
```

## 安全说明

- DSH web 本身**只能监听 127.0.0.1**（其 CLI 故意禁用 `0.0.0.0` 直到有鉴权层），本工具通过「回环反代 + 密码鉴权」补齐了远程访问缺口。**务必设置一个强密码**。
- 网关默认 `0.0.0.0` 暴露；若只在局域网用，可把 `host` 改成局域网网卡 IP 或 `127.0.0.1` 再由反代转发。
- 生产/公网务必走 **Tailscale**（点对点加密 + 设备级鉴权），不要直接做端口转发到公网。

## 已知简化（v1）

- 新会话默认在 DSH web 进程的启动目录（cwd）下工作；如需指定工作目录，在启动 `dsh --profile web` 前 `cd` 到目标目录，或后续版本加 workspace 选择。
- 图片发给 agent 后能否「看懂」取决于 agent 所用模型是否支持视觉输入。
