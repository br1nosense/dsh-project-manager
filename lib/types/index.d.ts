/**
 * @dsh-user/dsh-project-manager — host 半边类型声明。
 */
import type { Context } from "@deepseek-ai/cordis";

/** 项目运行状态。 */
export type ProjectState =
  | "stopped"
  | "starting"
  | "running"
  | "stopping"
  | "exited"
  | "failed";

/** 一个被管理的项目（配置 + 实时运行视图）。 */
export interface ProjectView {
  id: string;
  name: string;
  cwd: string;
  command: string;
  args: string[];
  autoStart: boolean;
  hotReload: boolean;
  watchExts: string[];
  env: Record<string, string>;
  state: ProjectState;
  pid: number | null;
  exitCode: number | null;
  startedAt: number;
  watcherError: string | null;
}

/** 一条日志行。 */
export interface LogLine {
  t: number;
  stream: "out" | "err" | "sys";
  text: string;
  n: number;
}

/** 增量日志读取结果。 */
export interface LogSlice {
  id: string;
  since: number;
  lines: LogLine[];
  state: ProjectState;
  pid: number | null;
  logFile: string | null;
}

/** ctx.projectManager 服务。 */
export interface ProjectManagerService {
  name: string;
  describe(): { projectCount: number; runningCount: number; projects: ProjectView[] };
  list(): ProjectView[];
  get(id: string): ProjectView | null;
  add(input: {
    name: string;
    cwd: string;
    command: string;
    args?: string[];
    autoStart?: boolean;
    hotReload?: boolean;
    watchExts?: string[];
    env?: Record<string, string>;
  }): Promise<string>;
  remove(id: string): Promise<void>;
  start(id: string): { ok: boolean; error?: string };
  stop(id: string): { ok: boolean; error?: string };
  restart(id: string): { ok: boolean; error?: string };
  logs(id: string, since?: number): LogSlice | null;
}

declare module "@deepseek-ai/cordis" {
  interface Context {
    projectManager: ProjectManagerService;
  }
}

export default function apply(ctx: Context): void;
