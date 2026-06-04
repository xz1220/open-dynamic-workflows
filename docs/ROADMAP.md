# Open Dynamic Workflows — 分阶段路线图 (v0.3 → v1.0)

> 来源：多视角路线图设计工作流（survey 真实代码 → 4 视角设计 → 评审 → 综合 → 完整性批判 → 定稿）\n> 日期：2026-06-05 ｜ 评审夺冠主线：adoption-flywheel(8.4)，嫁接 runtime/product/moat 三视角最佳点\n\n
> 综合自评审夺冠的 **adoption-flywheel** 主线（飞轮排序），嫁接 runtime-completeness 的"沉默 no-op 即信任失效"与 BudgetExhausted/journaling 机制、product-client 的"加性拓扑契约 + 先 Web 后原生的 dogfood 闸门"、moat-and-focus 的"单一 `resolveWorkflow` 三处复用 + 作者命名空间 + meta 即标准规范"。所有论断均区分**已有(已落地)**与**待建**，并以真实代码路径为锚。

---

## 1. 一句话战略主线

> **先把"运行机制 + 原语"打磨成一份冻结的、机器可读的契约,再用这份契约依次喂养飞轮的每一环(发现 → 安装 → 理解 → 贡献 → 看见)——最后才在已被验证的契约之上构建客户端;护城河是"可移植工作流的网络 + Claude Code 方言的忠实标准",而非任何一行可被克隆的 UI。**

这条主线直接回应 "MVP 后迷茫":运行时已成熟(原语 6/10、打包 8/10),迷茫的根源是**飞轮的引擎最弱**(模板 3/10、分发 2/10、客户端 3/10)。不要再去抛光已经够强的运行时,而是按依赖顺序拆掉飞轮每一环的摩擦——其中**最便宜、最承重的那一环(机器可读 `meta`)必须最先做,因为后面所有东西都读它**。

---

## 2. 分阶段路线图(5 个 horizon)

