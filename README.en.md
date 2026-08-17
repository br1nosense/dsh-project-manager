# dsh-project-manager

A DSH plugin that manages development projects from the DSH web UI in a
**draggable floating window** — add/remove projects, one-click
start/stop/restart, hot-reload auto-restart on file changes, and real-time
persistent logs.

## Features

- **Floating window**: shown at the bottom-right of the DSH web UI
  (`shell.overlay`), draggable by its title bar, collapsible via its top-right
  button; position and collapse state are remembered in `localStorage` and
  clamped back into the viewport on resize.
- **Project list**: each project card shows a status badge
  (running / starting / stopping / exited / failed / stopped), PID, working
  directory and start command.
- **Start / Stop / Restart**: one button row per project. On Windows, stop
  uses `taskkill /T` to kill the whole process tree so no child processes are
  left behind.
- **Add project**: name, working directory, start command (e.g. `npm run dev`
  or `python app.py`), extra args, auto-start, hot-reload toggle, watch
  extension whitelist, and extra environment variables.
- **Hot reload**: `fs.watch` watches the project directory recursively; file
  changes (filtered by the extension whitelist, ignoring
  `node_modules` / `.git` / `dist`) trigger a debounced (500 ms) auto-restart.
- **Logs**: each project's stdout/stderr is written line-by-line to an
  in-memory ring buffer (configurable cap, default 2000 lines) and persisted
  to `logs/<id>.log`; the floating window has an expandable log viewer with
  incremental polling, auto-scroll and clear.

## Install

### Option A: clone from GitHub (recommended)

```powershell
git clone https://github.com/br1nosense/dsh-project-manager.git
cd dsh-project-manager
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

### Option B: via `dsh plugin add`

```bash
dsh plugin add https://github.com/br1nosense/dsh-project-manager
```

Restart `dsh web` after installing (the client bundle can also be hot-updated
by HMR). Verify:

```powershell
dsh --profile web --dump-config   # should show an `id: project-manager` line
```

## REST API (same-origin; callable by the browser half and the agent)

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/project-manager/api/status` | plugin status |
| GET | `/project-manager/api/projects` | project list (with live status) |
| POST | `/project-manager/api/projects` | add a project |
| PUT | `/project-manager/api/projects/:id` | update a project |
| DELETE | `/project-manager/api/projects/:id` | delete a project (stops the process first) |
| POST | `/project-manager/api/projects/:id/start` | start |
| POST | `/project-manager/api/projects/:id/stop` | stop |
| POST | `/project-manager/api/projects/:id/restart` | restart |
| GET | `/project-manager/api/projects/:id/logs?since=<seq>` | incremental logs |
| POST | `/project-manager/api/projects/:id/logs/clear` | clear logs |

## Configuration

The project list is persisted under the `project-manager:` section of
`~/.dsh/settings.yaml` and hot-reloaded. Field schema is documented in the
comments of `cordis.patch.yml`.

## Development

- `lib/index.js` — host half: process management, hot reload, logs, webServer
  REST API, `ctx.projectManager` service.
- `lib/client.js` — browser half: the `shell.overlay` floating window
  (draggable, collapsible).
- Client-side changes are hot-updated by `dsh-client-hmr` (poll bundle file →
  SSE push) without restarting `dsh web`; only a brand-new bundle entering
  `__DSH_BOOT__` needs a restart.

## License

MIT — see [LICENSE](./LICENSE).
