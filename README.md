# DSH Launcher

一个把 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 Web GUI
装进原生窗口的桌面外壳：无需手动打开浏览器，双击即可在独立窗口中启动和使用完整 GUI。
支持 **Windows 与 macOS**（Linux 需自备 WebKitGTK 环境，Electron 同样可打包）。

> 同类参考：[anywhere-labs/deepseek-harness-desktop](https://github.com/anywhere-labs/deepseek-harness-desktop)
> 与 [ucas-liumk/deepseek-harness-desktop](https://github.com/ucas-liumk/deepseek-harness-desktop)
> （Tauri/WebView 方案）。本项目的取舍：**Electron 内置 Node 直接跑 dsh 后端**，
> 目标机器零运行时依赖、开发调试路径最短；Tauri 方案体积更小但需要目标系统 WebView
> 与额外 Node sidecar 打包。

> **隐私承诺**：本应用**不包含、也不打包任何用户的 API Key 或凭据**。
> dsh 的凭据（`~/.dsh/.credentials.yaml`、`settings.yaml` 等）始终只存在你自己的机器上。
> 应用自带的 `backend/` 树完全由公开 npm 包（`@deepseek-ai/dsh` 及其依赖）重新安装生成，
> 构建安装包时也不会把 `~/.dsh` 拷进去。可以放心开源、分发。

## 原理

```
┌───────────────────────────────┐
│  DSH Launcher (Electron 39)    │
│  ┌─────────────────────────┐  │
│  │  BrowserWindow          │  │  打开 http://127.0.0.1:<port>
│  │  (完整 Web GUI)          │  │
│  └─────────────────────────┘  │
│  │  spawn (ELECTRON_RUN_AS_NODE) │
│  └──────────┬──────────────┘  │
└─────────────┼─────────────────┘
              ▼
   dsh web 后端（npm 安装的 @deepseek-ai/dsh）
   绑定 127.0.0.1:3080，注入 window.__DSH_BOOT__
```

- 后端用 **Electron 自带的 Node**（`ELECTRON_RUN_AS_NODE=1`）运行，目标机器**不需要安装 Node.js**；
  启动参数带 `--expose-internals`，满足 dsh HMR 服务对 Node 内部模块的访问要求。
- 端口策略：3080 空闲 → 自己启动后端；3080 已被 dsh web 占用（如浏览器里已开着一个）→ 直接复用；
  3080 被其他程序占用 → 让操作系统分配空闲端口。
- 单实例：重复启动只会聚焦已有窗口，不会起第二个后端抢端口。

## 开发运行

前置：Node.js ≥ 22.19（或 ≥ 24）、npm。

```bash
cd dsh-desktop

# 1. 安装桌面外壳依赖（electron 等）
npm install

# 2. 准备后端：把公开的 @deepseek-ai/dsh 装进 backend/
npm run prepare:backend

# 3. 启动
npm start
```

## 打包安装包

```bash
npm run dist:win       # Windows：NSIS 安装包 + 便携版 exe（dist/ 目录）
npm run dist:mac       # macOS：dmg + zip（需在 macOS 上执行）
npm run dist:dir       # 仅生成未打包目录（调试用，较快）
```

> 跨平台说明：electron-builder 打包**当前平台**的产物。macOS 的 dmg/zip
> 需要在 macOS 上构建（Apple 要求）；Windows 的 NSIS/portable 需要在 Windows 上构建。
> 建议用 GitHub Actions 的 `macos-latest` / `windows-latest` 矩阵分别出包。

Windows 产物在 `dist/`：

- `DSH Launcher-Setup-0.1.0-x64.exe` — NSIS 安装包
- `DSH Launcher-Portable-0.1.0-x64.exe` — 便携版（免安装，双击即用）

macOS 产物在 `dist/`：

- `DSH Launcher-0.1.0-arm64.dmg` / `-x64.dmg` — 安装镜像（未签名/未公证，首次打开需右键→打开）
- `DSH Launcher-0.1.0-arm64.zip` / `-x64.zip` — 免安装 zip

> **注意**：NSIS 安装包内含后端依赖树（约 1.9 万个文件），静默安装（`/S`）首次
> 解压可能需要几分钟，属正常现象；安装完成后启动即秒开。
>
> 便携版（Portable）每次首次运行同样要自解压到临时目录，**首次启动约需 3~4 分钟**，
> 之后同一会话内再启动会快很多；介意的话建议直接用安装包。
>
> 构建前的 `npm run prepare:backend` 会重新从 npm 安装后端依赖树并清空旧 `backend/`，
> 确保发布物里永远只有公开包、绝无本机残留数据。

## GitHub Actions 自动出包

`.github/workflows/release.yml` 用 `windows-latest` / `macos-latest` 矩阵自动产出双平台安装包：

- **触发**：手动（Actions 页面 → Run workflow），或 push 带 `v*` 前缀的 tag（如 `v0.1.0`）。
- **流程**：每个 runner 独立执行 `npm ci` → `npm run prepare:backend`（按平台安装后端原生依赖）
  → 平台分支打包（Windows 走 `dist:win`，macOS 走 `dist:mac`）→ 上传 artifact。
- **产物**：Workflow 完成后在对应 run 的 Artifacts 里下载
  `DSH Launcher-Setup-*.exe` / `-Portable-*.exe` / `-*.dmg` / `-*.zip`。

> 为什么 `prepare:backend` 必须在每个平台各自跑：后端依赖里的原生包
> （如 `node-addon-require-builtin`）通过 npm 的 optionalDependencies 按平台选择，
> 跨平台复用同一份 `backend/` 会装错原生二进制。

> **macOS 签名/公证**：当前 CI 产出的是**未签名、未公证**的 dmg（仓库不配置
> Apple Developer ID 与 notarization 密钥）。首次打开需「右键 → 打开」绕过 Gatekeeper。
> 正式对外分发需另配 Apple 开发者证书与 notarization secrets——这是后续待办，不阻塞出包验证。

## 更换应用图标

`build/` 目录下的 `icon.ico`（Windows）、`icon.icns`（macOS）、`icon.png`（通用）
由源图生成。要换图标：

```bash
# Windows（PowerShell）
powershell -ExecutionPolicy Bypass -File scripts/make-icons.ps1 -SourceImage <你的图片路径>
```

脚本会把源图居中裁剪成方形，生成全部三种格式。之后重新 `npm run dist:win` / `dist:mac` 即可。

## 环境变量 / 参数

| 项 | 说明 |
|---|---|
| `DSH_DESKTOP_PORT` | 后端首选端口，默认 `3080` |
| `DSH_HOME` | dsh 数据目录（凭据/会话/设置），默认 `~/.dsh`，由 dsh 自身读取 |
| `DSH_DESKTOP_DEBUG` | 设为任意值后把启动日志写入用户数据目录 `startup.log`，便于排查 |

## 开源注意事项

- `backend/` 与 `node_modules/` 已在 `.gitignore` 中，由 `npm run prepare:backend` 重建，**不要提交**。
- **凭据自查（已执行）**：本项目源码（`main.js`、`preload.js`、`scripts/prepare-backend.mjs`、
  `package.json`、`package-lock.json`）不含任何真实 API key——已扫描 `sk-xxxx` 长 token 与
  `api_key`/`credential`/`secret`/`token` 敏感字段，仅命中注释里的隐私说明文字。
  真实凭据只在用户本机 `~/.dsh`（`~/.dsh/.credentials.yaml`、`settings.yaml` 等），与本仓库无关。
- 提交前可用这条命令复核（在仓库根目录执行）：

  ```powershell
  # Windows PowerShell：扫描源码中的真实 key 痕迹（排除 node_modules/backend/dist）
  Get-ChildItem . -Recurse -File -Include *.yaml,*.yml,*.json,*.js,*.mjs |
    Where-Object { $_.FullName -notmatch '\\node_modules\\|\\backend\\|\\dist\\' } |
    Select-String -Pattern 'sk-[A-Za-z0-9]{20,}'
  ```

- 本应用只做外壳，不修改 dsh 本体；dsh 及其依赖各自的许可证见各 npm 包。
