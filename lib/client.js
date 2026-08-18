/**
 * @dsh-user/dsh-project-manager — 浏览器半边（client bundle）v2 悬浮窗口
 *
 * 在 DSH Web 界面以「悬浮窗口」形式提供项目管理（shell.overlay）：
 *   - 可拖拽移动（标题栏 pointer 拖拽 + pointer capture）、位置记忆
 *   - 可折叠为标题栏细条 / 展开为完整面板
 *   - 项目列表：状态徽标（运行中/已停止/已退出/失败）、PID、启停/重启按钮
 *   - 添加项目表单：名称 / 工作目录 / 启动命令 / 附加参数 / 自动启动 / 热重载
 *     / 热重载文件后缀白名单 / 附加环境变量（KEY=VALUE 每行一个）
 *   - 每个项目可展开日志查看器：轮询增量日志（since 游标）、自动滚动、
 *     清空日志、失败/错误行高亮
 *
 * 与 host 通信：全部走同源 REST API（/project-manager/api/*），由 host 半边
 * 的 webServer 前缀路由提供；无需 apiproxy 暴露设置命名空间。
 *
 * 手写 __ModuleLoader__ 包格式：只 require 平台 seed 词 react，其余能力
 * （slots）经 ctx.get() 运行时读取；任何失败只降级为不显示悬浮窗，不拖垮启动。
 */
