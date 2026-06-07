# Open Dynamic Workflows User Functional Test Plan

Date: 2026-06-07

Test owner: Codex acting as a professional end user / QA user

Scope: user-facing functional testing for the ODW CLI, web client, and desktop app. This plan intentionally focuses on real user workflows rather than internal unit tests.

## Test Philosophy

ODW should pass three user-facing promises:

1. A user or agent can create, discover, run, inspect, and control dynamic workflows through the CLI.
2. The client app can observe those workflows accurately without starting or mutating runs.
3. The desktop app can host the same client experience reliably.

Testing should start from user actions and visible results. Internal files and APIs may be inspected only to set up fixtures or confirm a visible behavior.

## Environment

- Repository worktree: `/Users/danielxing/repos/open-dynamic-workflows-functional-test-plan`
- Branch: `codex/functional-test-plan`
- Node target: Node >= 20
- Browser target: in-app Browser / visual browser checks for the web client
- Desktop target: macOS Tauri app, tested with visual Computer Use when available
- CLI fixture project: `/var/folders/5b/h724t4r57sscqb7v7ymbggbw0000gn/T/odw-functional-test-RUTrMi/project`
- CLI fixture runs root: `/var/folders/5b/h724t4r57sscqb7v7ymbggbw0000gn/T/odw-functional-test-RUTrMi/runs`
- Web populated test URL: `http://127.0.0.1:4328/?snap=1`
- Web empty-state test URL: `http://127.0.0.1:4329/?snap=1`
- Desktop app observed: `/Applications/Open Dynamic Workflows.app`
- Desktop live smoke run: `20260607-140053-4d9d55` / `desktop-smoke-codex-20260607`

## Result Legend

- Pending: not executed yet
- Pass: passed test
- Fail: issue found; see notes
- Blocked: could not execute because of environment or tool limitation

## Setup

| ID | Area | Scenario | Steps | Expected Result | Result | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| SETUP-01 | Environment | Install dependencies | Run `npm install` in the test worktree if needed. | Dependencies install successfully. | Pass | Passed test. Only a Node `UNDICI-EHPA` warning appeared because this environment sets `NODE_USE_ENV_PROXY=1`. |
| SETUP-02 | Build | Build web bundle and TypeScript runtime | Run `npm run build`. | `web/dist/index.html`, `src/dashboard.generated.ts`, and `dist/` are produced without errors. | Pass | Passed test. `web/dist/index.html` was built and embedded, then TypeScript compiled. |
| SETUP-03 | Test data | Create isolated project and runs root | Create a temp project and runs root under `/tmp` for CLI and app tests. | Test data does not touch the user's real ODW run history. | Pass | Passed test. Created isolated smoke/fail/slow workflows and separate runs root under `/var/folders/.../odw-functional-test-RUTrMi`. |

## CLI Functional Tests

