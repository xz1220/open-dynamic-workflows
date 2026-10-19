/**
 * `odw digest` (an ODW extension; see ./digest): one evidence-only report over
 * many runs, printed or sent through the `notify` hooks.
 *
 *   odw digest [--since 12h | --since-last] [--workflow W] [--json | --markdown]
 *              [--notify] [--config P] [--runs-root DIR]
 *
 * The window is the last 24 hours unless `--since` (`90m`, `12h`, `2d`, `1w`)
 * or `--since-last` says otherwise: `--since-last` starts where the last digest
 * that was sent (`--notify`, every hook succeeding) ended — per `--workflow`,
 * kept in `<runsRoot>/_digest/marks.json` — and is the last 24 hours before
 * the first. Looking (no `--notify`) never moves the mark.
 *
 * `--notify` fires the configured hooks once, when `notify.on` lists "digest":
 * the webhook gets `{ kind: "digest", state: "digest", …the digest as JSON (not its runsRoot),
 * markdown, text, content }`, redacted, with each waiting checkpoint's signed
 * one-time approve/reject links while an `odw serve --public-url` runs; a
 * command gets ODW_RUN_STATE=digest, ODW_DIGEST_TEXT (the one-line summary),
 * ODW_DIGEST_FILE and ODW_DIGEST_MARKDOWN_FILE (files deleted once it exits),
 * ODW_DIGEST_SINCE, ODW_DIGEST_NEEDS_YOU and ODW_DIGEST_FAILED. Exit 0; 1 when
 * a hook failed or none is configured for "digest"; 2 on a usage error.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

import { loadConfig, resolveRunsRoot } from "../adapters/config.js";
import type { Config } from "../adapters/types.js";
import { redactorFor } from "../redact.js";
import { detectCaps } from "../tty.js";
import { mintCheckpointLinks } from "./approve-links.js";
import { collectDigest, digestLine, digestMarkdown, formatDigest, type Digest } from "./digest.js";
import { readJsonFile, writeJsonAtomic } from "./fs-util.js";
import { discordContent, notifyDigest, slackText } from "./notify.js";
import { RunStore } from "./run-store.js";

const USAGE =
  "usage: odw digest [--since 12h | --since-last] [--workflow W] [--json | --markdown] [--notify] [--config P] [--runs-root DIR]";

/** The window without --since or a mark: a day. */
export const DIGEST_DEFAULT_SECONDS = 24 * 3600;
/** Where the digest keeps its marks, under the runs root. */
export const DIGEST_DIR = "_digest";
export const MARKS_FILE = "marks.json";
/** Discord takes at most this many characters of `content`. */
const CONTENT_MAX = 2000;

/** `90m`, `12h`, `2d`, `1w` → seconds; null when malformed. */
export function parseSince(text: string): number | null {
  const m = /^(\d+(?:\.\d+)?)([mhdw])$/.exec(text.trim());
  if (!m) return null;
  const unit = { m: 60, h: 3600, d: 86_400, w: 604_800 }[m[2] as "m" | "h" | "d" | "w"];
  const seconds = Number(m[1]) * unit;
  return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}

const markKey = (workflow: string | null) => (workflow === null ? "*" : `workflow:${workflow}`);

/** When the last digest sent for `workflow` (null: all runs) ended, Unix seconds; null before the first. */
export function readMark(root: string, workflow: string | null): number | null {
  const file = readJsonFile<{ marks?: Record<string, { at?: unknown }> }>(join(root, DIGEST_DIR, MARKS_FILE));
  const at = file?.marks?.[markKey(workflow)]?.at;
  return typeof at === "number" && Number.isFinite(at) ? at : null;
}

/** A marks lock this old was left by a digest that died holding it. */
const MARK_LOCK_STALE_MS = 10_000;

/**
 * Record that a digest for `workflow` was sent, up to `at`: read, changed and
 * written back (atomically) under `marks.json.lock`, taken with O_EXCL, so two
 * digests sent at once — each for its own `--workflow` — both keep their mark.
 * A lock older than {@link MARK_LOCK_STALE_MS} is taken over.
 */