window.__ModuleLoader__.load({
  id: "@dsh-user/dsh-project-manager",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    const React = require("react");
    const { useState, useEffect, useRef, useCallback } = React;

    const API = "/project-manager/api";
    const CSS_ID = "@dsh-user/dsh-project-manager/styles";
    const LS_POS = "dsh.pm.pos";
    const LS_COLLAPSED = "dsh.pm.collapsed";
    const WIN_W = 440;   // 悬浮窗默认宽
    const WIN_H = 520;   // 悬浮窗默认高

    // ── 样式 ────────────────────────────────────────────────────────────
    const css = `
/* ── 悬浮窗外壳：高度自适应内容，最多占视口 70%（超出时 body 内部滚动）── */
.dsh-pm-win {
  position: absolute; z-index: 60; width: ${WIN_W}px;
  max-height: min(600px, calc(100vh - 60px));
  display: flex; flex-direction: column;
  background: var(--dsw-alias-bg-layer-1, #ffffff);
  border: 1px solid var(--dsw-alias-border-l2, #d0d5dd);
  border-radius: 14px;
  box-shadow: 0 18px 48px rgba(0,0,0,.28), 0 2px 8px rgba(0,0,0,.10);
  overflow: hidden;
  font-size: 13px;
  color: var(--dsw-alias-label-primary, #222);
}
.dsh-pm-win[data-collapsed] { max-height: none; height: auto; }
.dsh-pm-win * { box-sizing: border-box; }
.dsh-pm-win ::-webkit-scrollbar { width: 8px; height: 8px; }
.dsh-pm-win ::-webkit-scrollbar-thumb { border-radius: 8px; background: var(--dsw-alias-scrollbar-bg-l2, #c6ccd6); }
.dsh-pm-win ::-webkit-scrollbar-thumb:hover { background: var(--dsw-alias-scrollbar-hover-l2, #aab2c0); }
.dsh-pm-win ::-webkit-scrollbar-track { background: transparent; }

/* 标题栏（拖拽把手） */
.dsh-pm-titlebar {
  display: flex; align-items: center; gap: 8px;
  padding: 8px 12px; cursor: grab; user-select: none;
  background: var(--dsw-alias-bg-layer-2, #f4f5f7);
  border-bottom: 1px solid var(--dsw-alias-border-l2, #e2e5ea);
  flex: none;
}
.dsh-pm-titlebar:active { cursor: grabbing; }
.dsh-pm-titlebar[data-dragging] { opacity: .85; }
.dsh-pm-title { font-size: 13px; font-weight: 600; color: var(--dsw-alias-label-primary, #222); display: flex; align-items: center; gap: 6px; }
.dsh-pm-title .glyph { font-size: 15px; }
.dsh-pm-summary { font-size: 11px; color: var(--dsw-alias-label-tertiary, #999); margin-left: 2px; }
.dsh-pm-titlebar-actions { margin-left: auto; display: flex; gap: 4px; align-items: center; }
.dsh-pm-icon-btn {
  width: 24px; height: 24px; display: inline-flex; align-items: center; justify-content: center;
  border: 1px solid transparent; border-radius: 6px; cursor: pointer;
  background: transparent; font: inherit; font-size: 13px; line-height: 1;
  color: var(--dsw-alias-label-secondary, #667); padding: 0;
}
.dsh-pm-icon-btn:hover { background: var(--dsw-alias-interactive-bg-hover, #eceef1); color: var(--dsw-alias-label-primary, #222); }

/* 主体：项目多时在 max-height 内滚动，卡片不被压缩 */
.dsh-pm-body { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 10px 12px 12px; display: flex; flex-direction: column; gap: 10px; }
.dsh-pm-body > * { flex: none; } /* 直接子元素（卡片/空态/表单容器）禁止 flex 压缩 */
.dsh-pm-empty { padding: 26px 14px; border: 1px dashed var(--dsw-alias-border-l2, #ccc); border-radius: 12px; text-align: center; font-size: 12px; color: var(--dsw-alias-label-tertiary, #999); line-height: 1.7; flex: none; }
.dsh-pm-error { font-size: 12px; color: #dc2626; padding: 4px 0; flex: none; }

/* 按钮 */
.dsh-pm-btn {
  padding: 4px 10px; border: 1px solid var(--dsw-alias-border-l2, #ddd); border-radius: 7px;
  cursor: pointer; background: var(--dsw-alias-bg-layer-1, #fff);
  font: inherit; font-size: 11.5px; color: var(--dsw-alias-label-primary, #222);
  transition: transform .08s ease, box-shadow .12s ease; white-space: nowrap;
}
.dsh-pm-btn:hover:not(:disabled) { box-shadow: 0 2px 6px rgba(0,0,0,.10); transform: translateY(-1px); }
.dsh-pm-btn:disabled { opacity: .5; cursor: default; }
.dsh-pm-btn[data-primary] { border-color: var(--dsw-alias-brand-primary, #4f7cff); color: var(--dsw-alias-brand-primary, #4f7cff); background: color-mix(in srgb, var(--dsw-alias-brand-primary, #4f7cff) 8%, transparent); }
.dsh-pm-btn[data-danger] { border-color: #e05252; color: #e05252; background: color-mix(in srgb, #e05252 6%, transparent); }

/* 项目卡片 */
.dsh-pm-card { border: 1px solid var(--dsw-alias-border-l2, #ddd); border-radius: 11px; background: var(--dsw-alias-bg-layer-1, #fff); overflow: hidden; }
.dsh-pm-card-head { display: flex; align-items: center; gap: 8px; padding: 8px 10px; flex-wrap: wrap; }
.dsh-pm-card-name { font-size: 13px; font-weight: 600; color: var(--dsw-alias-label-primary, #222); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
.dsh-pm-badge { display: inline-flex; align-items: center; gap: 5px; padding: 0 8px; border-radius: 999px; font-size: 10.5px; line-height: 17px; white-space: nowrap; flex: none; }
.dsh-pm-badge .dot { width: 7px; height: 7px; border-radius: 50%; flex: none; }
.dsh-pm-badge[data-state="running"] { background: color-mix(in srgb, #22c55e 16%, transparent); color: #16a34a; }
.dsh-pm-badge[data-state="running"] .dot { background: #22c55e; box-shadow: 0 0 0 3px rgba(34,197,94,.2); animation: dsh-pm-pulse 1.6s ease-in-out infinite; }
.dsh-pm-badge[data-state="starting"], .dsh-pm-badge[data-state="stopping"] { background: color-mix(in srgb, #f59e0b 16%, transparent); color: #d97706; }
.dsh-pm-badge[data-state="starting"] .dot, .dsh-pm-badge[data-state="stopping"] .dot { background: #f59e0b; animation: dsh-pm-pulse 1s ease-in-out infinite; }
.dsh-pm-badge[data-state="exited"] { background: color-mix(in srgb, #f59e0b 12%, transparent); color: #b45309; }
.dsh-pm-badge[data-state="exited"] .dot { background: #f59e0b; }
.dsh-pm-badge[data-state="failed"] { background: color-mix(in srgb, #ef4444 12%, transparent); color: #dc2626; }
.dsh-pm-badge[data-state="failed"] .dot { background: #ef4444; }
.dsh-pm-badge[data-state="stopped"] { background: var(--dsw-alias-bg-layer-2, #eee); color: var(--dsw-alias-label-tertiary, #888); }
.dsh-pm-badge[data-state="stopped"] .dot { background: var(--dsw-alias-label-tertiary, #888); }
@keyframes dsh-pm-pulse { 0%,100% { opacity: 1; } 50% { opacity: .35; } }
.dsh-pm-card-actions { display: flex; gap: 4px; align-items: center; flex-wrap: wrap; }
.dsh-pm-pid { font-size: 10.5px; color: var(--dsw-alias-label-tertiary, #999); font-family: var(--dsw-font-mono, monospace); flex: none; }

.dsh-pm-detail { padding: 0 10px 9px; display: flex; flex-direction: column; gap: 6px; }
.dsh-pm-meta { display: flex; flex-direction: column; gap: 2px; font-size: 11px; color: var(--dsw-alias-label-secondary, #667); }
.dsh-pm-meta code { font-family: var(--dsw-font-mono, monospace); color: var(--dsw-alias-label-primary, #222); background: var(--dsw-alias-bg-layer-2, #f4f4f6); padding: 1px 5px; border-radius: 5px; word-break: break-all; }
.dsh-pm-row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.dsh-pm-hint { font-size: 10.5px; color: var(--dsw-alias-label-tertiary, #999); }
.dsh-pm-warn { font-size: 11px; color: #dc2626; }

/* 开关 */
.dsh-pm-switch { position: relative; width: 32px; height: 18px; border-radius: 9px; border: 1px solid var(--dsw-alias-border-l2, #ddd); cursor: pointer; background: var(--dsw-alias-bg-layer-2, #eee); transition: background .15s ease; flex: none; }
.dsh-pm-switch::after { content: ""; position: absolute; top: 2px; left: 2px; width: 12px; height: 12px; border-radius: 50%; background: #fff; transition: left .15s ease; box-shadow: 0 1px 3px rgba(0,0,0,.25); }
.dsh-pm-switch[data-on] { background: var(--dsw-alias-brand-primary, #4f7cff); }
.dsh-pm-switch[data-on]::after { left: 16px; }

/* 表单 */
.dsh-pm-form { display: flex; flex-direction: column; gap: 8px; padding: 10px 12px; border: 1px dashed var(--dsw-alias-border-l2, #ccc); border-radius: 11px; background: var(--dsw-alias-bg-layer-2, #f7f7f9); }
.dsh-pm-field { display: flex; flex-direction: column; gap: 3px; }
.dsh-pm-field label { font-size: 11px; font-weight: 600; color: var(--dsw-alias-label-secondary, #667); }
.dsh-pm-field input, .dsh-pm-field textarea {
  padding: 5px 8px; border: 1px solid var(--dsw-alias-border-l2, #ddd); border-radius: 7px;
  background: var(--dsw-alias-bg-layer-1, #fff); font: inherit; font-size: 11.5px; color: var(--dsw-alias-label-primary, #222);
}
.dsh-pm-field textarea { resize: vertical; min-height: 38px; font-family: var(--dsw-font-mono, monospace); }
.dsh-pm-form-actions { display: flex; gap: 6px; align-items: center; }
.dsh-pm-form-error { font-size: 11px; color: #dc2626; }

/* 日志查看器 */
.dsh-pm-log { border-top: 1px solid var(--dsw-alias-border-l2, #ddd); }
.dsh-pm-log-bar { display: flex; align-items: center; gap: 6px; padding: 5px 10px; background: var(--dsw-alias-bg-layer-2, #f7f7f9); }
.dsh-pm-log-title { font-size: 11px; font-weight: 600; color: var(--dsw-alias-label-secondary, #667); }
.dsh-pm-log-scroll { flex: 1; font-size: 10.5px; color: var(--dsw-alias-label-tertiary, #999); }
.dsh-pm-log-body {
  margin: 0; padding: 6px 10px 9px; max-height: 220px; overflow: auto;
  background: var(--dsw-alias-bg-layer-1, #fff);
  font-family: var(--dsw-font-mono, monospace); font-size: 10.5px; line-height: 1.6;
  color: var(--dsw-alias-label-secondary, #445);
  white-space: pre-wrap; word-break: break-all;
}
.dsh-pm-log-line { display: flex; gap: 6px; }
.dsh-pm-log-line .t { flex: none; color: var(--dsw-alias-label-tertiary, #aaa); }
.dsh-pm-log-line[data-stream="err"] { color: #dc2626; }
.dsh-pm-log-line[data-stream="sys"] { color: var(--dsw-alias-brand-primary, #4f7cff); }
.dsh-pm-log-empty { padding: 8px 10px; font-size: 11px; color: var(--dsw-alias-label-tertiary, #999); font-family: var(--dsw-font-mono, monospace); }
`;
    (function injectCss() {
      if (typeof document === "undefined") return;
      if (document.querySelector("style[data-plugin-css=\"" + CSS_ID + "\"]")) return;
      const tag = document.createElement("style");
      tag.dataset.plugin = "@dsh-user/dsh-project-manager";
      tag.dataset.pluginCss = CSS_ID;
      tag.textContent = css;
      document.head.appendChild(tag);
    })();

    // ── localStorage 持久化 ─────────────────────────────────────────────
    function lsGet(key, fallback) {
      try {
        const raw = window.localStorage.getItem(key);
        if (raw === null || raw === undefined) return fallback;
        return JSON.parse(raw);
      } catch { return fallback; }
    }
    function lsSet(key, value) {
      try { window.localStorage.setItem(key, JSON.stringify(value)); } catch {}
    }

    // ── API 封装 ────────────────────────────────────────────────────────
    async function apiGet(path) {
      const res = await fetch(API + path, { cache: "no-store" });
      const body = await res.json().catch(() => ({ ok: false, error: "响应解析失败" }));
      if (!body.ok) throw new Error(body.error || ("HTTP " + res.status));
      return body.data;
    }
    async function apiPost(path, payload) {
      const res = await fetch(API + path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload || {}),
      });
      const body = await res.json().catch(() => ({ ok: false, error: "响应解析失败" }));
      if (!body.ok) throw new Error(body.error || ("HTTP " + res.status));
      return body.data;
    }
    async function apiPut(path, payload) {
      const res = await fetch(API + path, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload || {}),
      });
      const body = await res.json().catch(() => ({ ok: false, error: "响应解析失败" }));
      if (!body.ok) throw new Error(body.error || ("HTTP " + res.status));
      return body.data;
    }
    async function apiDelete(path) {
      const res = await fetch(API + path, { method: "DELETE" });
      const body = await res.json().catch(() => ({ ok: false, error: "响应解析失败" }));
      if (!body.ok) throw new Error(body.error || ("HTTP " + res.status));
      return body.data;
    }

    // ── 小组件 ──────────────────────────────────────────────────────────
    function StateBadge({ state }) {
      const labels = {
        stopped: "已停止", starting: "启动中", running: "运行中",
        stopping: "停止中", exited: "已退出", failed: "失败",
      };
      return React.createElement("span", { className: "dsh-pm-badge", "data-state": state },
        React.createElement("span", { className: "dot" }),
        labels[state] || state
      );
    }

    function Switch({ on, onChange, disabled, title }) {
      return React.createElement("div", {
        className: "dsh-pm-switch", "data-on": on ? "true" : undefined,
        title, role: "switch", "aria-checked": on,
        onClick: (e) => { e.preventDefault(); e.stopPropagation(); if (!disabled && onChange) onChange(!on); },
      });
    }

    function fmtTime(t) {
      if (!t) return "—";
      const d = new Date(t);
      const p = (n) => String(n).padStart(2, "0");
      return p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
    }

    // ── 日志查看器（每个项目一个）──────────────────────────────────────
    function LogViewer({ projectId }) {
      const [lines, setLines] = useState([]);
      const [autoScroll, setAutoScroll] = useState(true);
      const [error, setError] = useState(null);
      const bodyRef = useRef(null);
      const sinceRef = useRef(0); // 增量拉取游标（与 host 的 seq 对齐）

      useEffect(() => {
        let alive = true;
        let timer = null;
        const tick = async () => {
          if (!alive) return;
          try {
            const data = await apiGet("/projects/" + encodeURIComponent(projectId) + "/logs?since=" + sinceRef.current);
            if (alive && data.lines && data.lines.length > 0) {
              sinceRef.current = data.since;
              setLines((prev) => [...prev, ...data.lines]);
              setError(null);
            }
          } catch (e) {
            if (alive) setError(e.message);
          }
        };
        tick();
        timer = setInterval(tick, 1500);
        return () => { alive = false; if (timer) clearInterval(timer); };
      }, [projectId]);

      // 自动滚动到底部
      useEffect(() => {
        if (autoScroll && bodyRef.current) {
          bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
        }
      }, [lines, autoScroll]);

      const clearLogs = async () => {
        try {
          await apiPost("/projects/" + encodeURIComponent(projectId) + "/logs/clear", {});
          sinceRef.current = 0;
          setLines([]);
        } catch (e) { setError(e.message); }
      };

      return React.createElement("div", { className: "dsh-pm-log" },
        React.createElement("div", { className: "dsh-pm-log-bar" },
          React.createElement("span", { className: "dsh-pm-log-title" }, "日志"),
          React.createElement("label", { className: "dsh-pm-log-scroll", style: { display: "flex", alignItems: "center", gap: 4, cursor: "pointer" } },
            React.createElement(Switch, { on: autoScroll, onChange: setAutoScroll, title: "自动滚动" }),
            "自动滚动"
          ),
          React.createElement("button", { className: "dsh-pm-btn", onClick: clearLogs }, "清空")
        ),
        lines.length === 0
          ? React.createElement("div", { className: "dsh-pm-log-empty" }, error ? ("⚠ " + error) : "暂无日志")
          : React.createElement("pre", { className: "dsh-pm-log-body", ref: bodyRef },
              lines.map((l) =>
                React.createElement("div", { key: l.n, className: "dsh-pm-log-line", "data-stream": l.stream },
                  React.createElement("span", { className: "t" }, fmtTime(l.t)),
                  React.createElement("span", null, l.text)
                )
              )
            )
      );
    }

    // ── 单项目卡片 ──────────────────────────────────────────────────────
    function ProjectCard({ project, onChanged, onDeleted }) {
      const [busy, setBusy] = useState(null); // start|stop|restart
      const [error, setError] = useState(null);
      const [showLog, setShowLog] = useState(false);
      const [deleting, setDeleting] = useState(false);

      const run = async (action) => {
        setBusy(action);
        setError(null);
        try {
          await apiPost("/projects/" + encodeURIComponent(project.id) + "/" + action, {});
          onChanged();
          setTimeout(onChanged, 600); // 等状态稳定后再刷一次
        } catch (e) { setError(e.message); }
        setBusy(null);
      };

      const toggleHotReload = async (next) => {
        setError(null);
        try {
          await apiPut("/projects/" + encodeURIComponent(project.id), { hotReload: next });
          onChanged();
        } catch (e) { setError(e.message); }
      };

      const remove = async () => {
        if (!window.confirm("确定删除项目「" + project.name + "」？运行中的进程会被停止。")) return;
        setDeleting(true);
        try {
          await apiDelete("/projects/" + encodeURIComponent(project.id));
          onDeleted();
        } catch (e) { setError(e.message); }
        setDeleting(false);
      };

      const running = project.state === "running" || project.state === "starting" || project.state === "stopping";
      const meta = [
        ["目录", project.cwd],
        ["命令", project.command + (project.args && project.args.length ? " " + project.args.join(" ") : "")],
        project.watchExts && project.watchExts.length ? ["热重载后缀", project.watchExts.join(", ")] : null,
      ].filter(Boolean);

      return React.createElement("div", { className: "dsh-pm-card" },
        React.createElement("div", { className: "dsh-pm-card-head" },
          React.createElement("span", { className: "dsh-pm-card-name", title: project.name }, project.name),
          React.createElement(StateBadge, { state: project.state }),
          project.pid ? React.createElement("span", { className: "dsh-pm-pid" }, "PID " + project.pid) : null,
          React.createElement("div", { className: "dsh-pm-card-actions" },
            React.createElement("button", { className: "dsh-pm-btn", disabled: busy !== null || deleting, onClick: () => setShowLog(!showLog) }, showLog ? "收起日志" : "日志"),
            !running
              ? React.createElement("button", { className: "dsh-pm-btn", "data-primary": "true", disabled: busy !== null || deleting, onClick: () => run("start") }, busy === "start" ? "启动中…" : "启动")
              : React.createElement("button", { className: "dsh-pm-btn", "data-danger": "true", disabled: busy !== null || deleting, onClick: () => run("stop") }, busy === "stop" ? "停止中…" : "停止"),
            React.createElement("button", { className: "dsh-pm-btn", disabled: busy !== null || deleting, onClick: () => run("restart") }, busy === "restart" ? "重启中…" : "重启"),
            React.createElement("button", { className: "dsh-pm-btn", "data-danger": "true", disabled: busy !== null || deleting, onClick: remove }, deleting ? "删除中…" : "删除")
          )
        ),
        React.createElement("div", { className: "dsh-pm-detail" },
          meta.map(([k, v]) =>
            React.createElement("div", { key: k, className: "dsh-pm-meta" },
              React.createElement("span", null, k + "："),
              React.createElement("code", null, v)
            )
          ),
          React.createElement("div", { className: "dsh-pm-row" },
            React.createElement(Switch, { on: project.hotReload, onChange: toggleHotReload, disabled: deleting, title: "文件变更自动重启" }),
            React.createElement("span", { className: "dsh-pm-hint" }, "热重载" + (project.hotReload ? "（文件变更自动重启）" : "（已关闭）")),
            project.autoStart ? React.createElement("span", { className: "dsh-pm-hint" }, "· 自动启动") : null
          ),
          project.watcherError
            ? React.createElement("div", { className: "dsh-pm-warn" }, "⚠ 文件监听异常：" + project.watcherError)
            : null,
          error ? React.createElement("div", { className: "dsh-pm-warn" }, "⚠ " + error) : null
        ),
        showLog ? React.createElement(LogViewer, { projectId: project.id }) : null
      );
    }

    // ── 添加项目表单 ────────────────────────────────────────────────────
    function AddProjectForm({ onAdded }) {
      const [open, setOpen] = useState(false);
      const [form, setForm] = useState({ name: "", cwd: "", command: "", args: "", autoStart: false, hotReload: true, watchExts: "", env: "" });
      const [busy, setBusy] = useState(false);
      const [error, setError] = useState(null);

      const set = (key, value) => setForm((f) => ({ ...f, [key]: value }));

      const submit = async () => {
        setError(null);
        if (!form.name.trim() || !form.cwd.trim() || !form.command.trim()) {
          setError("名称 / 工作目录 / 启动命令 为必填");
          return;
        }
        setBusy(true);
        try {
          const env = {};
          for (const line of form.env.split(/\r?\n/)) {
            const t = line.trim();
            if (!t) continue;
            const idx = t.indexOf("=");
            if (idx === -1) { setError("环境变量格式应为 KEY=VALUE：" + t); setBusy(false); return; }
            env[t.slice(0, idx).trim()] = t.slice(idx + 1).trim();
          }
          await apiPost("/projects", {
            name: form.name.trim(),
            cwd: form.cwd.trim(),
            command: form.command.trim(),
            args: form.args.split(/\s+/).filter(Boolean),
            autoStart: form.autoStart,
            hotReload: form.hotReload,
            watchExts: form.watchExts.split(/[,，;；\s]+/).filter(Boolean),
            env,
          });
          setForm({ name: "", cwd: "", command: "", args: "", autoStart: false, hotReload: true, watchExts: "", env: "" });
          setOpen(false);
          onAdded();
        } catch (e) { setError(e.message); }
        setBusy(false);
      };

      const input = (key, placeholder, type) =>
        React.createElement("div", { className: "dsh-pm-field", key: key },
          React.createElement("label", null, placeholder),
          React.createElement("input", {
            type: type || "text",
            value: form[key],
            placeholder: placeholder,
            onChange: (e) => set(key, e.target.value),
          })
        );

      return React.createElement("div", null,
        React.createElement("button", { className: "dsh-pm-btn", "data-primary": "true", onClick: () => setOpen(!open) },
          open ? "收起表单" : "+ 添加项目"
        ),
        open
          ? React.createElement("div", { className: "dsh-pm-form" },
              input("name", "项目名称 *"),
              input("cwd", "工作目录（绝对路径）*"),
              input("command", "启动命令 *（如 npm run dev / python app.py）"),
              input("args", "附加参数（空格分隔，可留空）"),
              React.createElement("div", { className: "dsh-pm-field" },
                React.createElement("label", null, "热重载文件后缀白名单（逗号分隔，留空=全部文件）"),
                React.createElement("input", { value: form.watchExts, onChange: (e) => set("watchExts", e.target.value), placeholder: "js,ts,json,py" })
              ),
              React.createElement("div", { className: "dsh-pm-field" },
                React.createElement("label", null, "附加环境变量（每行 KEY=VALUE）"),
                React.createElement("textarea", { value: form.env, onChange: (e) => set("env", e.target.value), placeholder: "PORT=8080" })
              ),
              React.createElement("div", { className: "dsh-pm-row" },
                React.createElement(Switch, { on: form.autoStart, onChange: (v) => set("autoStart", v) }),
                React.createElement("span", { className: "dsh-pm-hint" }, "DSH 启动时自动拉起"),
                React.createElement(Switch, { on: form.hotReload, onChange: (v) => set("hotReload", v) }),
                React.createElement("span", { className: "dsh-pm-hint" }, "热重载")
              ),
              React.createElement("div", { className: "dsh-pm-form-actions" },
                React.createElement("button", { className: "dsh-pm-btn", "data-primary": "true", disabled: busy, onClick: submit }, busy ? "添加中…" : "添加"),
                React.createElement("button", { className: "dsh-pm-btn", onClick: () => setOpen(false) }, "取消")
              ),
              error ? React.createElement("div", { className: "dsh-pm-form-error" }, "⚠ " + error) : null
            )
          : null
      );
    }

    // ── 悬浮窗口主体 ────────────────────────────────────────────────────
    function FloatingWindow() {
      const [projects, setProjects] = useState(null); // null=加载中
      const [error, setError] = useState(null);
      const [collapsed, setCollapsed] = useState(() => lsGet(LS_COLLAPSED, false));
      // 位置：默认右下角
      const [pos, setPos] = useState(() => {
        const saved = lsGet(LS_POS, null);
        if (saved && typeof saved.x === "number" && typeof saved.y === "number") return saved;
        const w = (typeof window !== "undefined" ? window.innerWidth : 1280);
        const h = (typeof window !== "undefined" ? window.innerHeight : 800);
        return { x: Math.max(12, w - WIN_W - 20), y: Math.max(12, h - WIN_H - 60) };
      });
      const posRef = useRef(pos);
      const drag = useRef(null); // { dx, dy }
      const draggingRef = useRef(false);
      const [dragging, setDragging] = useState(false);

      // 窗口 resize 时把窗口钳回可视区域（保证整个窗口可见）
      useEffect(() => {
        const onResize = () => {
          const w = window.innerWidth;
          const h = window.innerHeight;
          const maxY = Math.max(40, h - 600 - 20); // 600=最大高度，留 20px 边距
          const next = {
            x: Math.min(Math.max(0, posRef.current.x), Math.max(0, w - 80)),
            y: Math.min(Math.max(0, posRef.current.y), maxY),
          };
          if (next.x !== posRef.current.x || next.y !== posRef.current.y) {
            posRef.current = next;
            setPos(next);
            lsSet(LS_POS, next);
          }
        };
        window.addEventListener("resize", onResize);
        return () => window.removeEventListener("resize", onResize);
      }, []);

      const refresh = useCallback(async () => {
        try {
          const data = await apiGet("/projects");
          setProjects(data);
          setError(null);
        } catch (e) { setError(e.message); }
      }, []);

      useEffect(() => {
        refresh();
        const timer = setInterval(refresh, 3000);
        return () => clearInterval(timer);
      }, [refresh]);

      // 拖拽（仅标题栏）
      const onTitlePointerDown = (e) => {
        // 折叠/展开按钮等交互元素：不进入拖拽。否则 preventDefault 会取消
        // pointerdown（连带抑制 click），setPointerCapture 又会把 click 重定向
        // 到标题栏，导致按钮的 onClick 永远不触发。
        if (e.target && e.target.closest && e.target.closest("button")) return;
        if (e.pointerType === "mouse" && e.button !== 0) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = { dx: e.clientX - posRef.current.x, dy: e.clientY - posRef.current.y };
        draggingRef.current = true;
        setDragging(true);
      };
      const onTitlePointerMove = (e) => {
        if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
        const w = window.innerWidth;
        const h = window.innerHeight;
        const maxY = Math.max(40, h - 600 - 20); // 保证窗口主体可见
        const x = Math.min(Math.max(0, e.clientX - drag.current.dx), w - 60);
        const y = Math.min(Math.max(0, e.clientY - drag.current.dy), maxY);
        posRef.current = { x, y };
        setPos(posRef.current);
      };
      const onTitlePointerUp = (e) => {
        if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
        e.currentTarget.releasePointerCapture(e.pointerId);
        draggingRef.current = false;
        setDragging(false);
        lsSet(LS_POS, posRef.current);
      };

      const toggleCollapsed = () => {
        setCollapsed((c) => {
          lsSet(LS_COLLAPSED, !c);
          return !c;
        });
      };

      const runningCount = projects ? projects.filter((p) => p.state === "running").length : 0;

      const titleBar = React.createElement("div", {
        className: "dsh-pm-titlebar",
        "data-dragging": dragging || undefined,
        onPointerDown: onTitlePointerDown,
        onPointerMove: onTitlePointerMove,
        onPointerUp: onTitlePointerUp,
        title: "拖拽移动",
      },
        React.createElement("span", { className: "dsh-pm-title" },
          React.createElement("span", { className: "glyph" }, "🛠️"),
          "项目管理"
        ),
        React.createElement("span", { className: "dsh-pm-summary" },
          projects ? (projects.length + " 项目 · " + runningCount + " 运行中") : "…"
        ),
        React.createElement("div", { className: "dsh-pm-titlebar-actions" },
          React.createElement("button", {
            className: "dsh-pm-icon-btn", title: collapsed ? "展开" : "折叠",
            onClick: toggleCollapsed,
          }, collapsed ? "▸" : "▾")
        )
      );

      // 折叠：只显示标题栏
      if (collapsed) {
        return React.createElement("div", { className: "dsh-pm-win", "data-collapsed": "true", style: { left: pos.x, top: pos.y } },
          titleBar
        );
      }

      const body = React.createElement("div", { className: "dsh-pm-body" },
        error ? React.createElement("div", { className: "dsh-pm-error" }, "⚠ " + error) : null,
        projects === null
          ? React.createElement("div", { className: "dsh-pm-empty" }, "加载中…")
          : projects.length === 0
            ? React.createElement("div", { className: "dsh-pm-empty" },
                "还没有项目。点击上方「+ 添加项目」，填入工作目录和启动命令即可管理。"
              )
            : projects.map((p) =>
                React.createElement(ProjectCard, {
                  key: p.id,
                  project: p,
                  onChanged: refresh,
                  onDeleted: () => refresh(),
                })
              ),
        React.createElement(AddProjectForm, { onAdded: () => refresh() })
      );

      return React.createElement("div", { className: "dsh-pm-win", style: { left: pos.x, top: pos.y } },
        titleBar,
        body
      );
    }

    // ── 插件主体：注册悬浮窗口 ──────────────────────────────────────────
    function apply(ctx) {
      try {
        ctx.effect(() => {
          const timer = setInterval(() => {
            try {
              const slots = ctx.get("slots");
              if (!slots) return;
              slots.inject("shell.overlay", () => slots.register(
                { name: "shell.overlay", id: "dsh-project-manager", order: 5 },
                FloatingWindow
              ));
              clearInterval(timer);
            } catch (e) {
              ctx.logger?.warn?.("dsh-project-manager: 悬浮窗口注册失败", e);
            }
          }, 300);
          return () => clearInterval(timer);
        }, "dsh-project-manager: floating window boot");
      } catch (e) {
        ctx.logger?.warn?.("dsh-project-manager: client boot failed", e);
      }
    }

    exports.apply = apply;
    return module.exports;
  }
});