| ID | Area | Scenario | Steps | Expected Result | Result | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| CLI-01 | Help | User can discover available commands | Run `node dist/cli.js --help`. | Help lists `run`, `rerun`, `list`, `status`, `logs`, `result`, `serve`, `workflows`, `pause`, `resume`, and `stop`. | Pass | Passed test. |
| CLI-02 | Version | User can check installed version | Run `node dist/cli.js --version`. | Version prints a semver-looking ODW version. | Pass | Passed test: `open-dynamic-workflows 0.2.4`. |
| CLI-03 | Workflow creation | User can create a workflow file manually | Write a simple workflow to `<project>/.odw/workflows/smoke.js`. | Workflow file exists in the managed project directory. | Pass | Passed test. Created `smoke`, `fail`, and `slow-control` workflows in the temp project. |
| CLI-04 | Workflow discovery | User can list workflows | From `<project>`, run `node dist/cli.js workflows list --config <config>`. | The `smoke` workflow appears with its source path. | Pass | Passed test. `fail`, `slow-control`, and `smoke` appeared. A global Claude workflow also appeared, consistent with current search behavior. |
| CLI-05 | Workflow resolution | User can see where a workflow name resolves | From `<project>`, run `node dist/cli.js workflows where smoke --config <config>`. | Output points to `<project>/.odw/workflows/smoke.js`. | Pass | Passed test. |
| CLI-06 | Run by name | User can start a workflow by name | Run `node dist/cli.js run smoke --config <config> --runs-root <runsRoot> --wait`. | Run completes successfully and prints result. | Pass | Passed test. Run `20260607-134314-b50e53` completed with `{ "ok": true, "reply": "mock reply" }`. |
| CLI-07 | Run list | User can list recorded runs | Run `node dist/cli.js list --runs-root <runsRoot>`. | The completed `smoke` run appears with state `done`. | Pass | Passed test. |
| CLI-08 | Filter by workflow | User can list runs for one workflow | Run `node dist/cli.js list --workflow smoke --runs-root <runsRoot>`. | Only `smoke` runs appear. | Pass | Passed test. |
| CLI-09 | Status | User can inspect one run state | Run `node dist/cli.js status <runId> --runs-root <runsRoot>`. | Output includes run id, `done`, workflow name, and dispatched agent count. | Pass | Passed test for completed run. |
| CLI-10 | Logs | User can view run events | Run `node dist/cli.js logs <runId> --runs-root <runsRoot>`. | Output shows run started / finished events and workflow logs. | Pass | Passed test. Logs showed `run_started`, `phase_started`, `log`, `agent_started`, `agent_finished`, and `run_finished`. |
| CLI-11 | Result | User can read final result | Run `node dist/cli.js result <runId> --runs-root <runsRoot>`. | Output prints the workflow return value. | Pass | Passed test. |
| CLI-12 | Rerun | User can rerun an existing run | Run `node dist/cli.js rerun <runId> --runs-root <runsRoot>`, then inspect the new run. | A new run is created with the same script and args. | Pass | Passed test. New run `20260607-134330-067547` completed as `done`. |
| CLI-13 | Failure path | User gets clear failure output | Run a workflow that throws with `--wait`. | Command exits non-zero; `result` surfaces error details. | Pass | Passed test. Exit code was `1`; output said `run failed: intentional functional failure`. |
| CLI-14 | Missing workflow | User gets clear not-found feedback | Run `node dist/cli.js run missing-name --config <config> --runs-root <runsRoot>`. | Command exits non-zero and explains the workflow was not found. | Pass | Passed test. Output explained no workflow named `missing-name` and listed searched roots. |
| CLI-15 | Pause / resume | User can pause and resume a running workflow | Start a long-running workflow, run `pause`, verify status, run `resume`, wait for completion. | Status moves through paused/running and eventually completes. | Fail | Pause/resume worked, but while paused `status` showed `dispatched: 0 agent(s)` even though the first agent had already completed. See ISSUE-CLI-01. |
| CLI-16 | Stop | User can stop a running workflow | Start a long-running workflow, run `stop`, then wait / inspect status. | Run ends as `stopped`; `--wait` maps stopped to non-zero. | Pass | Passed test. Stopped run `20260607-134411-8e2e30` ended as `stopped`; `result` reported `run was stopped before completion`. |

## Web Client / App Page Functional Tests

These tests use the same SPA loaded from `odw serve`. They cover the browser-hosted client and the page behavior used by the desktop shell.