export function writeMark(root: string, workflow: string | null, at: number): void {
  const dir = join(root, DIGEST_DIR);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, MARKS_FILE);
  const lock = `${path}.lock`;
  const token = `${process.pid}.${Math.random().toString(36).slice(2)}\n`;
  for (let waited = 0; ; waited += 20) {
    try {
      writeFileSync(lock, token, { flag: "wx", mode: 0o600 });
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
    let age = 0;
    try {
      age = Date.now() - statSync(lock).mtimeMs;
    } catch {
      continue; // released meanwhile
    }
    if (age > MARK_LOCK_STALE_MS || waited > MARK_LOCK_STALE_MS * 2) rmSync(lock, { force: true });
    else Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  }
  try {
    const file = readJsonFile<{ marks?: Record<string, unknown> }>(path);
    const marks = file?.marks !== null && typeof file?.marks === "object" ? file.marks : {};
    writeJsonAtomic(path, { version: 1, marks: { ...marks, [markKey(workflow)]: { at } } }, 2);
  } finally {
    // Only while it is still ours: one taken over as stale is another digest's now.
    try {
      if (readFileSync(lock, "utf8") === token) rmSync(lock, { force: true });
    } catch {
      // gone already
    }
  }
}

export interface DigestRequest {
  config: Config;
  store: RunStore;
  /** Seconds back from now; ignored with `sinceLast`. */
  sinceSeconds?: number | null;
  sinceLast?: boolean;
  workflow?: string | null;
  /** Appended to every printed command. */
  flags?: string[];
  /** Unix seconds; default now. */
  now?: number;
}

/** Collect a digest for a request: the window from `--since`, the mark, or the default day. */
export function digestFor(req: DigestRequest): Digest {
  const until = req.now ?? Date.now() / 1000;
  const workflow = req.workflow ?? null;
  const mark = req.sinceLast ? readMark(req.store.root, workflow) : null;
  const since = mark ?? until - (req.sinceSeconds ?? DIGEST_DEFAULT_SECONDS);
  return collectDigest(req.store, { since, until, sinceLast: mark !== null, workflow, flags: req.flags ?? [] });
}

/** Why `--notify` cannot send anything with this config; null when it can. */
export function cannotNotify(config: Config): string | null {
  const notify = config.settings.notify;
  if (!notify || (!notify.command && !notify.webhook)) return `no "notify" hook is configured, so there is nothing to send the digest to`;
  if (!notify.on.includes("digest")) return `"notify.on" does not list "digest", so no hook sends it — add "digest" to it`;
  return null;
}

/**
 * Send a digest through the `notify` hooks and, when every one succeeded,
 * move the mark `--since-last` starts from. Resolves to whether it was sent.
 */