| Horizon | 目标(一句话) | 关键交付物 | 完成标准(DoD) | 归属 |
|---|---|---|---|---|
| **v0.3 — 让契约成形 (Now,2-4 周)** | 把隐式、仅存于代码的作者面,变成显式、机器可读、可校验的契约;同时把"沉默丢弃选项"变成可观测失败,并把所有下游分发字段一次性补齐 | ① `WorkflowMeta` 加 `args[]/tags[]/author/license/repository/version`(均纯字面量、加性;`version` = 可选 semver 字符串);② `odw list-templates` / `odw describe <name>`;③ 参数解析失败时打印 meta 驱动的 Quick-Run;④ **新建** dual-compat 静态审计工具 + `tests/fixtures/dual-compat/`(known-good / known-bad meta 各若干),接入 CI;⑤ "无原语沉默丢弃"不变量:`model/agentType/isolation` 被接受但未生效时发 `LOG` 事件;⑥ **响亮文档化** `agentType` 歧义的弃用路径(doc-only,提前到此,因 v0.4 库即开始填充);⑦ **SKILL.md 复核**:逐项核对其每个组合模式都有 8 个 example 之一对应、每个原语签名为现行、并落地"v1 稳定 vs v1.5 保留"表 | `odw describe deep-research` 不执行脚本即列出 args/phases/version/Quick-Run;脚本读了未声明的 arg → 测试失败;dual-compat 审计用"meta 字面量 extract-and-eval 的值 deep-equal 于同一 span 的 `JSON.parse` 结果"为 oracle,CI 拦截不满足者,fixtures 全部如期判定;**8 个种子均带合法 `author`(`org/handle` 形)+ `repository`(可解析 URL)+ `version`**(否则 v0.4 命名空间/lockfile 无输入);任何被忽略的 agent opt 产生可见 LOG;SKILL.md 复核记录每个模式↔example 的映射,无悬空声明 | 第一部分 |
| **v0.4 — 单向门:安装 + 上传 + Awesome-DW Hub (Next,4-8 周)** | 让一个人写的工作流能一条命令到达第二个人,且第二个作者能即刻贡献——飞轮能转的结构前提(install 与 upload 同期到位) | ① `odw install <author/name\|url>`(sha256 校验、`.installed.json` lockfile = source/version/hash,version 取自 meta.version,缺失则取 index 条目)+ `odw uninstall`/`odw upgrade`(`upgrade` 比对 lockfile.version 与 index/源中的 meta.version,**作者命名空间从第一天就有**);② **`odw publish`(上传原语,与 install 同期)**:校验纯字面量 meta + 声明 args + version 存在 + 算 sha256,产出 index 片段 + PR/自动发布指引;③ Awesome-DW GitHub 仓库 + `workflows.json`(从 meta **自动生成**,非手维护)+ 8 个种子模板;④ `odw workflows info <name>` 显示来源/版本/hash;⑤ **名字↔日志全链路**:`workflowName` 写入 `status.json` **创建时**(`CreateRunInput`+`launcher`),`odw list --workflow <name>` 反查、`odw logs --workflow <name>` 读最近一条该名 run 的日志,`odw list` 默认输出已含 name(cli.ts:268,验证保留) | `odw install acme/deep-research` 校验 hash→落地→立即可 run;`odw publish ./x.js` 对缺 version/非纯字面量 meta 报错,合法则产出可被 hub 生成器消费的 index 片段;`odw upgrade` 在 index.version 高于 lockfile.version 时拉新并改写 lockfile;`odw list --workflow deep-research` 与 `odw logs --workflow deep-research` 均不扫描全部 meta.json;hub 生成器对 8 个种子产出的 `workflows.json` 与种子 meta 字段(author/version/args/tags)逐项一致(联合测试);index 可从 .js 重生成 | 第一部分 |
| **v0.5 — 闭环回流:贡献脚手架 + 开发者参考 + CLI 降门槛 (Next,8-12 周)** | 把"用户"变"贡献者",让飞轮自我喂养;让"跑在任意 agent CLI"从口号变成有文档的路径;并为不装 .app 的 CLI / Linux / Windows 用户降低门槛 | ① `odw new <pattern> --name`、`odw init --project` 脚手架;② `skill/references/authoring.md`(loader 变换、注入面、v1-稳定 vs v1.5-保留、确定性规则);③ adapters.md 扩展:自定义适配器 checklist + foo-agent 全流程 + 故障排查矩阵;④ **CLI 降门槛(跨平台,不依赖 .app)**:交互式 `odw run <name>` 在缺必填 `meta.args` 时逐项提示、`odw run <name>` 短名直跑、`helpText()` 补出已被解析但未列出的 `--wait/--timeout/--budget`(cli.ts:171,180);⑤ **`odw run --wait` 终态退出码保证**:`--wait` 在 `failed`/`stopped` 终态返回非零(复用 reportTerminal cli.ts:439-451;非 `--wait` 仍在 spawn 即返回 0);⑥ OS-cron 配方(无新调度模块),**强制使用 `--wait`** | `odw new fan-out-reduce --name x` 产出可跑脚手架;开发者照 checklist 不读 builtin.ts 即可接新 CLI;`odw run deep-research`(无 `--args`)对缺失必填 arg 交互式补全后成功跑;`helpText()` 列出 `--timeout/--budget`;`odw run --wait` 对失败/停止 run 返回非零退出码(测试覆盖);cron 配方在 macOS/Linux 用 `--wait` 调度命名工作流,成功 exit 0、失败/停止 exit 非零,且 ODW 未加任何调度代码 | 第一部分 |
| **v0.6 — 稳定本地 API + 真 DAG 渲染 (Later,3-5 月)** | 飞轮已转后,投资"转化倍增器"(让 skeptic 信服的可视化)与每个未来客户端都依赖的契约 | ① **加性拓扑事件**:`agent`/`parallel`/`pipeline` 在 `AGENT_STARTED` 上发可选 `groupId/kind/index`,`RunDetail` 派生 `groups` 树(向后兼容,旧 events.jsonl 仍可折叠);**v0.6 拓扑 + DAG 限定单层 `parallel`/`pipeline`;嵌套组(parallel-in-pipeline 等)渲染明确延后至 v0.7(见 §4b)**;② `ODW_API_VERSION` + 全 `/api/*` 的 JSON Schema + 加性-only 政策;③ `GET /api/workflows` 运行前预测拓扑(**解析 v0.3 的 `meta.args/phases`** 推断声明的阶段/agent 数);④ 用真实 graph 引擎(Cytoscape/D3 级)替换 `dashboard.html`,经 `scripts/embed-dashboard.mjs` **产出唯一一份 bundle 工件,内嵌二进制与 standalone 两宿主皆消费它**;⑤ `odw run --export` 只读 run-link(社会证明,复用 run-store JSONL,无云依赖) | **单层** `parallel(N)`/`pipeline` 事件流能重建正确 groups(新测试),嵌套用例不在 v0.6 范围;129+ 测试全绿且旧事件 fixture 仍折叠;`/api/workflows` 不执行即从 meta 返回拓扑;dashboard 渲染带真实 edge 的活 DAG;CI 断言两宿主加载同一 `embed-dashboard.mjs` 工件(hash 一致),保证"零渲染代码分叉"可验证;一次 run 可导出并在另一机器只读重开 | 两部分 |
| **v0.7 — 嵌套组合渲染 (Later,可与 v1.0 并行,DAG 闸门通过后)** | 补齐 §4b 诚实风险:多层嵌套的 DAG 故事 | ① 嵌套组渲染为**可折叠子图**(parallel-in-pipeline / pipeline-in-parallel),不降级回 lane;② 拓扑事件的嵌套分组模型(`groupId` 父子关系) | 一个含 parallel 嵌套于 pipeline 的工作流渲染成可展开/折叠的子图(新测试),折叠态显示组摘要、展开态显示成员节点;旧单层 fixture 仍正确 | 第二部分 |
| **v1.0 — 原生 macOS 客户端 (Later,5-8 月,经 dogfood 硬闸门)** | 在已验证的契约 + 真 DAG + 充实模板库之上,为非技术用户降低门槛 | ① Tauri/SwiftUI 客户端(显式避开 Electron 双 Node 税)消费 v0.6 版本化 API:run 列表、活 DAG、pause/resume/stop、完成原生通知、Dock 常驻多 run 监视;② Hub 模板画廊 + 由 `meta.args` 生成的表单(免手写 JSON);③ 首启 onboarding(装二进制+skill→hello-world→适配器引导);④ WebSocket/重连 + 离线缓存,**与 Web 共用 v0.6 的同一 bundle 工件**;⑤ 安装前 review 步(展示源码 + phases/adapters + sha256) | 零终端经验用户能装→浏览画廊→装模板→填表单→跑→看活 DAG,全程不碰 CLI/JSON;**CI 断言原生外壳与浏览器加载 v0.6 同一 `embed-dashboard.mjs`(同 hash),零渲染代码分叉可验证**;完成 run 触发原生通知;首启以 hello-world 成功收尾 | 第二部分 |