| ID | Area | Scenario | Steps | Expected Result | Result | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| WEB-01 | Launch | User can open the client | Start `node dist/cli.js serve --runs-root <runsRoot> --config <config> --port 4328` and open it in the browser. | Client loads without console-blocking errors and defaults to Activity. | Pass | Passed test. Page title was `Open Dynamic Workflows`; no page console errors were captured. |
| WEB-02 | Activity empty state | User sees understandable empty state | Open Activity with an empty runs root. | Counters show zero and event stream explains how to start a run. | Pass | Passed test on port 4329. Empty Activity showed zero counters and `No recent events`. |
| WEB-03 | Activity populated state | User sees global activity | Seed demo fixtures, open Activity. | Active run count, running agent count, adapter fleet, and event stream match seeded runs. | Pass | Passed test after assigning an alive pid to two running fixtures. Activity showed `2 runs active`, `7 agents running`, and adapter fleet counts. |
| WEB-04 | Workspace list | User can see workflows | Open Workspace. | ODW workflow list is visible with names, descriptions, phase counts, and managed-dir source labels. | Pass | Passed test. ODW group showed 8 workflows; Claude Code group showed 1 global workflow. |
| WEB-05 | Workspace detail | User can inspect one workflow | Click `deep-research`. | Detail shows name, description, CLI hint, phases, structure, source, and recent runs. | Pass | Passed test. Detail showed phases, source with `export const meta`, and recent runs. |
| WEB-06 | Workspace to run detail | User can jump from workflow to run | Click a recent run in Workspace. | App navigates to Job detail for that run. | Pass | Passed test. Clicked a `deep-research` recent run and navigated to Job detail. |
| WEB-07 | Jobs empty state | User sees understandable jobs empty state | Open Jobs with an empty runs root. | Page says no runs yet and shows CLI hint. | Pass | Passed test on port 4329. |
| WEB-08 | Jobs active/history | User can monitor active and historical runs | Open Jobs with demo fixtures. | Active strip shows running runs; history table shows done/failed/stale runs grouped by date. | Pass | Passed test. Active strip showed `agent-daily-digest` and `deep-research`; history showed stopped/done/failed/stale rows grouped under Today. |
| WEB-09 | Job graph | User can inspect the live DAG | Open a running `deep-research` run. | Graph tab shows phase lanes, agent nodes, states, progress, and ticker. | Pass | Passed test. Graph showed 5 lanes, 10 nodes, `running/done/failed` states, and 50% progress. |
| WEB-10 | Agent detail panel | User can inspect an agent node | Click a failed or running agent node. | Detail panel opens with adapter, phase, started time, duration/status, and error if failed. | Pass | Passed test. Failed node detail opened with the malformed JSON schema error. |
| WEB-11 | Logs tab | User can inspect event logs | Click Logs tab in Job detail. | Logs show event rows with timestamp, event type, and message/agent label. | Fail | Logs render rows, but the log content overlaps the stage header and intercepts clicks on the Graph/Logs/Result tabs. See ISSUE-WEB-01. |
| WEB-12 | Result tab done | User can inspect result for a completed run | Open a done run and click Result. | Result tab shows `result.json` content. | Fail | Direct `/result` URL renders `result.json`, but after entering Logs the Result tab cannot be clicked because log rows cover the header. See ISSUE-WEB-01 and ISSUE-WEB-02. |
| WEB-13 | Result tab failed | User can inspect failure details | Open a failed run and click Result. | Result tab shows `error.json` content. | Pass | Passed test via direct failed result route. `error.json` content was visible. |
| WEB-14 | Copy run id | User can copy a run id | Click `Copy run id` in Job detail. | Button changes to copied state; run id is available to clipboard if browser permits. | Pass | Passed test on Graph tab. Clipboard contained the run id and the button changed to `已复制`. Copy from Result/Logs is affected by ISSUE-WEB-01. |
| WEB-15 | Navigation state | User can navigate without state leaking | Move Activity -> Jobs -> Job -> Logs -> Workspace -> another Job. | Each page renders correct state; previous selected agent/tab does not corrupt unrelated pages. | Fail | After visiting Logs, opening another bare Job detail URL stayed on Logs instead of returning to Graph. See ISSUE-WEB-02. |
| WEB-16 | Language switch | User can switch interface language | Open Settings, switch to Chinese, navigate pages, reload. | UI switches to Chinese and persists after reload. | Pass | Passed test. `html lang` became `zh-CN`; nav and Settings translated; reload preserved Chinese. |
| WEB-17 | Read-only invariant | App does not control runs | Inspect visible pages and trigger available controls. | No page starts a workflow or calls pause/resume/stop; only navigation, copy, and language change are active. | Pass | Passed test. No visible run launch/pause/resume/stop controls were found; Settings controls are presentational except language. |
| WEB-18 | Responsive/minimum window | UI remains usable at minimum desktop size | Resize browser near 980x640. | Text and controls remain visible without incoherent overlap. | Pass | Passed test at 980x640. No page-level overflow was detected; nav and primary controls remained visible. |