export async function sendDigest(
  digest: Digest,
  options: { config: Config; store: RunStore; log?: (line: string) => void; webhookTimeoutMs?: number; commandTimeoutSec?: number },
): Promise<boolean> {
  const { config, store } = options;
  // The digest leaves the machine: its likely secrets out first; the links after (they are no secret of a run's).
  const sent: Digest = { ...redactorFor(config).record(digest) };
  let linksUnavailable: string | null = null;
  sent.needsYou = sent.needsYou.map((w) => {
    const links = mintCheckpointLinks(store.root, w.runId, w.checkpointId, config.settings.approveLinks.ttl);
    if (!links.ok) {
      linksUnavailable = links.reason;
      return w;
    }
    return { ...w, approveUrl: links.links.approveUrl, rejectUrl: links.links.rejectUrl };
  });
  const markdown = digestMarkdown(sent);
  const line = digestLine(sent);
  // The runs root's absolute path stays on this machine: `--json` prints it, the webhook does not send it.
  const { runsRoot: _runsRoot, ...shared } = sent;
  const payload: Record<string, unknown> = {
    kind: "digest",
    state: "digest",
    ...shared,
    ...(linksUnavailable && sent.needsYou.length ? { linksUnavailable } : {}),
    markdown,
    // As notify's own lines (see ./notify): Slack's text escaped, Discord's mentions and links broken.
    text: slackText(markdown),
    content: (() => {
      const content = discordContent(markdown);
      return content.length > CONTENT_MAX ? `${content.slice(0, CONTENT_MAX - 1)}…` : content;
    })(),
    allowed_mentions: { parse: [] },
  };
  const dir = mkdtempSync(join(tmpdir(), "odw-digest-"));
  try {
    const jsonFile = join(dir, "digest.json");
    const mdFile = join(dir, "digest.md");
    writeFileSync(jsonFile, JSON.stringify(sent, null, 2) + "\n", { mode: 0o600 });
    writeFileSync(mdFile, markdown + "\n", { mode: 0o600 });
    const ok = await notifyDigest(
      config.settings.notify,
      {
        payload,
        env: {
          ODW_RUN_STATE: "digest",
          ODW_DIGEST_TEXT: line.replace(/\0/g, ""),
          ODW_DIGEST_FILE: jsonFile,
          ODW_DIGEST_MARKDOWN_FILE: mdFile,
          ODW_DIGEST_SINCE: String(Math.floor(digest.since)),
          ODW_DIGEST_NEEDS_YOU: String(digest.needsYou.length),
          ODW_DIGEST_FAILED: String(digest.failed.length),
        },
      },
      {
        ...(options.log ? { log: options.log } : {}),
        ...(options.webhookTimeoutMs !== undefined ? { webhookTimeoutMs: options.webhookTimeoutMs } : {}),
        ...(options.commandTimeoutSec !== undefined ? { commandTimeoutSec: options.commandTimeoutSec } : {}),
      },
    );
    if (ok) writeMark(store.root, digest.workflow, digest.until);
    return ok;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** `odw digest …`; returns the exit code. */
export async function cmdDigest(rest: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      since: { type: "string" },
      "since-last": { type: "boolean" },
      workflow: { type: "string" },
      json: { type: "boolean" },
      markdown: { type: "boolean" },
      notify: { type: "boolean" },
      config: { type: "string" },
      "runs-root": { type: "string" },
    },
  });
  if (positionals.length > 0) return usage(`odw digest: unexpected argument '${positionals[0]}'\n${USAGE}`);
  if (values.since !== undefined && values["since-last"]) return usage(`odw digest: --since and --since-last contradict each other\n${USAGE}`);
  if (values.json && values.markdown) return usage(`odw digest: pick one of --json and --markdown\n${USAGE}`);
  let sinceSeconds: number | null = null;
  if (values.since !== undefined) {
    sinceSeconds = parseSince(values.since);
    if (sinceSeconds === null) return usage(`odw digest: --since takes an age like 90m, 12h, 2d or 1w; got ${JSON.stringify(values.since)}`);
  }
  if (values.workflow !== undefined && values.workflow.trim() === "") return usage(`odw digest: --workflow needs a name\n${USAGE}`);
  const config = loadConfig(values.config ?? null, { quiet: true });
  const store = new RunStore(values["runs-root"] ?? resolveRunsRoot(config.settings.runsRoot));
  const digest = digestFor({
    config,
    store,
    sinceSeconds,
    sinceLast: values["since-last"] === true,
    workflow: values.workflow ?? null,
    flags: values["runs-root"] ? ["--runs-root", resolve(values["runs-root"])] : [],
  });
  if (values.json) process.stdout.write(JSON.stringify(digest, null, 2) + "\n");
  else if (values.markdown) process.stdout.write(digestMarkdown(digest) + "\n");
  else process.stdout.write(formatDigest(digest, detectCaps(process.stdout, process.env)) + "\n");
  if (!values.notify) return 0;
  const why = cannotNotify(config);
  if (why) {
    process.stderr.write(`odw digest --notify: ${why}\n`);
    return 1;
  }
  const ok = await sendDigest(digest, { config, store });
  process.stderr.write(ok ? `odw digest: sent — ${digestLine(digest)}\n` : `odw digest: a notify hook failed (see above); the mark did not move\n`);
  return ok ? 0 : 1;
}

function usage(text: string): number {
  process.stderr.write(`${text}\n`);
  return 2;
}
