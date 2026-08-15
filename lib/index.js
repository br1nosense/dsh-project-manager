/**
 * @dsh-user/dsh-project-manager — DSH 项目管理插件（host 半边）
 *
 * 职责：
 *   1. 注册 `project-manager` 设置命名空间（installSettingsSection）→ 项目列表
 *      持久化在 `~/.dsh/settings.yaml` 的 `project-manager:` 段，热重载。
 *   2. 子进程管理：为每个项目 spawn 启动命令，支持 启动/停止/重启；
 *      Windows 下 taskkill /T 杀整棵进程树。
 *   3. 热重载：fs.watch 递归监听项目目录，文件变更（按后缀白名单过滤、
 *      忽略 node_modules/.git/dist 等）去抖后自动重启。
 *   4. 日志：stdout/stderr 按行写入环形缓冲（内存，上限可配）+ 持久化到
 *      logs/<id>.log；REST API 支持增量拉取（since 行号）与清空。
 *   5. webServer 前缀路由 `/project-manager/api/*` 提供 REST API，浏览器
 *      半边（./client）与 agent 都可调用。
 *   6. 提供 `ctx.projectManager` 服务（描述性接口 + 编程式启停）。
 */
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, watch, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import z from "@deepseek-ai/schemastery";
import { installSettingsSection, settingsNamespace } from "@deepseek-ai/dsh-settings";

const PKG_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const LOGS_DIR = join(PKG_ROOT, "logs");

/** 单个项目的 schema（settings 命名空间元素）。 */
const ProjectSchema = z.object({
  id: z.string(),
  name: z.string(),
  cwd: z.string(),
  command: z.string(),
  args: z.array(z.string()).default([]),
  autoStart: z.boolean().default(false),
  hotReload: z.boolean().default(true),
  /** 触发热重载的文件后缀白名单（不含点；空数组=全部文件都触发）。 */
  watchExts: z.array(z.string()).default([]),
  /** 附加环境变量（合并进 process.env）。 */
  env: z.dict(z.string()).default({}),
});

const PmSchema = z.object({
  projects: z.array(ProjectSchema).default([]),
  /** 每项目内存日志环形缓冲最大行数。 */
  logLimit: z.number().default(2000),
});

/** 热重载忽略的目录名（任何层级命中即跳过）。 */
const IGNORED_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", ".nuxt", ".cache", "logs", "coverage", ".venv", "venv", "__pycache__", ".idea", ".vscode"]);
/** 默认重启去抖窗口（毫秒）。 */
const RESTART_DEBOUNCE_MS = 500;

function slugify(text) {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || `p-${Date.now().toString(36)}`;
}

