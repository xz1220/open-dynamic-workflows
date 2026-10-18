/**
 * A pull request from what isolated agents changed (ODW extension):
 * `odw apply <run> --agent X|--all --pr`.
 *
 * Instead of the working tree you are in, the kept diffs go to a new branch —
 * `odw/<run>-<label>` (`odw/<run>-all` for `--all`), with `-2`, `-3`, … when
 * the name is taken here or on the remote — made from `--base` (else HEAD) in
 * a temporary worktree. Each agent is previewed and applied there exactly as
 * `odw apply` would (./apply), `--verify` included, and committed on its own
 * — one commit per agent — under your git identity and signing settings
 * (odw sets no identity). The commit message names the workflow, the agent,
 * the diff stat, the run and what the agent cost when its CLI reported it.
 *
 * Anything short of every agent applying cleanly (and passing its verify)
 * stops before the push: the branch is deleted and nothing leaves the
 * machine. Then the branch is pushed to `--remote` (origin), and `gh pr
 * create` opens the PR — a draft unless `--ready` — whose body holds the run
 * summary: the agents with their commits, the phases, the spend receipt, the
 * verify result and the `odw diff` commands to inspect it. Without `gh`, or
 * with a `gh` not logged in, it stops after the push and prints the compare
 * URL. It never merges, and never touches your working tree or index: its
 * uncommitted changes are simply not part of the PR.
 */

import { mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { runCommand } from "../adapters/runner.js";
import { git, runGit } from "../changes.js";
import { fmtTokens, fmtUsd, sanitizeText } from "../tty.js";
import { prepareWorktree } from "../worktree-setup.js";
import { applyAgents, type AgentDiff, type ApplyOptions } from "./apply.js";
import type { RunDetail } from "./runs-view.js";
import { spendByPhase } from "./spend-view.js";

export interface PrOptions {
  /** `--base`: the branch the PR targets and its branch starts from; null for the branch HEAD is on. */
  base: string | null;
  /** `--remote` (default "origin"). */
  remote: string;
  /** A draft PR (the default); `--ready` opens it ready for review. */
  draft: boolean;
  /** `--title`; null for one built from the run. */
  title: string | null;
  /** The run, for the commit messages and the PR body. */
  run: RunDetail;
}

export type ApplyPrOptions = Omit<ApplyOptions, "check" | "force" | "resolve"> & { pr: PrOptions };

/** What became of one agent on the PR branch. */
interface Committed {
  agent: AgentDiff;
  /** The commit it got; null when its diff was in the base already. */
  sha: string | null;
}

/** Seconds `gh` may take to answer. */
const GH_TIMEOUT = 120;

/**
 * `odw apply --pr`, as the module doc describes. Writes its report and
 * returns the exit code: 0 once the branch is pushed (and the PR opened, when
 * `gh` can), 1 otherwise.
 */
export async function applyPr(o: ApplyPrOptions): Promise<number> {
  const say = (line: string): void => void o.out.write(`${line}\n`);
  const fail = (line: string): number => {
    o.err.write(`odw apply --pr: ${line}\n`);
    return 1;
  };
  let repo: string;
  try {
    repo = (await git(o.cwd, ["rev-parse", "--show-toplevel"])).trim();
  } catch (err) {
    const where = o.source ? ` (the run worked in ${o.source})` : "";
    return fail(`run it inside the git repository to open the PR in${where}: ${errorText(err)}`);
  }
  const remoteUrl = (await git(repo, ["config", "--get", `remote.${o.pr.remote}.url`], { okCodes: [0, 1] })).trim();
  if (remoteUrl === "") return fail(`this repository has no remote '${sanitizeText(o.pr.remote, 80)}' to push to (--remote names another)`);

  // Where the branch starts, and what the PR targets.
  let baseName: string;
  let start: string;
  if (o.pr.base !== null) {
    baseName = o.pr.base.startsWith(`${o.pr.remote}/`) ? o.pr.base.slice(o.pr.remote.length + 1) : o.pr.base;
    const found = (await commitOf(repo, o.pr.base)) ?? (await commitOf(repo, `refs/remotes/${o.pr.remote}/${baseName}`));
    if (!found) return fail(`no branch or commit '${sanitizeText(o.pr.base, 120)}' here (nor ${sanitizeText(o.pr.remote, 80)}/${sanitizeText(baseName, 120)}): fetch it, or name another with --base`);
    start = found;
  } else {
    const head = (await git(repo, ["symbolic-ref", "-q", "--short", "HEAD"], { okCodes: [0, 1] })).trim();
    if (head === "") return fail("HEAD is not on a branch: name the branch the PR targets with --base");
    const found = await commitOf(repo, "HEAD");
    if (!found) return fail(`branch ${sanitizeText(head, 120)} has no commit yet to branch from`);
    baseName = head;
    start = found;
  }

  // Your working tree is not read: uncommitted work there stays, and stays out of the PR.
  const dirty = (await git(repo, ["status", "--porcelain=v1", "-z", "--untracked-files=no"])).length > 0;
  if (dirty) {
    o.err.write(`odw apply --pr: your uncommitted changes stay where they are and are not part of the PR: it branches from ${sanitizeText(baseName, 120)} (${start.slice(0, 12)})\n`);
  }

  let agents = o.agents;
  if (o.all) {
    // As odw apply --all: a failed agent's diff is unfinished work, opened only when named.
    for (const a of agents.filter((a) => a.row.state !== "done")) {
      const why = a.row.state === "failed" ? "failed" : `is ${a.row.state}`;
      o.err.write(`odw apply --pr: --all leaves out agent ${a.row.agentId} (${labelOf(a)}), which ${why}: open its own PR with --agent ${a.row.agentId}\n`);
    }
    agents = agents.filter((a) => a.row.state === "done");
    if (agents.length === 0) return fail(`run ${o.runId} has no finished agent that kept a diff`);
  }

  const branch = await freeBranch(repo, o.pr.remote, o.all ? `odw/${o.runId}-all` : `odw/${o.runId}-${slug(agents[0]!)}`);
  const work = await mkdtemp(join(tmpdir(), "odw-pr-"));
  const tree = join(work, basename(repo));
  const committed: Committed[] = [];
  let made = false;
  let pushed = false;
  const links: string[] = [];
  try {
    try {
      await git(repo, ["worktree", "add", "-q", "-b", branch, tree, start]);
      made = true;
    } catch (err) {
      return fail(`could not make branch ${branch} in a temporary worktree: ${errorText(err)}`);
    }
    say(`odw apply --pr: branch ${branch} from ${sanitizeText(baseName, 120)} (${start.slice(0, 12)}), in a temporary worktree — your working tree is not touched`);
    if (o.verify) {
      // What .worktreeinclude brings an isolated agent (node_modules, .env, …), the verify command gets too.
      await prepareWorktree(repo, tree, tree, { onNote: (note) => o.err.write(`odw apply --pr: ${sanitizeText(note, 300)}\n`) }, links).catch((err: unknown) =>
        o.err.write(`odw apply --pr: the temporary worktree could not be made ready: ${sanitizeText(errorText(err), 300)}\n`),
      );
    }
    for (const agent of agents) {
      if (o.interrupt?.aborted) return fail("interrupted: nothing was pushed");
      const code = await applyAgents({ ...o, cwd: tree, agents: [agent], all: false, check: false, force: false, resolve: null });
      if (code !== 0) return fail(`agent ${agent.row.agentId} (${labelOf(agent)}) did not apply cleanly${o.verify ? " and pass its verify" : ""}: nothing was pushed, and branch ${branch} is gone`);
      const staged = await runGit(tree, ["diff", "--cached", "--quiet"]);
      if (staged.code === 0) {
        say(`agent ${agent.row.agentId} (${labelOf(agent)}) is in ${sanitizeText(baseName, 120)} already: no commit for it`);
        committed.push({ agent, sha: null });
        continue;
      }
      const stat = (await git(tree, ["diff", "--cached", "--stat=72"])).replace(/\s+$/, "");
      const message = join(work, "message");
      await writeFile(message, commitMessage(o, agent, stat));
      try {
        // Your identity and signing settings, as any commit of yours; hooks stay off, as for every git odw runs.
        await git(tree, ["commit", "-q", "-F", message]);
      } catch (err) {
        return fail(`could not commit agent ${agent.row.agentId} (${labelOf(agent)}): ${errorText(err)} — nothing was pushed`);
      }
      const sha = (await git(tree, ["rev-parse", "HEAD"])).trim();
      committed.push({ agent, sha });
      say(`committed agent ${agent.row.agentId} (${labelOf(agent)}) as ${sha.slice(0, 12)}`);
    }
    if (!committed.some((c) => c.sha)) return fail(`every diff is in ${sanitizeText(baseName, 120)} already: no PR to open`);
    if (o.interrupt?.aborted) return fail("interrupted: nothing was pushed");

    // Pushed from your repository: the branch is there, the worktree goes.
    const push = await runGit(repo, ["push", "--porcelain", o.pr.remote, `refs/heads/${branch}:refs/heads/${branch}`], {
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    if (push.code !== 0) {
      made = false; // keep it: the work is done, only the push is left
      return fail(`could not push ${branch} to ${sanitizeText(o.pr.remote, 80)}: ${gitSaid(push.stderr)}\n  the branch is kept here: git push ${o.pr.remote} ${branch} — then open the PR`);
    }
    pushed = true;
    say(`pushed ${branch} to ${sanitizeText(o.pr.remote, 80)} (${committed.filter((c) => c.sha).length} commit(s))`);
  } finally {
    for (const link of links) await unlink(link).catch(() => {});
    await git(repo, ["worktree", "remove", "--force", "--force", tree]).catch(async () => {
      await rm(tree, { recursive: true, force: true }).catch(() => {});
      await git(repo, ["worktree", "prune"]).catch(() => {});
    });
    if (made && !pushed) await git(repo, ["branch", "-D", branch]).catch(() => {});
    if (!pushed) await rm(work, { recursive: true, force: true }).catch(() => {});
  }

  try {
    const compare = compareUrl(remoteUrl, baseName, branch);
    const manual = compare ? `open it at ${compare}` : `open a PR from ${branch} into ${sanitizeText(baseName, 120)}`;
    const auth = await runCommand(["gh", "auth", "status"], { cwd: repo, timeout: GH_TIMEOUT, env: ghEnv() });
    if (auth.returncode !== 0) {
      const why = auth.returncode === 127 ? "gh (the GitHub CLI) is not installed" : "gh is not logged in (gh auth login)";
      say(`no PR opened: ${why} — ${manual}`);
      return 0;
    }
    const bodyFile = join(work, "body.md");
    await writeFile(bodyFile, prBody(o, committed, branch, baseName));
    const title = o.pr.title ?? defaultTitle(o, agents);
    const args = ["pr", "create", "--head", branch, "--base", baseName, "--title", title, "--body-file", bodyFile];
    if (o.pr.draft) args.push("--draft");
    const created = await runCommand(["gh", ...args], { cwd: repo, timeout: GH_TIMEOUT, env: ghEnv() });
    if (created.returncode !== 0) {
      o.err.write(`odw apply --pr: gh pr create failed: ${sanitizeText(created.stderr.trim() || `exit code ${created.returncode}`, 600)}\n`);
      say(`the branch is pushed: ${manual}`);
      return 1;
    }
    const url = created.stdout.trim().split("\n").pop() ?? "";
    say(`opened ${o.pr.draft ? "a draft " : ""}PR: ${sanitizeText(url, 300)} — odw never merges it`);
    return 0;
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => {});
  }
}

/** gh never asks: a missing answer fails the command instead of waiting on a terminal. */
function ghEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
  return { ...env, GH_PROMPT_DISABLED: "1", GIT_TERMINAL_PROMPT: "0" };
}

async function commitOf(repo: string, ref: string): Promise<string | null> {
  if (ref.startsWith("-")) return null;
  const out = await git(repo, ["rev-parse", "--verify", "-q", "--end-of-options", `${ref}^{commit}`], { okCodes: [0, 1, 128] });
  return out.trim() || null;
}

/** `name`, or `name-2`, `name-3`, …: the first that is no branch here, nor on the remote as far as it says. */
async function freeBranch(repo: string, remote: string, name: string): Promise<string> {
  let onRemote = new Set<string>();
  const listed = await runGit(repo, ["ls-remote", "--heads", remote], { env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }).catch(() => null);
  if (listed?.code === 0) onRemote = new Set(listed.stdout.split("\n").map((line) => line.split("\t")[1] ?? "").filter(Boolean));
  for (let n = 1; ; n++) {
    const candidate = n === 1 ? name : `${name}-${n}`;
    const taken = async (ref: string): Promise<boolean> => (await runGit(repo, ["show-ref", "--verify", "-q", ref])).code === 0;
    if (onRemote.has(`refs/heads/${candidate}`)) continue;
    if (await taken(`refs/heads/${candidate}`)) continue;
    if (await taken(`refs/remotes/${remote}/${candidate}`)) continue;
    return candidate;
  }
}

/** An agent's label as a piece of a branch name: `fix:auth` → `fix-auth`. */
function slug(agent: AgentDiff): string {
  const s = agent.row.label
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/\.{2,}/g, ".")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 40)
    .replace(/[-.]+$/, "");
  return s === "" || s.endsWith(".lock") ? `agent-${agent.row.agentId}` : s;
}

