/**
 * Tiny zero-dependency i18n for the read-only client.
 *
 * Strategy: the English source string IS the key. `t("Settings")` returns the
 * English text as-is when the language is `en`; in `zh` it looks up a Chinese
 * override and falls back to the English source when a key is missing — so a
 * partial translation degrades gracefully and never throws. Interpolate with
 * `{name}` placeholders: `t("{n} running", { n: 3 })`.
 *
 * The chosen language is persisted to localStorage; on first load it is inferred
 * from the browser/OS locale (a Chinese system opens in Chinese). Switching is a
 * pure presentation change — the app re-renders from `t()` on every paint, so a
 * single re-render after setLang() updates the whole UI.
 */

export type Lang = "en" | "zh";

const STORE_KEY = "odw.lang";

function initialLang(): Lang {
  try {
    const v = localStorage.getItem(STORE_KEY);
    if (v === "zh" || v === "en") return v;
  } catch {
    /* localStorage may be unavailable (private mode / sandbox) */
  }
  try {
    if (navigator.language?.toLowerCase().startsWith("zh")) return "zh";
  } catch {
    /* navigator may be absent in headless capture */
  }
  return "en";
}

let lang: Lang = initialLang();

export function getLang(): Lang {
  return lang;
}

/** Set + persist the language. Caller re-renders; this does not touch the DOM. */
export function setLang(next: Lang): void {
  lang = next;
  try {
    localStorage.setItem(STORE_KEY, next);
  } catch {
    /* persistence is best-effort */
  }
}

/**
 * Translate `s` and fill any `{key}` placeholders from `vars`. In `en` the
 * source string is returned verbatim (placeholders still filled); in `zh` an
 * override is used when present, else the English source. Values are inserted
 * raw — callers that interpolate into innerHTML escape the *result* as they
 * already do, and the handful of strings carrying intentional markup pass it in
 * deliberately.
 */
export function t(s: string, vars?: Record<string, string | number>): string {
  let out = lang === "zh" ? (ZH[s] ?? s) : s;
  if (vars) {
    for (const k in vars) out = out.split(`{${k}}`).join(String(vars[k]));
  }
  return out;
}

