# @dsh-user/dsh-project-manager

DSH 项目管理插件：在 DSH Web 界面以**悬浮窗口**形式管理开发项目——添加/删除项目、
一键启动/停止/重启、文件变更热重载自动重启、实时日志查看与持久化。

## 功能

- **悬浮窗口**：显示在 DSH Web 界面右下角（`shell.overlay`），可**拖拽移动**
  （标题栏拖动）、**折叠/展开**（右上角按钮）；位置与折叠状态记忆在
  localStorage，窗口尺寸变化时自动钳回可视区域。
- **项目列表**：每个项目卡片显示状态徽标（运行中/启动中/停止中/已退出/失败/已停止）、
  PID、工作目录、启动命令。
- **启动 / 停止 / 重启**：每个项目一行操作按钮。Windows 下停止使用
  `taskkill /T` 杀整棵进程树，不会残留子进程。
- **添加项目**：名称、工作目录、启动命令（如 `npm run dev` / `python app.py`）、
  附加参数、自动启动、热重载开关、热重载文件后缀白名单、附加环境变量。
- **热重载**：`fs.watch` 递归监听项目目录，文件变更（按后缀白名单过滤、忽略
  `node_modules/.git/dist` 等）去抖 500ms 后自动重启进程。
- **日志**：每个项目的 stdout/stderr 按行写入内存环形缓冲（上限可配，默认 2000 行）
  并持久化到 `logs/<id>.log`；悬浮窗内可展开日志查看器，增量轮询、自动滚动、清空。

## 预置项目

本机已通过插件 REST API 注册两个项目（持久化在 `settings.yaml` 的 `project-manager:` 段）：

| 项目 | 目录 | 启动命令 | WebUI |
| --- | --- | --- | --- |
| RVC 翻唱系统 | `C:\code\dsh\rvc` | `venv-rvc\Scripts\python.exe webui.py --port 7865 --noautoopen` | http://127.0.0.1:7865 |
| CosyVoice | `C:\code\dsh\cosyvoice` | `venv-cosyvoice\Scripts\python.exe start_webui.py --model_dir pretrained_models/Fun-CosyVoice3-0.5B --port 8000` | http://127.0.0.1:8000 |

> CosyVoice 使用 `start_webui.py` 包装脚本：先在 `import gradio` 之前预加载 torch，
> 规避 Windows 上「gradio 先于 torch import → c10.dll 加载失败（WinError 1114）」的
> DLL 冲突。模型使用本地 `pretrained_models/Fun-CosyVoice3-0.5B`。

## 安装

### 方式一：GitHub 克隆（推荐）

```powershell
git clone https://github.com/br1nosense/dsh-project-manager.git
cd dsh-project-manager
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

### 方式二：本地目录

```powershell
cd C:\code\dsh\release\dsh-project-manager
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

安装后重启 dsh web（或由 HMR 自动热更新 client bundle）。验证：

```powershell
dsh --profile web --dump-config   # 应出现 id: project-manager 的行
```

## REST API（同源，浏览器半边与 agent 均可调用）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/project-manager/api/status` | 插件状态 |
| GET | `/project-manager/api/projects` | 项目列表（含实时状态） |
| POST | `/project-manager/api/projects` | 添加项目 |
| PUT | `/project-manager/api/projects/:id` | 更新项目 |
| DELETE | `/project-manager/api/projects/:id` | 删除项目（先停进程） |
| POST | `/project-manager/api/projects/:id/start` | 启动 |
| POST | `/project-manager/api/projects/:id/stop` | 停止 |
| POST | `/project-manager/api/projects/:id/restart` | 重启 |
| GET | `/project-manager/api/projects/:id/logs?since=<seq>` | 增量日志 |
| POST | `/project-manager/api/projects/:id/logs/clear` | 清空日志 |

## 配置

项目列表持久化在 `~/.dsh/settings.yaml` 的 `project-manager:` 段，热重载。
schema 字段见 `cordis.patch.yml` 注释。

## 开发

- `lib/index.js` — host 半边：进程管理、热重载、日志、webServer REST API、`ctx.projectManager` 服务。
- `lib/client.js` — 浏览器半边：`shell.overlay` 悬浮窗口（可拖拽、可折叠）。
- client 端改动由 `dsh-client-hmr` 自动热更新（轮询 bundle 文件 → SSE 推送），
  无需重启 dsh web；首次安装（新 bundle 入 `__DSH_BOOT__`）才需重启。