### 依赖与排序(为什么是这个顺序)

```
v0.3 meta.args/version + author/repository + 拓扑契约前置   ← 一切下游都读它
  │   ├─→ hub index (v0.4, 从 meta 生成)
  │   ├─→ /api/workflows 运行前拓扑 (v0.6, 解析 meta.args/phases)   ← 此依赖此前未画出,现显式标注
  │   └─→ 客户端运行表单 (v1.0, 从 meta.args 生成)
  │   + agentType 弃用文档(v0.3 doc-only)必须先于 v0.4 库填充
  │
  ├─→ v0.4 install + publish + hub (单向门;install 与 upload 同期)
  │      └─ workflowName@创建 + list/logs --workflow 反查    ← "名字即身份"
  │
  ├─→ v0.5 new + 开发者参考 + CLI 降门槛 + --wait 退出码 → cron 依赖它
  │
  └─→ v0.6 版本化 API + 真 DAG(单层)+ 唯一 bundle 工件
         │   ↑ 先 Web 验证 DAG UX(dogfood 硬闸门,见下)
         ├─→ v0.7 嵌套组可折叠子图(补 §4b)
         └─→ v1.0 原生客户端(薄消费者,消费同一 bundle 工件)
```

**显式硬闸门(嫁接 product-client,带可证伪协议)**:v1.0 原生客户端的进入条件是 v0.6 Web DAG 的 dogfood 裁决。**协议**:固定任务 = "在一个含失败 agent 的真实 run 里,定位是哪个 agent 失败及其错误原因";对照 = v0.6 DAG vs 当前 phase-lane 看板;指标 = 完成时间 + 错误率;评判 = **≥3 名非作者用户**(作者自评不算闸门);通过条 = DAG 组在时间或错误率上明显优于看板。裁决为负则 v1.0 推迟,降级为设计评审。这把最贵的赌注变成可推迟的选项,而非承诺。

**关键纠偏**:`workflowName` 在 worker.ts:74 **已**写入 status.json(运行时),真正的 gap 是**创建时机 + 反查/读日志索引**——v0.4 据此精确缩小为 `CreateRunInput` 加字段 + `launcher` 在 `store.create()` 传脚本 stem + `list/logs --workflow` 查询面,而非"从无到有持久化";`odw list` 默认输出已含 name(cli.ts:268)。

---

## 3. 第一部分详解 — 核心能力与命令行工具(CLI)

### a. 原语完备性 (primitives & loader)