// --- Chinese overrides, keyed by the English source string. ------------------
// Grouped by area for maintenance. Machine event tokens (RUN_STARTED, AGENT_*,
// LOG, …) are deliberately NOT translated: they mirror the event names in
// events.jsonl and read as constants in the monospace event stream.
const ZH: Record<string, string> = {
  // Shell — connection, rail nav, status bar.
  Live: "实时",
  "Reconnecting…": "重新连接…",
  "Connecting…": "连接中…",
  connecting: "连接中",
  reconnecting: "重新连接",
  "fan out coding agents": "并行调度编码智能体",
  Activity: "动态",
  Workspace: "工作区",
  Jobs: "任务",
  Settings: "设置",
  "Live now": "正在运行",
  "{a} active · {r} running": "{a} 个进行中 · {r} 个运行中",
  "live · SSE": "实时 · SSE",

  // Run states (badge labels; the CSS class keeps the English state).
  running: "运行中",
  paused: "已暂停",
  done: "完成",
  failed: "失败",
  stopped: "已停止",
  stale: "停滞",
  pending: "等待中",

  // Settings.
  "CLI adapters and app preferences. The client never starts runs — these only tell it how to read and which CLIs exist.":
    "CLI 适配器与应用偏好。客户端从不启动运行——这些设置只告诉它如何读取数据、以及有哪些 CLI 可用。",
  Adapters: "适配器",
  Reading: "读取",
  App: "应用",
  default: "默认",
  "not found": "未找到",
  test: "测试",
  "add a path in odw.config.json": "在 odw.config.json 中添加路径",
  "Run directory": "运行目录",
  "reveal in Finder": "在访达中显示",
  "Workflow directories": "工作流目录",
  Language: "语言",
  "switch the interface language": "切换界面语言",
  "Launch at login": "开机时启动",
  "keep watching runs in the background": "在后台持续监视运行",
  "Dock badge — active run count": "程序坞角标 — 进行中的运行数",
  "Native notification on run finish / fail": "运行完成 / 失败时发送系统通知",
  "Notify only on failure": "仅在失败时通知",
  "This build is read-only. To start a run, your agent uses {cmd} — there is no run button by design.":
    "此版本为只读。要启动运行，你的智能体使用 {cmd}——此处刻意不设运行按钮。",

  // Workspace.
  shadowed: "被覆盖",
  "name shadowed — odw run {name} runs a higher-precedence workflow":
    "名称被覆盖——odw run {name} 实际运行的是优先级更高的工作流",
  "{n} phases": "{n} 个阶段",
  "· {n} runs": "· {n} 次运行",
  "parallel · fan-out": "并行 · 扇出",
  pipeline: "流水线",
  agent: "智能体",
  "no declared phases": "未声明阶段",
  Structure: "结构",
  "Recent runs": "近期运行",
  "view →": "查看 →",
  "— shadowed; this runs a higher-precedence {name}": "——已被覆盖；实际运行优先级更高的 {name}",
  "— started by your agent, not here": "——由你的智能体启动，而非在此处",
  Phases: "阶段",
  "Source — {name}.js": "源码 — {name}.js",
  "Loading workflows…": "正在加载工作流…",
  "No workflows yet": "暂无工作流",
  "Your agent writes workflows into the managed directories.": "你的智能体会把工作流写入受管目录。",
  "Select a workflow to see its structure and source.": "选择一个工作流以查看其结构与源码。",
  Workflows: "工作流",
  "{n} · managed dirs": "{n} · 受管目录",

  // Jobs.
  "Active now": "进行中",
  workflow: "工作流",
  "run id": "运行 ID",
  status: "状态",
  started: "开始时间",
  duration: "时长",
  agents: "智能体",
  "No runs yet": "暂无运行",
  "Runs your agent starts with the CLI appear here.": "你的智能体通过 CLI 启动的运行会显示在这里。",
  "No finished runs yet.": "暂无已完成的运行。",
  "{n} running": "{n} 个运行中",
  "{n} done": "{n} 个完成",
  "{n} failed": "{n} 个失败",

  // Activity.
  idle: "空闲",
  "No recent events — start a run with {cmd}": "暂无近期事件——使用 {cmd} 启动一次运行",
  "runs active": "进行中的运行",
  "agents running": "运行中的智能体",
  "agents done": "已完成的智能体",
  "agents failed": "失败的智能体",
  "Fleet — agents running, by adapter": "机群 — 各适配器运行中的智能体",
  "Live event stream": "实时事件流",
  "all runs · events.jsonl": "全部运行 · events.jsonl",

  // Job detail.
  Graph: "图",
  Logs: "日志",
  Result: "结果",
  phases: "阶段",
  "⧉ Copy run id": "⧉ 复制运行 ID",
  "✓ copied": "✓ 已复制",
  "⊞ Open run dir": "⊞ 打开运行目录",
  Error: "错误",
  Status: "状态",
  "running…": "运行中…",
  "started {t}": "开始于 {t}",
  Outcome: "结果",
  "done in {d}": "耗时 {d} 完成",
  "attempts: {n}": "重试：{n}",
  "worker lost contact": "worker 失联",
  "(no message)": "（无消息）",
  adapter: "适配器",
  phase: "阶段",
  live: "实时",
  "Read-only": "只读",
  "This view never re-runs or controls an agent — runs are driven by the CLI.":
    "此视图从不重跑或控制智能体——运行由 CLI 驱动。",
  "last activity {t}": "最后活动 {t}",
  "⚠ worker lost contact": "⚠ worker 失联",
  "Waiting for the first agent…": "等待第一个智能体…",
  "Declared phases:": "已声明的阶段：",
  "No events yet.": "暂无事件。",
  "No result yet": "暂无结果",
  "A result is written when the run finishes successfully.": "运行成功结束后会写入结果。",
  "Loading result…": "正在加载结果…",
  "Loading run…": "正在加载运行…",

  // Live DAG (dag.ts). "run" is the fallback lane label when an agent has no
  // declared phase; "more agents" is the per-lane overflow card suffix.
  run: "运行",
  "more agents": "更多智能体",

  // Relative time + day buckets (util.ts).
  "just now": "刚刚",
  "{n}m ago": "{n} 分钟前",
  "{n}h ago": "{n} 小时前",
  "{n}d ago": "{n} 天前",
  Earlier: "更早",
  Today: "今天",
  Yesterday: "昨天",

  // Native notifications (built in the web layer, shown by the Tauri shell).
  "{name} failed": "{name} 运行失败",
  "{failed} of {agents} agents failed": "{agents} 个智能体中 {failed} 个失败",
  "{name} stopped": "{name} 已停止",
  "Run was stopped": "运行已停止",
  "{name} finished": "{name} 已完成",
  "{agents} agents": "{agents} 个智能体",
};