## Desktop App Functional Tests

These tests require real visual desktop interaction. Computer Use / visual app control must be used for the tests below when the environment exposes it.

| ID | Area | Scenario | Steps | Expected Result | Result | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| DESK-01 | Build | Desktop app can be built or existing app can be launched | Build with `npm run build:binary`, `cd apps/desktop`, `npm run build`, or launch the existing `.app` if already available. | App bundle exists and can be opened. | Pass | Existing `/Applications/Open Dynamic Workflows.app` was present and running. Current worktree app bundle was not rebuilt in this pass. |
| DESK-02 | Launch | Desktop app opens to the ODW client | Open the app with Computer Use and observe the window. | Splash transitions to the ODW client loaded from local sidecar. | Pass | Visual desktop verification passed via macOS window capture. Window showed the ODW client Activity page. Dedicated desktop Computer Use tooling was not exposed in this environment. |
| DESK-03 | Sidecar | App starts `odw serve` sidecar | Launch app and inspect visible page / process output. | Client loads from `http://127.0.0.1:4317` and uses the bundled sidecar. | Pass | Process list showed `/Applications/Open Dynamic Workflows.app/.../odw serve --port 4317`, and port 4317 was listening. Window showed `Live`. |
| DESK-04 | Page operation | Desktop-hosted pages behave like web client | Use Computer Use to click Activity, Workspace, Jobs, Job detail, Logs, Result, Settings. | Same visible behavior as web client. | Partial | Ran a real flow into the desktop sidecar's default runs root. Desktop window visually showed `desktop-smoke-codex-20260607` events. Using the same `http://127.0.0.1:4317` sidecar in browser, Jobs -> detail -> Result worked. Native-window click-through remained unreliable because dedicated desktop CUA tooling was not exposed. |
| DESK-05 | Window close | Closing window hides app instead of quitting | Close main window, then use tray/Dock to show it again if available. | App stays resident and can be shown again. | Blocked | Not executed to avoid disrupting the user's already-running installed app without reliable desktop control. |
| DESK-06 | Quit | Quitting stops the sidecar | Quit app. | Sidecar process is not left running. | Blocked | Not executed to avoid stopping the user's already-running installed app without reliable desktop control. |
| DESK-07 | Notifications/badge | Native signals reflect run transitions | With app open, transition a run to done/failed. | Dock badge / notification behavior matches active and terminal run state. | Blocked | Not executed; requires reliable desktop interaction and notification observation. |
| DESK-08 | Port conflict | User sees understandable behavior if port 4317 is occupied | Start another server on 4317, then launch app. | App does not silently show stale/wrong state; failure is understandable. | Blocked | Port 4317 was already occupied by the running ODW sidecar; conflict test would require quitting/relaunching the installed app. |

## Execution Log

| Time | Case ID | Observation |
| --- | --- | --- |
| 2026-06-07 | PLAN | Initial user-perspective test plan created. |
| 2026-06-07 | SETUP-01..03 | Installed deps, built web/runtime, and created isolated temp project/runs root. |
| 2026-06-07 | CLI-01..14 | CLI help/version/workflow discovery/run/list/status/logs/result/rerun/failure/missing workflow passed. |
| 2026-06-07 | CLI-15 | Pause/resume functionally worked, but paused status showed stale dispatched count. |
| 2026-06-07 | CLI-16 | Stop functionally worked and `result` reported stopped state. |
| 2026-06-07 | WEB-01..18 | Browser-hosted client tested with populated and empty fixtures; found Logs/header overlay and tab-state leakage. |
| 2026-06-07 | DESK-01..03 | Existing installed desktop app and sidecar visually verified through window-specific screenshot. |
| 2026-06-07 | DESK-04..08 | Full desktop click-through, close/quit, notification, and port-conflict cases blocked by lack of dedicated desktop CUA tooling and risk of disrupting the installed app. |
| 2026-06-07 | DESK-04 follow-up | Ran real workflow `desktop-smoke-codex-20260607` into `~/.odw/runs`; desktop window showed the new events. Verified Jobs -> detail -> Result on the desktop sidecar at `127.0.0.1:4317` through browser automation. |