- **现状(已有)**:`agent/parallel/pipeline/phase/log/args` 全实现并测试(129 通过);schema 校验+重试管线完整;loader 源变换正确;scheduler 信号量并发、`scheduler.ts:49` 的 `await checkpoint()` 后接 `dispatchedCount >= maxAgents` 的 1000-agent 兜底(scheduler.ts:52)。**三处方言级 no-op 仍在**:`agent.model`(placeholders.ts 仅 6 token 无 `model`)、`agentType`(primitives.ts:66 是 `opts.adapter ?? opts.agentType` 的适配器名 fallback,语义含混)、`isolation:'worktree'`(走 copy fallback);`budget.spent()` 是 `() => 0` 桩(primitives.ts:115);`workflow()` 抛 `notImplemented`(primitives.ts:119-120)。
- **目标形态**:每一个被方言承诺的原语要么忠实生效、要么响亮失败——**绝不沉默丢弃**。
- **关键交付物**:
  - v0.3:**"无沉默丢弃"不变量**(`model/agentType/isolation` 未生效发 `LOG`)+ `agentType` 弃用**文档**。
  - v0.5:**`spent>=total` 硬上限钩子**——在 `scheduler.ts:49` 的 checkpoint 后、1000-agent 兜底之前,若 `budget.total != null && spent() >= total` 则抛 `BudgetExhausted`。即便 `spent()` 仍是桩(恒 0,故对现有行为零影响),钩子先就位,使下方 `workflow()` 里程碑可被它门控。
  - **v1.5+(择机,且被硬门控)**:`agentType` 升级为 config 中 role→adapter+model 映射(带兼容 shim);`isolation:'worktree'` 真 git-worktree;`workflow(nameOrRef)` 经**同一个** `resolveWorkflow`(resolve.ts:14-16 文档已明示)实现,共享父级 scheduler + budget,带深度上限/环检测。**门控条件(硬性):嵌套 `workflow()` 不得在 `spent>=total` 硬上限(v0.5)落地前合并**——因为嵌套放大 fan-out,是成本爆炸面。
- **完成标准**:任何被接受却未兑现的 opt 都产生可见 LOG(测试覆盖);`spent>=total` 钩子在 checkpoint 处有单测(用非桩 budget mock 验证抛 `BudgetExhausted`);拓扑事件加性、旧 events.jsonl 仍折叠、129+ 测试全绿。

### b. Agent 集成 (adapters + skill + references)

- **现状(已有)**:5 个内置适配器(claude/codex/gemini/qwen/kimi);干净 adapter 接口 + 6 placeholder + config merge;bridge 组装 prompt→隔离 workspace→schema 重试;错误分级。**缺**:无"接新 CLI"全流程指南、无故障排查、无 `authoring.md`;且 **`skill/SKILL.md` 自身未经核对**——其组合模式声明是否仍与 8 个 example 对齐、原语签名是否现行、"v1 稳定 vs v1.5 保留"是否落地,均未审。
- **目标形态**:"跑在任意 agent CLI"是有文档、可照着做、可对抗两个克隆的差异化路径;且 SKILL.md 不含与已发布面脱节的旧声明。
- **关键交付物**:
  - **v0.3(doc-only,SKILL.md 复核)**:逐项核对 SKILL.md 每个组合模式↔8 个 example 的对应、每个原语签名为现行;落地"v1 稳定 vs v1.5 保留"表(含 agentType 警示);响亮写明 `agentType` 弃用路径。
  - **v0.5(开发者参考)**:`authoring.md`(loader 变换、注入面、确定性规则);adapters.md 加自定义适配器 checklist + foo-agent worked example + 故障排查矩阵(timeout / 非零退出 / 127 缺可执行 / schema 下畸形 JSON);placeholder 必选 vs 可选语义。
- **完成标准**:SKILL.md 复核产出"模式↔example"映射表,无悬空声明,签名与 `workflow.d.ts` 一致;第三方开发者照 checklist + 例子接入全新 CLI,无需阅读 builtin.ts。

### c. 模板系统 (template/example library)