export default function dshProjectManager(ctx, entry = {}) {
  let resolved = null; // 解析后的配置 { projects, logLimit }
  let settingsService = null;
  const runtimes = new Map(); // id -> runtime（进程/日志/watcher）

  // ── 运行时记录：进程 + 日志环形缓冲 + 热重载 watcher ────────────────
  function createRuntime(project) {
    const buffered = []; // { t, stream, text }
    let seq = 0; // 日志总行数（增量拉取游标）
    let proj = project; // 可变项目引用（配置热更新时替换，进程/日志延续）
    let proc = null;
    let state = "stopped"; // stopped | starting | running | stopping | exited | failed
    let exitCode = null;
    let startedAt = 0;
    let watcher = null;
    let watcherError = null;
    let restartTimer = null;
    let pendingChanges = [];
    let logFd = "ignore";
    let generation = 0; // 进程代次：重启后旧进程的 exit 事件不再覆盖新进程状态

    const limit = () => resolved?.logLimit ?? 2000;

    function pushLine(stream, text) {
      const t = Date.now();
      buffered.push({ t, stream, text });
      seq += 1;
      if (buffered.length > limit()) buffered.shift();
      try {
        if (typeof logFd !== "number") {
          mkdirSync(LOGS_DIR, { recursive: true });
          logFd = openSync(join(LOGS_DIR, `${proj.id}.log`), "a");
        }
        appendFileSync(logFd, `[${new Date(t).toISOString()}] [${stream}] ${text}\n`);
      } catch { /* 日志文件写失败不影响运行 */ }
    }

    /** 按行切分子进程输出（处理跨 chunk 的半行）。 */
    function makeLineSplitter(stream) {
      let pending = "";
      return (chunk) => {
        pending += chunk.toString();
        let idx;
        while ((idx = pending.indexOf("\n")) !== -1) {
          const line = pending.slice(0, idx).replace(/\r$/, "");
          pending = pending.slice(idx + 1);
          if (line !== "") pushLine(stream, line);
        }
      };
    }

    function closeLogFd() {
      if (typeof logFd === "number") {
        try { closeSync(logFd); } catch {}
        logFd = "ignore";
      }
    }

    function killProc() {
      if (!proc) return;
      const pid = proc.pid;
      try {
        if (process.platform === "win32") {
          spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true });
        } else {
          proc.kill("SIGTERM");
        }
      } catch (error) {
        ctx.logger?.warn?.(`[dsh-project-manager] 停止进程树失败（pid=${pid}）：${error?.message ?? error}`);
      }
      proc = null;
    }

    function clearWatcher() {
      if (watcher) {
        try { watcher.close(); } catch {}
        watcher = null;
        watcherError = null;
      }
    }

    function startWatcher() {
      clearWatcher();
      if (!proj.hotReload) return;
      if (!existsSync(proj.cwd)) {
        watcherError = `工作目录不存在，无法监听：${proj.cwd}`;
        return;
      }
      try {
        watcher = watch(proj.cwd, { recursive: true }, (eventType, filename) => {
          if (!proj.hotReload) return;
          const rel = String(filename ?? "").replaceAll("\\", "/");
          const parts = rel.split("/");
          if (parts.some((p) => IGNORED_DIRS.has(p))) return;
          const ext = parts.at(-1)?.includes(".") ? parts.at(-1).split(".").pop() : "";
          const exts = proj.watchExts ?? [];
          if (exts.length > 0 && !exts.includes(ext)) return;
          pendingChanges.push(rel);
          if (restartTimer) clearTimeout(restartTimer);
          restartTimer = setTimeout(() => {
            restartTimer = null;
            const changes = pendingChanges;
            pendingChanges = [];
            if (state === "running" || state === "starting" || state === "exited") {
              pushLine("sys", `⚡ 检测到文件变更（${changes.length} 个），自动重启：${changes.slice(0, 5).join(", ")}${changes.length > 5 ? "…" : ""}`);
              ctx.logger?.info?.(`[dsh-project-manager] 热重载 ${proj.id}：${changes.length} 个文件变更`);
              restart("hot-reload");
            }
          }, RESTART_DEBOUNCE_MS);
        });
      } catch (error) {
        watcherError = error?.message ?? String(error);
        ctx.logger?.warn?.(`[dsh-project-manager] 启动文件监听失败（${proj.id}）：${watcherError}`);
      }
    }

    function start(reason) {
      if (proc || state === "starting") return { ok: false, error: "已在运行或正在启动" };
      if (!existsSync(proj.cwd)) {
        state = "failed";
        pushLine("sys", `❌ 启动失败：工作目录不存在 ${proj.cwd}`);
        return { ok: false, error: `工作目录不存在：${proj.cwd}` };
      }
      if (!proj.command.trim()) {
        state = "failed";
        pushLine("sys", "❌ 启动失败：未配置启动命令");
        return { ok: false, error: "未配置启动命令" };
      }
      if (typeof logFd !== "number") {
        try {
          mkdirSync(LOGS_DIR, { recursive: true });
          logFd = openSync(join(LOGS_DIR, `${proj.id}.log`), "a");
        } catch {}
      }
      const gen = ++generation;
      state = "starting";
      startedAt = Date.now();
      exitCode = null;
      pushLine("sys", reason === "hot-reload" ? "🔄 正在重启…" : `▶️ 正在启动：${proj.command} ${proj.args.join(" ")}`);
      const env = { ...process.env, ...(proj.env ?? {}) };
      const full = [proj.command, ...(proj.args ?? [])].join(" ");
      try {
        // Windows 下 shell:true 走 cmd.exe；非 Windows 走 /bin/sh，保证 npm/pnpm/python 等可执行
        proc = spawn(full, {
          cwd: proj.cwd,
          env,
          shell: true,
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
        });
        const myGen = gen;
        const onOut = makeLineSplitter("out");
        const onErr = makeLineSplitter("err");
        proc.stdout?.on("data", onOut);
        proc.stderr?.on("data", onErr);
        proc.on("error", (error) => {
          if (myGen !== generation) return; // 已被新代次取代
          pushLine("sys", `❌ 进程错误：${error?.message ?? error}`);
          state = "failed";
          exitCode = -1;
          proc = null;
          closeLogFd();
        });
        proc.on("exit", (code, signal) => {
          closeLogFd();
          if (myGen !== generation) return; // 重启后旧进程退出：不覆盖新进程状态
          proc = null;
          exitCode = code;
          if (state === "stopping") {
            state = "stopped";
            pushLine("sys", `⏹️ 已停止（exit ${code ?? signal ?? "?"}）`);
          } else {
            state = "exited";
            pushLine("sys", `⚠️ 进程退出（exit ${code ?? signal ?? "?"}）`);
          }
          ctx.logger?.info?.(`[dsh-project-manager] ${proj.id} 进程退出（code=${code}, signal=${signal}）`);
        });
        state = "running";
        pushLine("sys", `✅ 已启动（pid=${proc.pid}）`);
        startWatcher();
        ctx.logger?.info?.(`[dsh-project-manager] ${proj.id} 已启动（pid=${proc.pid}）`);
        return { ok: true, pid: proc.pid };
      } catch (error) {
        if (gen === generation) {
          proc = null;
          state = "failed";
          pushLine("sys", `❌ 启动异常：${error?.message ?? error}`);
          closeLogFd();
        }
        return { ok: false, error: error?.message ?? String(error) };
      }
    }

    function stop(reason) {
      if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
      pendingChanges = [];
      if (proc) {
        state = "stopping";
        pushLine("sys", reason ? `⏹️ 正在停止（${reason}）…` : "⏹️ 正在停止…");
        killProc();
        // taskkill 后进程 exit 事件会置 state=stopped（generation 未变）
        return { ok: true };
      }
      clearWatcher();
      generation += 1; // 使可能残留的旧进程事件失效
      state = "stopped";
      pushLine("sys", reason ? `⏹️ 已停止（${reason}）` : "⏹️ 已停止");
      return { ok: true };
    }

    function restart(reason) {
      if (proc) {
        state = "stopping";
        pushLine("sys", reason ? `🔄 正在重启（${reason}）…` : "🔄 正在重启…");
        killProc();
        // 旧进程退出事件因 generation 已递增而失效；立即拉起新代次
        generation += 1;
        start(reason === "hot-reload" ? "hot-reload" : "重启");
      } else {
        start(reason === "hot-reload" ? "hot-reload" : "启动");
      }
    }

    function setProject(next) {
      proj = next;
      // 目录或热重载开关变化时重建 watcher
      startWatcher();
    }

    return {
      get project() { return proj; },
      setProject,
      get state() { return state; },
      get pid() { return proc?.pid ?? null; },
      get exitCode() { return exitCode; },
      get startedAt() { return startedAt; },
      get seq() { return seq; },
      get watcherError() { return watcherError; },
      get logFile() { return typeof logFd === "number" ? join(LOGS_DIR, `${proj.id}.log`) : null; },
      linesFrom(since) {
        const start = Math.max(0, seq - buffered.length);
        const from = Math.max(since, start);
        const skip = from - start;
        return { from: Math.max(from, start), lines: buffered.slice(skip).map((l, i) => ({ ...l, n: start + skip + i })) };
      },
      clearLogs() {
        buffered.length = 0;
        try {
          if (typeof logFd === "number") { closeSync(logFd); logFd = "ignore"; }
          const p = join(LOGS_DIR, `${proj.id}.log`);
          if (existsSync(p)) writeFileSync(p, "", "utf8");
        } catch {}
        seq = 0;
        return { ok: true };
      },
      start,
      stop,
      restart,
      dispose() {
        generation += 1; // 使旧进程事件全部失效
        if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
        clearWatcher();
        if (proc) {
          try {
            if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(proc.pid), "/T", "/F"], { windowsHide: true });
            else proc.kill("SIGTERM");
          } catch {}
          proc = null;
        }
        closeLogFd();
      },
      snapshot() {
        return {
          id: proj.id,
          name: proj.name,
          cwd: proj.cwd,
          command: proj.command,
          args: proj.args ?? [],
          autoStart: proj.autoStart,
          hotReload: proj.hotReload,
          watchExts: proj.watchExts ?? [],
          env: proj.env ?? {},
          state,
          pid: proc?.pid ?? null,
          exitCode,
          startedAt,
          seq,
          watcherError,
        };
      },
    };
  }

  // ── 配置应用（settings onChange）─────────────────────────────────────
  function applySettings(cfg) {
    const prev = resolved;
    resolved = cfg;
    const projects = (cfg?.projects ?? []).map((p) => ({ ...p, args: p.args ?? [], watchExts: p.watchExts ?? [], env: p.env ?? {} }));

    // 新增项目 → 创建 runtime
    for (const p of projects) {
      if (!runtimes.has(p.id)) runtimes.set(p.id, createRuntime(p));
    }
    // 删除的项目 → 停止并清理
    const ids = new Set(projects.map((p) => p.id));
    for (const [id, rt] of [...runtimes]) {
      if (!ids.has(id)) {
        rt.dispose();
        runtimes.delete(id);
      }
    }
    // 更新项目配置（保持 runtime 不重建，热重载开关变化即时生效）
    for (const p of projects) {
      const rt = runtimes.get(p.id);
      if (rt) rt.setProject(p);
    }

    // autoStart：配置里标记的项目若未运行则拉起（首次加载或重载时）
    const firstLoad = prev === null;
    for (const p of projects) {
      const rt = runtimes.get(p.id);
      if (!rt) continue;
      if (p.autoStart && rt.state === "stopped") {
        rt.start(firstLoad ? "autoStart" : "配置重载(autoStart)");
      }
    }
    ctx.logger?.info?.(
      `[dsh-project-manager] 配置已应用：${projects.length} 个项目，运行中 ${[...runtimes].filter(([, r]) => r.state === "running").length} 个`
    );
  }

  let sourceThunk = () => resolved;
  installSettingsSection(ctx, "project-manager", PmSchema, entry, {
    setSource: (fn) => { sourceThunk = fn; },
    onChange: () => {
      try {
        const value = sourceThunk?.();
        if (value && typeof value === "object") applySettings(value);
      } catch (error) {
        ctx.logger?.warn?.(`[dsh-project-manager] 应用设置失败：${error?.message ?? error}`);
      }
    },
  });

  ctx.inject?.(["settings"], (sctx) => { settingsService = sctx.settings; });

  // ── 持久化项目列表到 settings（REST/服务调用入口）────────────────────
  async function persistProjects(projects) {
    if (!settingsService) throw new Error("settings 服务不可用");
    await settingsService.update(settingsNamespace("project-manager"), { projects });
  }

  function projectView(rt) {
    const snap = rt.snapshot();
    return {
      id: snap.id,
      name: snap.name,
      cwd: snap.cwd,
      command: snap.command,
      args: snap.args,
      autoStart: snap.autoStart,
      hotReload: snap.hotReload,
      watchExts: snap.watchExts,
      env: snap.env,
      state: snap.state,
      pid: snap.pid,
      exitCode: snap.exitCode,
      startedAt: snap.startedAt,
      watcherError: snap.watcherError,
    };
  }

  // ── webServer REST API ───────────────────────────────────────────────
  const json = (res, status, body) => {
    const text = JSON.stringify(body);
    res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(text);
  };
  const ok = (res, data) => json(res, 200, { ok: true, data });
  const fail = (res, status, error) => json(res, status, { ok: false, error });

  function readBody(req) {
    return new Promise((resolve, reject) => {
      let data = "";
      req.on("data", (chunk) => { data += chunk; if (data.length > 2 * 1024 * 1024) { reject(new Error("body too large")); req.destroy(); } });
      req.on("end", () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(new Error(`JSON 解析失败：${e.message}`)); } });
      req.on("error", reject);
    });
  }

  const handleApi = async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const path = decodeURIComponent(url.pathname);
    const base = "/project-manager/api";
    if (path !== base && !path.startsWith(base + "/")) return false;
    const rest = path.slice(base.length).replace(/^\/+/, "");
    const method = req.method ?? "GET";

    try {
      // GET /api/status
      if (rest === "status" && method === "GET") {
        return ok(res, {
          plugin: "@dsh-user/dsh-project-manager",
          ready: settingsService !== null,
          projectCount: runtimes.size,
          runningCount: [...runtimes].filter(([, r]) => r.state === "running").length,
          logsDir: LOGS_DIR,
          serverTime: Date.now(),
        });
      }

      // GET /api/projects
      if (rest === "projects" && method === "GET") {
        return ok(res, [...runtimes.values()].map(projectView));
      }

      // POST /api/projects — 添加项目
      if (rest === "projects" && method === "POST") {
        const body = await readBody(req);
        if (!body.name || !body.cwd || !body.command) return fail(res, 400, "name / cwd / command 为必填");
        const baseId = slugify(body.name);
        let id = baseId;
        let n = 2;
        while (runtimes.has(id)) id = `${baseId}-${n++}`;
        const project = {
          id,
          name: String(body.name),
          cwd: String(body.cwd),
          command: String(body.command),
          args: Array.isArray(body.args) ? body.args.map(String) : [],
          autoStart: Boolean(body.autoStart),
          hotReload: body.hotReload !== false,
          watchExts: Array.isArray(body.watchExts) ? body.watchExts.map(String) : [],
          env: body.env && typeof body.env === "object" ? Object.fromEntries(Object.entries(body.env).map(([k, v]) => [k, String(v)])) : {},
        };
        const projects = [...(resolved?.projects ?? []), project];
        await persistProjects(projects);
        return ok(res, { id });
      }

      // PUT /api/projects/:id — 更新项目
      const putMatch = /^projects\/([^/]+)$/.exec(rest);
      if (putMatch && method === "PUT") {
        const id = putMatch[1];
        const rt = runtimes.get(id);
        if (!rt) return fail(res, 404, `项目不存在：${id}`);
        const body = await readBody(req);
        const next = { ...rt.project };
        for (const key of ["name", "cwd", "command", "args", "autoStart", "hotReload", "watchExts", "env"]) {
          if (body[key] !== undefined) next[key] = body[key];
        }
        if (!next.name || !next.cwd || !next.command) return fail(res, 400, "name / cwd / command 不能为空");
        const projects = (resolved?.projects ?? []).map((p) => (p.id === id ? next : p));
        await persistProjects(projects);
        // 配置更新后 runtime 通过 settings onChange → applySettings → setProject 同步
        return ok(res, { id });
      }

      // DELETE /api/projects/:id
      const delMatch = /^projects\/([^/]+)$/.exec(rest);
      if (delMatch && method === "DELETE") {
        const id = delMatch[1];
        const rt = runtimes.get(id);
        if (rt) rt.dispose();
        runtimes.delete(id);
        const projects = (resolved?.projects ?? []).filter((p) => p.id !== id);
        await persistProjects(projects);
        return ok(res, { id });
      }

      // POST /api/projects/:id/start|stop|restart
      const actionMatch = /^projects\/([^/]+)\/(start|stop|restart)$/.exec(rest);
      if (actionMatch && method === "POST") {
        const [, id, action] = actionMatch;
        const rt = runtimes.get(id);
        if (!rt) return fail(res, 404, `项目不存在：${id}`);
        const result = action === "start" ? rt.start("手动") : action === "stop" ? rt.stop("手动") : rt.restart("手动");
        if (!result.ok) return fail(res, 409, result.error ?? "操作失败");
        return ok(res, { id, action, state: rt.state, pid: rt.pid });
      }

      // GET /api/projects/:id/logs?since=<seq>
      const logsMatch = /^projects\/([^/]+)\/logs$/.exec(rest);
      if (logsMatch && method === "GET") {
        const id = logsMatch[1];
        const rt = runtimes.get(id);
        if (!rt) return fail(res, 404, `项目不存在：${id}`);
        const since = Number(url.searchParams.get("since") ?? 0) || 0;
        const { from, lines } = rt.linesFrom(since);
        return ok(res, { id, since: from, lines, state: rt.state, pid: rt.pid, logFile: rt.logFile });
      }

      // POST /api/projects/:id/logs/clear
      const clearMatch = /^projects\/([^/]+)\/logs\/clear$/.exec(rest);
      if (clearMatch && method === "POST") {
        const id = clearMatch[1];
        const rt = runtimes.get(id);
        if (!rt) return fail(res, 404, `项目不存在：${id}`);
        rt.clearLogs();
        return ok(res, { id });
      }

      return fail(res, 404, `未知端点：${method} /project-manager/api/${rest}`);
    } catch (error) {
      ctx.logger?.warn?.(`[dsh-project-manager] API 错误：${error?.message ?? error}`);
      return fail(res, 500, error?.message ?? String(error));
    }
  };

  ctx.inject?.(["webServer"], (sctx) => {
    sctx.effect(() => sctx.webServer.register({
      kind: "prefix",
      path: "/project-manager",
      handler: async (req, res) => {
        const handled = await handleApi(req, res);
        if (!handled) {
          res.writeHead(404, { "content-type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ ok: false, error: "not found" }));
        }
      },
    }), "dsh-project-manager: api route");
  });

  // ── ctx.projectManager 服务 ──────────────────────────────────────────
  ctx.provide("projectManager", {
    name: "project-manager",
    describe() {
      return {
        projectCount: runtimes.size,
        runningCount: [...runtimes].filter(([, r]) => r.state === "running").length,
        projects: [...runtimes.values()].map(projectView),
      };
    },
    list() {
      return [...runtimes.values()].map(projectView);
    },
    get(id) {
      const rt = runtimes.get(id);
      return rt ? projectView(rt) : null;
    },
    async add(input) {
      const baseId = slugify(input.name ?? "project");
      let id = baseId;
      let n = 2;
      while (runtimes.has(id)) id = `${baseId}-${n++}`;
      const project = {
        id,
        name: String(input.name),
        cwd: String(input.cwd),
        command: String(input.command),
        args: input.args ?? [],
        autoStart: Boolean(input.autoStart),
        hotReload: input.hotReload !== false,
        watchExts: input.watchExts ?? [],
        env: input.env ?? {},
      };
      const projects = [...(resolved?.projects ?? []), project];
      await persistProjects(projects);
      return id;
    },
    async remove(id) {
      const rt = runtimes.get(id);
      if (rt) rt.dispose();
      runtimes.delete(id);
      const projects = (resolved?.projects ?? []).filter((p) => p.id !== id);
      await persistProjects(projects);
    },
    start(id) {
      const rt = runtimes.get(id);
      return rt ? rt.start("服务调用") : { ok: false, error: `项目不存在：${id}` };
    },
    stop(id) {
      const rt = runtimes.get(id);
      return rt ? rt.stop("服务调用") : { ok: false, error: `项目不存在：${id}` };
    },
    restart(id) {
      const rt = runtimes.get(id);
      return rt ? rt.restart("服务调用") : { ok: false, error: `项目不存在：${id}` };
    },
    logs(id, since = 0) {
      const rt = runtimes.get(id);
      if (!rt) return null;
      const { from, lines } = rt.linesFrom(since);
      return { id, since: from, lines, state: rt.state, pid: rt.pid };
    },
  });

  ctx.logger?.info?.(
    `[dsh-project-manager] 已注册：设置命名空间 project-manager + webServer 路由 /project-manager/api/* + ctx.projectManager 服务`
  );

  // 卸载时停止所有子进程
  return {
    dispose: () => {
      for (const rt of runtimes.values()) rt.dispose();
      runtimes.clear();
    },
  };
}
