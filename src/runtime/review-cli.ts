/**
 * `odw review` (ODW extension; see ./review): the kept diffs across runs that
 * still wait for a person, riskiest first, each with why it ranks there.
 *
 *   odw review [--json] [--since 7d] [--all] [--config P] [--runs-root DIR]
 *   odw review mark <run_id> <agent id|label> reviewed|dismissed|applied|open [--note TEXT]
 *
 * `--since` keeps the runs created in that window (`7d`, `12h`, `2w`); `--all`
 * lists the entries already marked too. `mark` appends to the run's
 * `reviews.jsonl`, attributed to the local user; `open` puts an entry back.
 * Exit 0, 1 when the run or agent is not there, 2 on a usage error.
 */

import { parseArgs } from "node:util";

import { loadConfig, resolveRunsRoot } from "../adapters/config.js";
import { cliActor } from "../identity.js";
import { detectCaps, palette, sanitizeText, type TermCaps } from "../tty.js";
import { agentRows, matchAgents } from "./agents-view.js";
import { parseAge } from "./gc-cli.js";
import { appendReview, isReviewState, markable, ReviewReader, REVIEW_NOTE_MAX, type ReviewEntry, type ReviewQueue } from "./review.js";
import { RunStore } from "./run-store.js";
import { RUN_ID_RE } from "./run-source.js";

const REVIEW_USAGE = "usage: odw review [--json] [--since 7d] [--all] | odw review mark <run_id> <agent> reviewed|dismissed|applied|open [--note TEXT]";

export async function cmdReview(rest: string[], now = Date.now() / 1000): Promise<number> {
  if (rest[0] === "mark") return cmdMark(rest.slice(1));
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      json: { type: "boolean" },
      since: { type: "string" },
      all: { type: "boolean" },
      config: { type: "string" },
      "runs-root": { type: "string" },
    },
  });
  if (positionals.length > 0) return usage(`odw review: unknown argument ${JSON.stringify(positionals[0])}\n${REVIEW_USAGE}`);
  let since: number | null = null;
  if (values.since !== undefined) {
    const days = parseAge(values.since);
    if (days === null) return usage(`odw review: --since takes an age like 7d, 12h or 2w; got ${JSON.stringify(values.since)}`);
    since = now - days * 86_400;
  }
  const queue = new ReviewReader(storeOf(values)).queue({ since, all: values.all === true });
  if (values.json) process.stdout.write(JSON.stringify({ version: 1, since, ...queue }, null, 2) + "\n");
  else process.stdout.write(formatReview(queue, { all: values.all === true, caps: detectCaps(process.stdout, process.env) }) + "\n");
  return 0;
}

function cmdMark(rest: string[]): number {
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      note: { type: "string" },
      json: { type: "boolean" },
      config: { type: "string" },
      "runs-root": { type: "string" },
    },
  });
  const [runId, ref, state] = positionals;
  if (runId === undefined || ref === undefined || state === undefined || positionals.length > 3) return usage(REVIEW_USAGE);
  if (!isReviewState(state)) return usage(`odw review mark: the state is reviewed, dismissed, applied or open; got ${JSON.stringify(state)}`);
  if (values.note !== undefined && values.note.length > REVIEW_NOTE_MAX) return usage(`odw review mark: --note takes at most ${REVIEW_NOTE_MAX} characters`);
  if (!RUN_ID_RE.test(runId) || runId.startsWith("cc-")) return usage(`odw review mark: not an odw run id: ${sanitizeText(runId, 80)}`);
  const store = storeOf(values);
  if (!store.exists(runId)) {
    process.stderr.write(`no such run: ${runId}\n`);
    return 1;
  }
  const matches = matchAgents(agentRows(store, runId), ref);
  if (matches.length !== 1 || matches[0]!.agentId === null) {
    const why =
      matches.length > 1
        ? `label '${sanitizeText(ref, 80)}' matches ${matches.length} agents: ${matches.map((r) => r.agentId ?? "?").join(", ")} — name one by id`
        : `has no agent '${sanitizeText(ref, 80)}' (see odw agents ${runId})`;
    process.stderr.write(`odw review mark: run ${runId} ${why}\n`);
    return 1;
  }
  const agentId = matches[0]!.agentId;
  if (!markable(store, runId, agentId)) {
    process.stderr.write(`odw review mark: agent ${agentId} of run ${runId} kept no diff: there is nothing to review\n`);
    return 1;
  }
  const mark = appendReview(store.runDir(runId), { agentId, state, by: cliActor(), via: "cli", note: values.note ?? null });
  if (values.json) process.stdout.write(JSON.stringify({ runId, ...mark }) + "\n");
  else process.stdout.write(state === "open" ? `agent ${agentId} of run ${runId} is back on the review queue\n` : `marked agent ${agentId} of run ${runId} ${state}\n`);
  return 0;
}

function storeOf(values: { config?: string; "runs-root"?: string }): RunStore {
  return new RunStore(values["runs-root"] ?? resolveRunsRoot(loadConfig(values.config ?? null, { quiet: true }).settings.runsRoot));
}

function usage(text: string): number {
  process.stderr.write(`${text}\n`);
  return 2;
}

/** The queue as `odw review` prints it: an entry per agent, its reasons under it, then the commands that act on it. */
export function formatReview(queue: ReviewQueue, opts: { all?: boolean; caps?: TermCaps } = {}): string {
  const p = palette(opts.caps ?? { color: false, truecolor: false, unicode: false });
  const safe = (s: string, n = 200): string => sanitizeText(s, n);
  const dealt = queue.marked > 0 && !opts.all ? ` · ${queue.marked} already dealt with (--all lists them)` : "";
  if (queue.entries.length === 0) return `nothing to review: no kept diff waits${dealt}`;
  const lines = [`${queue.open} kept diff(s) to review, riskiest first${dealt}`];
  const tint = (e: ReviewEntry, s: string): string => (e.risk === "high" ? p.err(s) : e.risk === "medium" ? p.run(s) : p.ok(s));
  for (const e of queue.entries) {
    const c = e.changes;
    const mark = e.review && e.review.state !== "open" ? p.dim(` · ${e.review.state}${e.review.by ? ` by ${safe(e.review.by, 80)}` : ""}`) : "";
    lines.push("");
    lines.push(
      `${tint(e, `${e.risk.toUpperCase().padEnd(6)} ${String(e.score).padStart(2)}`)}  ${e.runId} · agent ${e.agentId} (${safe(e.label, 60)})${e.repo ? ` · repo ${safe(e.repo, 64)}` : ""}` +
        ` · ${c.files} file(s) +${c.insertions} -${c.deletions} · ${safe(e.run, 60)}${e.agentState === "failed" ? p.err(" · failed") : ""}${mark}`,
    );
    if (e.factors.length === 0) lines.push(p.dim("           small, and nothing on record against it"));
    for (const f of e.factors) lines.push(`  ${p.dim(`${f.points > 0 ? "+" : ""}${f.points}`.padStart(8))}  ${safe(f.why, 240)}`);
    lines.push(p.dim(`           odw diff ${e.runId} --agent ${e.agentId} · odw apply ${e.runId} --agent ${e.agentId} --check · odw review mark ${e.runId} ${e.agentId} reviewed`));
  }
  return lines.join("\n");
}