## Follow-up: Real Desktop Smoke Run

After the initial pass, I ran an actual dynamic flow in this session specifically for desktop verification:

- Workflow: `desktop-smoke-codex-20260607`
- Run id: `20260607-140053-4d9d55`
- Runs root: `/Users/danielxing/.odw/runs`
- Command path: `node dist/cli.js run <temp>/desktop-smoke-codex-20260607.js --config <temp>/odw.config.json --runs-root /Users/danielxing/.odw/runs --wait`
- Result: passed; returned `{ "ok": true, "source": "codex-session", "reply": "mock reply" }`

Verification:

- `http://127.0.0.1:4317/api/runs` showed the run as `done`.
- `http://127.0.0.1:4317/api/runs/20260607-140053-4d9d55` showed 2 phases, 1 done agent, and `hasResult: true`.
- Desktop window capture showed the new `desktop-smoke-codex-20260607` Activity events (`RUN_STARTED`, `AGENT_STARTED`, `RUN_FINISHED`) at the top of the live event stream.
- Using browser automation against the same desktop sidecar URL (`http://127.0.0.1:4317/?snap=1`), I clicked Jobs -> the new run -> Result. Job detail showed the correct workflow name, `done` badge, 2 phase lanes, one done `desktop-agent`, and the expected `result.json`.

Limitation:

- I still did not complete a reliable native-window click-through inside the Tauri window itself. Once the ODW window was visibly on the current desktop, a coordinate click was attempted, but it did not switch from Activity to Jobs. The same path worked through the sidecar URL in the browser. This leaves native-window interaction as partially verified, not fully verified.

## Issues Found

| ID | Severity | Area | Case(s) | Summary | Details |
| --- | --- | --- | --- | --- | --- |
| ISSUE-WEB-01 | High | Web Job Detail | WEB-11, WEB-12, WEB-14 | Logs content overlaps the stage header and intercepts tab/copy clicks. | In Job detail Logs tab, visual screenshot showed log rows starting underneath the header. `document.elementFromPoint()` on the visible Result tab returned `.logrow`, so clicking Result from Logs did nothing. This also explains copy failing from Result/Logs surfaces. |
| ISSUE-WEB-02 | Medium | Web navigation state | WEB-12, WEB-15 | Job tab state leaks between different jobs / bare job routes. | After visiting `#/job/<run>/logs`, opening another bare `#/job/<other-run>` route still showed Logs instead of defaulting to Graph. Direct `#/job/<run>/result` works, so the result renderer is fine; the user navigation state is the problem. |
| ISSUE-CLI-01 | Low | CLI status | CLI-15 | Paused run status shows inaccurate dispatched count. | During `slow-control`, pause was requested after the first agent completed. `status` correctly showed `[paused]`, but also showed `dispatched: 0 agent(s)` even though one agent had already run. Terminal state later showed `dispatched: 2`. |
| ISSUE-DESK-01 | Medium | Desktop testing / window management | DESK-04 | Installed desktop window opened off-screen / different Space during testing; native-window coordinate click-through remained unreliable. | `odw-desktop` had a real window named `Open Dynamic Workflows`, but initial full-screen captures showed Codex. System Events reported the window at `{165, -960}` before it was moved. Window-id capture showed the app correctly, and later full-screen capture showed it visibly on the desktop. A coordinate click on Jobs still did not switch views, while the same route worked through the 4317 sidecar in browser automation. |
