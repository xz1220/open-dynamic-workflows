/**
 * Tiny zero-dependency i18n for the client.
 *
 * Strategy: the English source string IS the key. `t("Settings")` returns the
 * English text as-is when the language is `en`; in `zh` it looks up a Chinese
 * override and falls back to the English source when a key is missing — so a
 * partial translation degrades gracefully and never throws. Interpolate with
 * `{name}` placeholders: `t("{n} running", { n: 3 })`.
 *
 * The chosen language is persisted to localStorage and defaults to English; the
 * UI only switches to Chinese when the user explicitly picks it (the choice then
 * persists across loads). Switching is a pure presentation change — the app
 * re-renders from `t()` on every paint, so a single re-render after setLang()
 * updates the whole UI.
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
  // Default to English. We intentionally do NOT auto-detect from navigator.language
  // — a Chinese OS still opens in English unless the user opts into 中文 in Settings.
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
/** Count-aware `t`: picks the singular or plural English source, `{n}` filled. */
export function tn(n: number, one: string, many: string, vars?: Record<string, string | number>): string {
  return t(n === 1 ? one : many, { n, ...vars });
}

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
  Chat: "对话",
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
  "Claude Code workflow — observed read-only": "Claude Code 工作流 —— 只读观测",
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

  // Chat Host.
  "Chat Host": "对话宿主",
  "local backend": "本地后端",
  "+ New": "+ 新建",
  "Host activity": "宿主动态",
  "Linked ODW runs": "关联 ODW 运行",
  "Tool contract": "工具协议",
  "Codex host": "Codex 宿主",
  "ODW bridge": "ODW 桥接",
  "No linked ODW runs yet.": "暂无关联 ODW 运行。",
  "Ask Codex. Mention ODW or workflow to attach a local run.":
    "向 Codex 提问。提到 ODW 或 workflow 会关联一次本地运行。",
  "Messages are stored by the local backend.": "消息由本地后端保存。",
  "The local backend will store messages and linked runs.": "本地后端会保存消息和关联运行。",
  "No chat sessions yet": "暂无对话会话",
  "No chat sessions yet.": "暂无对话会话。",
  "Create a hosted turn to start.": "新建一个宿主回合开始。",
  "Create a session first.": "请先新建会话。",
  "Choose an existing session or create a new one.": "选择已有会话或新建一个会话。",
  "Chat session not found": "对话会话不存在",
  "Open latest session": "打开最新会话",
  "Loading chat sessions...": "正在加载对话会话...",
  "No messages yet.": "暂无消息。",
  "Waiting for events...": "等待事件...",
  "live data": "实时数据",
  "User message": "用户消息",
  "Host turn": "宿主回合",
  "Tool result": "工具结果",
  "{n} linked runs": "{n} 个关联运行",
  "stored by local server": "已由本地服务保存",
  "watching ODW run": "正在观测 ODW 运行",
  waiting: "等待中",
  available: "可用",
  missing: "缺失",
  "Message text is required.": "请输入消息内容。",
  "Sending...": "发送中...",
  "Creating...": "新建中...",
  Delete: "删除",
  "Delete this chat session?": "确定删除这个对话会话吗？",
  "Run started": "运行已开始",
  "Run finished": "运行已完成",
  "Run failed": "运行失败",
  "Run stopped": "运行已停止",
  "Phase started": "阶段已开始",
  "Agent started": "智能体已开始",
  "Agent finished": "智能体已完成",
  "Agent failed": "智能体失败",
  Log: "日志",
  "run requested": "已请求运行",
  "This local Chat Host session is ready. Mention ODW or workflow to attach a real ODW run to the turn.":
    "本地对话宿主已就绪。提到 ODW 或 workflow 时，会把这个回合关联到真实的 ODW 运行。",
  "I linked this turn to a local ODW run. The tool card will update from the run stream as it settles.":
    "我已把这个回合关联到本地 ODW 运行。工具卡片会随着运行流自动更新。",
  "I recorded this turn in the local Chat Host. Mention ODW or workflow when you want this conversation to attach a run.":
    "我已把这个回合记录到本地对话宿主。需要关联运行时，提到 ODW 或 workflow 即可。",
  "Loading settings...": "正在加载设置...",
  "Current project": "当前项目",
  "Config file": "配置文件",
  "built-in defaults": "内置默认值",
  Send: "发送",
  You: "你",

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
  "no recent signal": "近期无信号",
  "(no message)": "（无消息）",
  adapter: "适配器",
  phase: "阶段",
  live: "实时",
  "Read-only": "只读",
  "This view never re-runs or controls an agent — runs are driven by the CLI.":
    "此视图从不重跑或控制智能体——运行由 CLI 驱动。",
  "last activity {t}": "最后活动 {t}",
  "⚠ worker lost contact": "⚠ worker 失联",
  "⚠ no recent signal": "⚠ 近期无信号",
  "Waiting for the first agent…": "等待第一个智能体…",
  "No agent calls in this run": "本次运行没有调用智能体",
  "This run only recorded phases and a result.": "本次运行只记录了阶段和结果。",
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

  // Run affordances.
  "⏹ Stop": "⏹ 停止",
  "Read-only dashboard": "只读看板",
  "Have your agent start one with the CLI.": "让你的 agent 用 CLI 发起一个运行。",
  "Have your agent write one into the managed directories.": "让你的 agent 写入受管目录。",
  "Runs start from your agent via {cmd}. Claude Code runs stay strictly read-only.":
    "运行由你的 agent 通过 {cmd} 发起。Claude Code 的运行始终严格只读。",
  "Agents are never re-run from here. An ODW run can be stopped from the header; Claude Code runs stay read-only.":
    "这里不会重跑任何 agent。ODW 运行可从顶部停止；Claude Code 运行保持只读。",

  // Redesign (2026-10): shell, palette, toasts, activity, jobs, run views, settings.
  "+{n} more": "还有 {n} 个",
  "A system notification when a run finishes while this tab is in the background.":
    "当本标签页在后台时，运行结束会发送系统通知。",
  "Adapters and paths come from your config. Preferences below only change this dashboard.":
    "适配器与路径来自你的配置；下面的偏好只影响这个看板。",
  All: "全部",
  Appearance: "外观",
  "Bars appear as agents start.": "智能体启动后，这里会出现时间条。",
  "CLIs odw can drive": "odw 可驱动的 CLI",
  Close: "关闭",
  Commands: "命令",
  Copied: "已复制",
  Copy: "复制",
  "Copy a follow command": "复制跟踪命令",
  "Copy failed": "复制失败",
  "Copy id": "复制 ID",
  "Copy run id": "复制运行 ID",
  "Could not stop the run": "无法停止该运行",
  Dark: "深色",
  Done: "已完成",
  "Event density per run": "每个运行的事件密度",
  Events: "事件",
  "Every <em>run</em>, live and past.": "每一次<em>运行</em>，进行中与已完成。",
  "Every run you start draws a line here.": "你发起的每次运行都会在这里画出一条线。",
  Failed: "失败",
  "Filter by name or run id": "按名称或运行 ID 筛选",
  "Filter events": "筛选事件",
  "Filter workflows": "筛选工作流",
  "Fit to screen": "适应屏幕",
  Fleet: "机队",
  Follow: "跟随",
  "Follow in terminal": "在终端跟踪",
  Full: "完整",
  "Go to": "前往",
  History: "历史",
  "How odw <em>reads</em> your machine.": "odw 如何<em>读取</em>你的机器。",
  "In flight": "进行中",
  Light: "浅色",
  "Live animation — or keep it still.": "实时动效，或保持静止。",
  "Loading runs…": "正在加载运行…",
  Motion: "动效",
  New: "新建",
  "New session": "新建会话",
  "No events match.": "没有匹配的事件。",
  "No recent events.": "近期没有事件。",
  "No result recorded": "没有记录结果",
  "No runs match.": "没有匹配的运行。",
  "No runs yet — have your agent start one with odw run.": "还没有运行——让你的 agent 用 odw run 发起一个。",
  "No workflows match.": "没有匹配的工作流。",
  "Nothing is running. {n} runs on record.": "当前没有运行；共记录 {n} 次运行。",
  "Nothing matches.": "没有匹配项。",
  "Nothing on the clock yet": "时间轴上还没有内容",
  "Notify me when runs finish": "运行结束时通知我",
  "One agent is <em>working</em>.": "一个智能体正在<em>工作</em>。",
  Outline: "结构",
  "Paper by day, carbon by night.": "白天如纸，夜晚如墨。",
  Paths: "路径",
  Pulse: "脉搏",
  "Quiet so far": "暂时安静",
  "Reduce motion": "减少动效",
  Reduced: "减少",
  Run: "运行",
  "Run notifications": "运行通知",
  Runs: "运行",
  "Runs are <em>in flight</em>.": "运行正在<em>进行</em>。",
  "Runs start from your agent or terminal — not from here.": "运行由你的 agent 或终端发起——而不是这里。",
  Script: "脚本",
  Search: "搜索",
  "Search runs, workflows and commands…": "搜索运行、工作流与命令…",
  Setup: "准备",
  "Shadowed: odw run {name} runs a higher-precedence workflow.": "已被遮蔽：odw run {name} 会运行优先级更高的同名工作流。",
  "Something <em>broke</em>.": "有东西<em>出错了</em>。",
  Source: "源码",
  Stop: "停止",
  "Stop requested": "已请求停止",
  "Switch to dark theme": "切换到深色主题",
  "Switch to light theme": "切换到浅色主题",
  System: "跟随系统",
  "The clipboard is not available here.": "此环境无法访问剪贴板。",
  "The fleet is <em>at rest</em>.": "机队正在<em>休息</em>。",
  Theme: "主题",
  Timeline: "时间线",
  "Toggle theme": "切换主题",
  "Turn animations on": "开启动效",
  "Turn run notifications off": "关闭运行通知",
  "Zoom in": "放大",
  "Zoom out": "缩小",
  active: "活跃",
  "agents running · by adapter": "运行中的智能体 · 按适配器",
  "attempt {n}": "第 {n} 次尝试",
  attempts: "尝试次数",
  close: "关闭",
  "copy a follow command": "复制跟踪命令",
  "declared — no calls found in this phase": "已声明——此阶段未发现调用",
  "dynamic workflows": "动态工作流",
  elapsed: "耗时",
  "events per run · last {s}": "每个运行的事件 · 最近 {s}",
  finished: "结束",
  navigate: "选择",
  "no signal": "无信号",
  now: "现在",
  open: "打开",
  "read statically from the source": "从源码静态读取",
  "read-only": "只读",
  "run list over server-sent events": "运行列表通过 SSE 实时推送",
  "runs in flight": "进行中的运行",
  unsupported: "不支持",
  "{name} failed": "{name} 失败了",
  "{name} finished": "{name} 已完成",
  "{name} lost its worker": "{name} 的 worker 已失联",
  "{name} stopped": "{name} 已停止",
  "{n} agent": "{n} 个智能体",
  "{n} agents": "{n} 个智能体",
  "{n} agents are <em>working</em>.": "{n} 个智能体正在<em>工作</em>。",
  "{n} linked run": "{n} 个关联运行",
  "{n} live": "{n} 个进行中",
  "{n} phase": "{n} 个阶段",
  "{n} run": "{n} 次运行",
  "{n} runs": "{n} 次运行",
  "{r} runs in flight{via}.": "{r} 个运行进行中{via}。",
  logs: "日志",
  "Show {n} more": "再显示 {n} 条",
  "Show {n} earlier events": "再显示 {n} 条更早的事件",
  "+{n} more agents in this phase": "本阶段还有 {n} 个智能体",
  "{n} older events hidden": "还有 {n} 条更早的事件未显示",
  "Copy a rerun command": "复制重跑命令",
  "Copy a resume command": "复制续跑命令",
  "Resume in terminal": "在终端续跑",
  "copies a command that replays finished agents": "复制一条会重放已完成 agent 的命令",
  Output: "输出",
  command: "命令",
  commands: "命令",
  "exit code": "退出码",
  killed: "被终止",
  "Run hooks": "运行钩子",
  "Get started": "开始使用",
  "three steps to a live graph": "三步看到实时图",
  "Check the setup": "检查环境",
  "Runtime, config and every adapter — plus one real prompt to the default.": "检查运行环境、配置和每个适配器——并给默认适配器发一条真实提示。",
  "Run an example": "跑一个示例",
  "Four drafts in parallel, then a synthesis. Watch it draw here.": "四份草稿并行生成,再汇总。可以在这里看它实时绘制。",
  "Hand it to your agent": "交给你的 agent",
  "With the ODW skill installed, your coding agent writes and runs workflows for you.": "装好 ODW skill 后,你的 coding agent 会替你编写并运行工作流。",
  "Keyboard shortcuts": "快捷键",
  Anywhere: "任意页面",
  or: "或",
  "A run": "运行详情",
  "Open the focused node or row": "打开当前聚焦的节点或行",
  tokens: "token",
  cost: "花费",
  reason: "原因",
  in: "输入",
  out: "输出",
  "rate limit": "限流",
  quota: "额度用尽",
  "login needed": "需要登录",
  "timed out": "超时",
  stalled: "卡住",
  "CLI not found": "找不到 CLI",
  "permission denied": "权限被拒",
  exit: "退出",
  Checkpoint: "检查点",
  "waiting since {t}": "自 {t} 起等待",
  Approve: "批准",
  Reject: "拒绝",
  Approved: "已批准",
  Rejected: "已拒绝",
  "Add a note for the workflow (optional)": "给工作流留一句话(可选)",
  "Resolve it with {cmd}": "用 {cmd} 处理",
  "Could not resolve the checkpoint": "无法处理该检查点",
  "Command hook": "命令钩子",
  Webhook: "Webhook",
  "runs on {on}": "触发于 {on}",
  on: "开",
  "No hooks configured. Add a notify block to odw.config.json to run a command or post to a webhook when a run finishes.":
    "尚未配置钩子。在 odw.config.json 中加入 notify 配置,即可在运行结束时执行命令或推送到 webhook。",
  replayed: "重放",
  "replayed from an earlier run": "从之前的运行重放",
  "{n} older runs": "还有 {n} 条更早的运行",
  "lifted at {t}": "已于 {t} 解除",
  "lifts in {d} · {t}": "{d} 后解除 · {t}",
  // checkpoint() gates in the graph and drawer.
  "waiting for a person": "等待人工决定",
  approved: "已批准",
  rejected: "已拒绝",
  "not answered": "未获答复",
  Answer: "答复",
  Payload: "附带内容",
  checkpoint: "检查点",
  asked: "提出于",
  waited: "等待时长",
  dashboard: "看板",
  cli: "命令行",
  timeout: "超时",
  "Waiting — answer it in the card above the tabs, or with {cmd}": "等待中——在标签页上方的卡片里答复,或运行 {cmd}",
  // Activity — what needs a person.
  "Needs you": "待你处理",
  "decisions and runs to pick up": "等你决定的检查点,和可以接着跑的运行",
  "asks: {q}": "在问:{q}",
  "is waiting for your decision": "正在等你的决定",
  "lost its worker": "失去了 worker",
  "failed · {n} of {m} agents failed": "失败 · {m} 个 agent 中 {n} 个失败",
  "Copy resume": "复制 resume 命令",
  "+{n} more failed in the last day": "过去一天还有 {n} 个失败的运行",
  Review: "审阅",
  // Changes — worktree agents' diffs.
  Changes: "改动",
  Agent: "Agent",
  "lines changed": "改动行",
  "{n} file": "{n} 个文件",
  "{n} files": "{n} 个文件",
  "+{n} more files": "另有 {n} 个文件",
  "Copy apply command": "复制应用命令",
  "copies odw apply for this agent": "复制该 agent 的 odw apply 命令",
  "applies this diff to your working tree": "把这份 diff 应用到你的工作区",
  "copy a checkout command": "复制切换分支的命令",
  "The stored diff was cut at the size cap.": "保存的 diff 超出大小上限,已被截断。",
  "Review changes": "审阅改动",
  "No changes recorded": "没有记录到改动",
  'Agents that run with isolation: "worktree" keep a diff of what they changed, to review here and apply with odw apply. Agents that work in place edit your files directly — review those with git diff.':
    '以 isolation: "worktree" 运行的 agent 会保存它们改动的 diff,可以在这里审阅,并用 odw apply 应用。原地工作的 agent 直接修改你的文件——请用 git diff 审阅。',
  truncated: "已截断",
  "Agents with changes": "有改动的 agent",
  "agent changed files": "个 agent 改动了文件",
  "agents changed files": "个 agent 改动了文件",
  "This agent's diff is not available.": "该 agent 的 diff 不可用。",
  "Next / previous agent with changes": "下一个 / 上一个有改动的 agent",
  modified: "修改",
  added: "新增",
  deleted: "删除",
  renamed: "重命名",
  copied: "复制",
  from: "原为",
  binary: "二进制",
  "Binary file — not shown.": "二进制文件——不显示。",
  "Renamed without changes.": "仅重命名,内容未变。",
  "Only the file mode changed.": "只改了文件权限位。",
  "No line changes.": "没有行级改动。",
  "{n} more lines in this file are not shown.": "该文件还有 {n} 行未显示。",
  "{n} more files are not drawn here — the full diff: {cmd}": "还有 {n} 个文件未在此绘制——完整 diff:{cmd}",
};