- **现状(已有)**:8 个 example,1:1 覆盖 6 个 Anthropic 模式 + agent-daily-digest;每个 export 纯字面量 `meta`;args 都解析(但埋在 `Number()/trim()` 里,无机器可读声明,且无 author/version)。**缺**:无 `meta.args` 机器可读契约、无脚手架、无分类/标签、无 `list-templates`/`describe`。
- **目标形态**:模板自描述、可发现、参数失败即给 Quick-Run。这是飞轮**最便宜最高杠杆**的一环,解锁 hub index、`/api/workflows`、客户端表单全部下游。
- **关键交付物(v0.3)**:`WorkflowMeta.args = [{name,type,required,default,description}]` + `tags` + `author/license/repository/version`;8 个 example 全部回填(**按真实签名**:tournament=`{task,approaches?}`、generate-and-filter=`{topic,generators?,rubric?,threshold?,keep?}`——评审已纠正夺冠提案误抄 survey 的混淆),并为每个种子填入合法 `author`(`org/handle`)/`repository`/`version`;`odw list-templates`/`odw describe`;参数失败的 Quick-Run。
- **完成标准**:`odw list-templates` 列全 8 个;`odw describe deep-research` 打印 args/phases/version/可粘贴运行行;读了未声明 arg 的脚本使测试失败;**8 个种子的 author/repository/version 通过一项校验测试**(为 v0.4 命名空间/lockfile 提供真实输入);新用户从 list-templates 到成功 run 不开任何 .js。

### d. 运行机制 (parse/execute, run records, scheduling)

- **现状(已有)**:loader 源变换 + detached node worker(launcher.ts spawn+unref,**fire-and-forget,spawn 即 exit 0**)+ 文件化 run 目录(原子写);run-id 时间戳排序;JSONL 事件 9 类;`resolveWorkflow` 命名解析。**缺/纠偏**:`workflowName` worker.ts:74 **已**写但**创建时未写、无反查/读日志索引**;**零调度基础设施**(走 OS cron);无 retention/cleanup;无 resume/journaling;`budget` 不强制;`--wait` 的终态退出码已在 reportTerminal(cli.ts:439-451)映射,但非 `--wait` 路径在 spawn 即返回 0(cli.ts:196)。
- **目标形态**:run 可按名反查与读日志、可被 OS cron 触发并获得有意义退出码、目录不无限膨胀;长 run 可中断恢复(护城河级,见 §5)。
- **关键交付物**:
  - **v0.4**:`workflowName` 写入 `CreateRunInput`(创建时)+ `odw list --workflow` + `odw logs --workflow <name>`(读该名最近一条 run 日志);`odw list` 默认输出已含 name(保留)。
  - **v0.5**:`odw run --wait` 终态非零退出码保证(复用 reportTerminal);OS-cron 配方(文档 + shell 模板,**无新调度模块,模板强制 `--wait`**)。
  - **(择机)**:`odw cleanup` 按龄清理、saga 式 `odw resume`(内容寻址 journal、仅 memoize 结构化结果、workspace 变更步骤不可 resume)、dead-pid 标记 `interrupted`。
- **完成标准**:`odw list --workflow deep-research` 与 `odw logs --workflow deep-research` 均不扫全部 meta.json;`odw run --wait` 对 `failed`/`stopped` 返回非零(测试覆盖);cron 配方在 macOS/Linux 用 `--wait` 调度命名工作流,成功 exit 0 / 失败或停止 exit 非零(此即"有意义退出码"的定义),且 ODW 未加任何调度代码。

### e. 分发与下载 (install/upload + Awesome hub)

- **现状(已有)**:项目级 `.odw/workflows` + 全局 `~/.odw/workflows` 管理目录 + 命名解析 + shadowing;SEA 单文件二进制 + install.sh;npm 发布为 `odw`;零运行时依赖。**缺**:无 install/publish/uninstall/upgrade、无 registry index、无版本/lockfile、无校验和、无中央 hub、扁平命名空间易冲突。**这是 maturity 2/10 的最低点,也是护城河,故必须领先。**
- **目标形态**:Awesome-DW 成为 Claude Code 方言可移植工作流的事实中心;安装可校验、可追溯、可复现;**第二位作者从 hub 上线第一天即可贡献(install 与 upload 同期)**。
- **关键交付物(v0.4,install + upload 同期)**:
  - **install/uninstall/upgrade**:`.installed.json` lockfile = source/version/hash;**version 来源 = meta.version(v0.3 已加),缺失则回退 index 条目的 version**;`upgrade` 比对 lockfile.version 与源/index 的 meta.version,更高则拉新并改写 lockfile。
  - **`odw publish`(上传原语,与 install 同期,不再推迟到 v0.5)**:校验纯字面量 meta + 声明 args + version 存在 + 算 sha256,产出可被 hub 生成器消费的 index 片段 + 发布指引(PR 路径 + 预留 user-namespaced 自动发布)。
  - Awesome-DW 仓库 + `workflows.json`(从 meta **自动生成**)+ 8 个种子;**作者命名空间 `author/name` 从第一天就有**(成功的开放网络会冲垮扁平命名空间,事后改造昂贵);sha256 强制校验失败即拒;`odw workflows info` 显示来源/版本/hash;安全说明文档。