function labelOf(a: AgentDiff): string {
  return sanitizeText(a.row.label, 80);
}

function workflowOf(o: ApplyPrOptions): string {
  return sanitizeText(o.pr.run.workflowName ?? o.pr.run.name ?? "workflow", 80) || "workflow";
}

function defaultTitle(o: ApplyPrOptions, agents: AgentDiff[]): string {
  return o.all ? `odw: ${workflowOf(o)} (${agents.length} agent${agents.length === 1 ? "" : "s"})` : `odw: ${workflowOf(o)}: ${labelOf(agents[0]!)}`;
}

/** What one agent cost, when its CLI reported it. */
function costOf(o: ApplyPrOptions, agent: AgentDiff): number | null {
  const view = o.pr.run.agents.find((a) => a.agentId === agent.row.agentId);
  return view?.usage?.costUsd ?? null;
}

function commitMessage(o: ApplyPrOptions, agent: AgentDiff, stat: string): string {
  const cost = costOf(o, agent);
  return [
    `odw: ${workflowOf(o)}: ${labelOf(agent)}`,
    "",
    `What agent ${agent.row.agentId} (${labelOf(agent)}) of workflow ${workflowOf(o)} changed, applied by odw apply --pr.`,
    "",
    stat,
    "",
    `odw-run: ${o.runId}`,
    `odw-agent: ${agent.row.agentId}`,
    ...(cost !== null ? [`odw-cost: ${fmtUsd(cost)}`] : []),
    "",
  ].join("\n");
}

/** Text for a cell of a Markdown table: one line, no pipes or backticks to break it. */
function cell(text: unknown, max = 80): string {
  return sanitizeText(text, max).replace(/\|/g, "\\|").replace(/`/g, "'");
}

/** The PR's body: the run summary. */
export function prBody(o: ApplyPrOptions, committed: Committed[], branch: string, baseName: string): string {
  const run = o.pr.run;
  const lines: string[] = [];
  lines.push(`Opened by \`odw apply --pr\` from run \`${o.runId}\` of the workflow **${cell(workflowOf(o))}**, on top of \`${cell(baseName, 120)}\`.`);
  lines.push("odw never merges: review it, and merge it yourself.");
  lines.push("");
  lines.push("### Agents");
  lines.push("");
  lines.push("| agent | phase | files | lines | cost | commit |");
  lines.push("|---|---|---|---|---|---|");
  for (const c of committed) {
    const ch = c.agent.row.changes;
    const cost = costOf(o, c.agent);
    lines.push(
      `| ${c.agent.row.agentId} ${cell(c.agent.row.label)} | ${c.agent.row.phase ? cell(c.agent.row.phase) : "—"} | ${ch ? ch.files : "?"} | ${ch ? `+${ch.insertions} −${ch.deletions}` : "?"} | ${cost !== null ? fmtUsd(cost) : "—"} | ${c.sha ? c.sha.slice(0, 12) : `in ${cell(baseName, 60)} already`} |`,
    );
  }
  const phases = run.phaseOrder.length > 0 ? run.phaseOrder : run.phases.map((p) => p.title);
  if (phases.length > 0) {
    lines.push("");
    lines.push(`**Phases:** ${phases.map((p) => cell(p, 60)).join(" → ")}`);
  }
  const spend = spendByPhase(run);
  if (spend) {
    lines.push("");
    lines.push("### Spend");
    lines.push("");
    lines.push("| phase | agents | tokens | cost |");
    lines.push("|---|---|---|---|");
    for (const p of spend.phases) {
      if (p.agents === 0) continue;
      lines.push(`| ${p.key ? cell(p.key, 60) : "outside phases"} | ${p.agents} | ${fmtTokens(p.tokens)}${p.estimated ? "~" : ""} | ${p.costUsd !== null ? fmtUsd(p.costUsd) : "—"} |`);
    }
    lines.push(`| **total** | ${spend.phases.reduce((n, p) => n + p.agents, 0)} | ${fmtTokens(spend.tokens)}${spend.estimated ? "~" : ""} | ${spend.costUsd !== null ? fmtUsd(spend.costUsd) : "—"} |`);
    if (spend.estimated) lines.push("", "~ an estimate: some CLI reported no output tokens.");
  }
  lines.push("");
  lines.push("### Verify");
  lines.push("");
  lines.push(o.verify ? `\`${cell(o.verify, 200)}\` passed after each agent's change was applied.` : "No verify command ran (`--verify`, the `applyVerify` setting).");
  lines.push("");
  lines.push("### Inspect");
  lines.push("");
  lines.push("```sh");
  for (const c of committed) lines.push(`odw diff ${o.runId} --agent ${c.agent.row.agentId}`);
  lines.push(`odw status ${o.runId}`);
  lines.push(`git fetch ${o.pr.remote} ${branch}`);
  lines.push("```");
  lines.push("");
  return lines.join("\n");
}