- **完成标准**:`odw install acme/deep-research` 校验 hash→落地→立即可 run;篡改文件被拒;`odw publish ./x.js` 对缺 version / 非纯字面量 meta 报错,合法则产出与 hub 生成器对齐的 index 片段;**hub 生成器对 8 个种子产出的 `workflows.json` 与种子 meta(author/version/args/tags)逐项一致(联合验证测试)**;两个 hub 发同名工作流因命名空间不冲突;`odw upgrade` 在 index.version 高于 lockfile.version 时正确拉新;index 可从 .js 重生成;install/uninstall/publish/hash-mismatch 路径有测试。

---

## 4. 第二部分详解 — 客户端与可视化展示

### a. macOS 客户端

- **现状**:无原生客户端;一切 UI 锁在浏览器;无 Dock/通知/原生文件选择/常驻监视。
- **技术选型建议**:
  - **选 Tauri**(优于 Electron 与 SwiftUI):Electron 双 Node 税;SwiftUI 与 Web 渲染器分叉、DAG 画两遍。Tauri **逐字复用 v0.6 的唯一 bundle 工件**,只加原生外壳——一份 DAG 渲染器、两个宿主。
  - **可验证的"零分叉"不变量**:v0.6 的 `scripts/embed-dashboard.mjs` 产出**唯一一份** bundle 工件,内嵌二进制与原生外壳皆消费它;**CI 断言两宿主加载同一工件(同 hash)**——"零渲染代码分叉"由此成为构建级不变量,而非口号。
  - **Rust 表面要薄且隔离**:Rust 只存在于客户端仓库/构建,**运行时永远纯 Node、零依赖**;webview 与未改动的 localhost server 对话。
  - **需运行时暴露的稳定接口契约(v0.6 先行)**:`ODW_API_VERSION`;全 `/api/*` JSON Schema;加性-only 字段政策;WebSocket upgrade + 重连退避;客户端 pin 已知版本。
- **关键交付物(v1.0)**:run 列表、活 DAG、pause/resume/stop(走已有 `POST /api/runs/:id/control`)、完成原生通知、Dock 常驻多 run 监视、签名公证 .app(Developer ID + notarization)。
- **完成标准**:.app 启动即 spawn `odw serve` 并显示 DAG;**CI 证明原生与浏览器加载同一 bundle 工件(同 hash)**;完成 run 触发原生通知;Dock badge 反映活跃 run 数;运行时 package.json 仍零运行时依赖。

### b. 前端可视化

- **现状**:`dashboard.html` 单文件 vanilla JS,phase-as-lane 看板,SSE + 2s 轮询兜底;`docs/odw-dashboard-prototype.html` 是静态手写 mockup(非数据驱动)。
- **技术选型建议**:TypeScript SPA(Svelte 或 React)+ 自动布局 graph 引擎(Cytoscape/D3 级)消费 `RunDetail.groups`;构建期依赖,镜像现有 esbuild/postject 模式,**不给引擎加运行时依赖**;经 `scripts/embed-dashboard.mjs` 产出**唯一 bundle 工件**,内嵌二进制 + standalone 两宿主皆消费它。
- **嵌套渲染的诚实风险与其专属排期(嫁接 product-client 评审弱点)**:`parallel` 可嵌在 `pipeline` 内,swimlane+fan-out 隐喻对**组合嵌套**可能不可读。**v0.6 的 `groupId/kind/index` 与 DAG 限定单层**,嵌套渲染**不在 v0.6 范围**;多层嵌套作为**独立交付排入 v0.7**,渲染为**可折叠子图**,绝不降级回 lane(lane 正是克隆已有的东西)。
- **关键交付物**:
  - **v0.6**:数据驱动 DAG(phase 泳道、**单层** parallel fan-out、**单层** pipeline 链、节点按状态变色);活执行追踪(SSE `/api/stream` + `?since=` 增量);run 历史(由 v0.4 `workflowName` 驱动);节点详情面板;运行前拓扑预览(`GET /api/workflows`,**解析 v0.3 的 meta.args/phases**)。
  - **v0.7**:嵌套组的可折叠子图渲染 + 嵌套分组模型。