/**
 * The page that opens a PR from `branch` into `base`, for a GitHub remote;
 * null for others. Credentials in the URL never make it into the link.
 */
export function compareUrl(remoteUrl: string, base: string, branch: string): string | null {
  let host: string;
  let path: string;
  const scp = /^(?:[^@/]+@)?([^:/]+):(?!\/)(.+)$/.exec(remoteUrl);
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(remoteUrl)) {
    let url: URL;
    try {
      url = new URL(remoteUrl);
    } catch {
      return null;
    }
    if (!["https:", "http:", "ssh:", "git:"].includes(url.protocol)) return null;
    host = url.hostname;
    path = url.pathname;
  } else if (scp) {
    host = scp[1]!;
    path = scp[2]!;
  } else {
    return null;
  }
  if (!/(^|\.)github\.com$|^github\./i.test(host)) return null;
  const repoPath = path.replace(/^\/+/, "").replace(/\.git$/, "").replace(/\/+$/, "");
  if (!/^[\w.-]+\/[\w.-]+$/.test(repoPath)) return null;
  const enc = (ref: string): string => ref.split("/").map(encodeURIComponent).join("/");
  return `https://${host}/${repoPath}/compare/${enc(base)}...${enc(branch)}?expand=1`;
}

function gitSaid(stderr: string): string {
  return sanitizeText(stderr.trim().split("\n").filter(Boolean).slice(-3).join(" ") || "no reason given", 500);
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