- **完成标准**:
  - **v0.6**:`odw serve` 把 deep-research.js 渲染成活 DAG(5 phase 泳道、4-angle fan-out 为可见**单层** parallel 组、节点实时落定);断 SSE 重连显示缓存 + stale badge 再经 `?since=` 追平;dogfood 裁决按 §2 协议(≥3 非作者用户、固定"定位失败 agent"任务、时间/错误率指标)记录,作为 v1.0 闸门。
  - **v0.7**:一个 parallel 嵌套于 pipeline 的工作流渲染成可展开/折叠子图(新测试),折叠态显示组摘要、展开态显示成员。

### c. 用户体验

- **现状**:二进制需手动 PATH 或 npm;110MB 下载对一次性实验不便;无 quick-start;每次 run 都要 CLI + `--args` JSON;`helpText()` 未列出已被解析的 `--timeout/--budget`。
- **关键交付物**:
  - **v0.3**:参数失败的 meta 驱动 Quick-Run(从崩溃变成可读用法)。
  - **v0.5(跨平台 / CLI-first 降门槛,不依赖 .app)**:`odw init`/`odw init --project` 脚手架;**交互式 `odw run <name>` 在缺必填 `meta.args` 时逐项提示**;`odw run <name>` 短名直跑;`helpText()` 补出 `--wait/--timeout/--budget`。这一组直接服务 Linux/Windows 与永不装 .app 的 CLI 用户,使"降门槛"不再仅绑定 macOS。
  - **v1.0(GUI 降门槛)**:Hub 模板画廊 + `meta.args` 生成的运行表单(免手写 JSON);首启 onboarding(装二进制+skill→hello-world→适配器引导 picker);**安装前 review 步**——展示源码 + phases/adapters(来自 `/api/workflows`)+ sha256。
- **诚实标注(嫁接评审)**:面向"永远不写 JS"的用户,source-preview 接近安全剧场。它是当前阶段**唯一**的安全闸门,真正的供应链防护(签名、来源验证、分支保护)是 §5 中明确推迟的硬化项,在 hub 广泛推广前必须补上。
- **完成标准**:
  - v0.5:`odw run deep-research`(无 `--args`)对缺必填 arg 交互式补全后成功跑;`odw -h` 列出 `--timeout/--budget`。
  - v1.0:零终端经验用户能从 .app 装 deep-research→看源码/phases→填表单→点 run→看活 DAG,全程无 `--args` JSON、无 CLI;缺必填 arg 在 UI 层被拦,而非运行时崩溃。

---

## 5. 护城河与取舍(两个克隆的压力下)

**真护城河(克隆无法 fork 的资产)**:
1. **可移植工作流的网络** — Awesome-DW hub 中每个发布的、可移植的、sha256 校验的工作流,都让 ODW 更值钱,且是克隆无法 fork 的内容引力。
2. **Claude Code 方言的事实标准地位** — `export const meta` + 注入 `agent/parallel/...` 在 Claude Code 本体上 **AND** 经 odw 在 Codex/Gemini/Qwen/Kimi 上**原样运行**;loader 正为此而建,且有与 Claude Code Workflow 工具的硬 dual-compat 约束。
3. **二阶导:`workflow(nameOrRef)` 嵌套组合** — 经**同一个** `resolveWorkflow`(install / run-by-name / 嵌套三处复用,resolve.ts:14-16)实现后,已安装工作流成为可组合积木。这是克隆最难复制的,因为它同时需要 hub + 共享 resolver + 方言保真。

**护城河的两点诚实补强(嫁接 moat 提案评审弱点)**:
- **客户端不是护城河**,是获客楔子。一个 Tauri 外壳套在公开的 localhost 契约上,和原语一样可抄。故客户端**永不在防御性的关键路径上**,排在护城河资产之后。
- **作者命名空间不是 follow-up,是 registry 的地基**:护城河的成功场景(多源开放网络)恰恰会冲垮扁平命名空间,故 `author/name` 从 v0.4 第一天就进 meta + lockfile。

**刻意推迟 / 不建(避免烧掉领先,深化已商品化的单机运行时)**:
- **不建自研调度器** — 走 OS cron(你的明确约束):文档 + 薄 wrapper/skill(强制 `--wait`),无 daemon、无新模块。
- **真 token 计量延后** — `budget.spent()` 暂留桩。但**保留 1000-agent 兜底**作为通用成本下限。**关键:`spent>=total` 硬上限钩子在 v0.5 即植入 scheduler.ts:49 的 checkpoint 后**(桩状态下恒不触发,行为零变化),其存在目的是**门控嵌套 `workflow()`**:§3a 已硬性规定嵌套不得在该硬上限落地前合并——因为嵌套放大 fan-out,是成本爆炸面。这把"§5 点名的隐患"从一句警告变成一个有触发器、有交付物、有门控的具体安排。
- **Date/Math.random replay 沙箱:不建** — survey 列为"UX gotcha"而非需求;直接放弃(可在 resume 的 journal 之上择机做严格 opt-in seed 版,不作里程碑)。
- **领域模板广度:交给 hub 贡献者** — 不做第一方 per-domain 模板膨胀。

**冷启动风险**:Awesome-DW 空仓无引力。缓解:v0.4 用 8 个种子让 hub 非空上线,**且 `odw publish` 与 install 同期到位**,使 curator→contributor 交接即时、第二位作者无需手 PR;`odw publish` 走"人审 PR"在成功时会成为瓶颈,故 v0.4 起即预留 user-namespaced 自动发布的路径(配合作者命名空间)。

---

## 6. 建议的下一步(本迭代立即开始的 2-3 件事)

**全部落在 v0.3,因为它是飞轮最便宜、最承重、解锁全部下游的一环,且零新资产:**

1. **扩展 `WorkflowMeta`(loader.ts:35)加 `args[]` + `tags` + `author/license/repository/version`(纯字面量、加性),回填 8 个 example。**
   - 这是单一最佳的 keystone 抽象:一处小改解锁 `list-templates`、`describe`、参数失败 Quick-Run、hub index、`/api/workflows`、客户端表单——全部下游消费者。
   - **务必按真实签名回填**(tournament=`{task,approaches?}`,generate-and-filter=`{topic,...}`),为每个种子填**合法 author/repository/version**(否则 v0.4 命名空间与 lockfile 无输入),并加测试:脚本读了未声明 arg 即失败。

2. **新建 dual-compat 静态审计工具 + fixtures,接入 CI。**
   - 仓库中**当前不存在**此审计(仅 SKILL.md 一句话 + memory 笔记),它必须**被构建**。**Oracle 明确**:meta 字面量 extract-and-eval 出的值必须 deep-equal 于同一 span 的 `JSON.parse` 结果;`tests/fixtures/dual-compat/` 放 known-good / known-bad 各若干,CI 据此判定。这是 §1 主线"方言保真即护城河"的释放闸门。

3. **落地"无原语沉默丢弃选项"不变量 + `agentType` 弃用文档(doc-only,与不变量同期)。**
   - `model/agentType/isolation:'worktree'` 被接受但未生效时发可观测 `LOG`(primitives.ts);**`agentType` 弃用文档提前到 v0.3**——因 v0.4 库即开始填充,弃用声明必须先于库增长(此前误排在 v0.5,迟于 hub 一个 horizon)。这把信任 gap 变成用户和测试都看得见的东西,且极便宜。

---

**关键文件锚点(供实现):** `/Users/danielxing/repos/open-dynamic-workflows/src/loader.ts`(WorkflowMeta:35,无 version 待加;assertMeta)、`/Users/danielxing/repos/open-dynamic-workflows/src/primitives.ts`(agentType fallback:66, spent 桩:115, workflow 抛错:119-120)、`/Users/danielxing/repos/open-dynamic-workflows/src/scheduler.ts`(checkpoint:49 + 1000-agent 兜底:52,spent>=total 钩子落点)、`/Users/danielxing/repos/open-dynamic-workflows/src/runtime/run-store.ts`(CreateRunInput:45)、`/Users/danielxing/repos/open-dynamic-workflows/src/runtime/worker.ts`(name 写入:74)、`/Users/danielxing/repos/open-dynamic-workflows/src/runtime/launcher.ts`(fire-and-forget spawn:60-66)、`/Users/danielxing/repos/open-dynamic-workflows/src/cli.ts`(helpText:55 缺 --timeout/--budget;reportTerminal 退出码:439-451;list 已含 name:268)、`/Users/danielxing/repos/open-dynamic-workflows/src/workflows/resolve.ts`(三处复用 resolver, 文档:14-16)、`/Users/danielxing/repos/open-dynamic-workflows/src/runtime/server.ts`(API 端点)、`/Users/danielxing/repos/open-dynamic-workflows/src/dashboard.html`(待替换为单一 bundle 工件)、`/Users/danielxing/repos/open-dynamic-workflows/skill/SKILL.md`(待复核)、`/Users/danielxing/repos/open-dynamic-workflows/tests/`(无 dual-compat 审计 + fixtures,待新建)。