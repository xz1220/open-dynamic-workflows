/**
 * `odw doctor` — is this machine ready to run workflows?
 *
 * A checklist, cheapest first: the Node runtime, the config file, the run
 * directory, the workflow directories, and every configured adapter (installed?
 * answers `--version`?). With `--smoke` it goes one step further and sends a
 * real one-line prompt through the same bridge a workflow uses — the only way
 * to learn that a CLI which installs fine still blocks on an approval prompt,
 * needs a login, or exits 0 without answering when run headless. That costs a
 * model call, so it is opt-in.
 *
 * Reporting only: nothing here touches config, runs or adapters (the run
 * directory is created if missing, exactly as the first run would).
 */

import { mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

import {
  listAdapters,
  resolveClaudeWorkflowsRoot,
  resolveRunsRoot,
  resolveWorkflowsRoot,
} from "./adapters/config.js";
import { isOnPath } from "./adapters/executable.js";
import { runCommand, type CommandRunner } from "./adapters/runner.js";
import { trustBanner } from "./adapters/trust.js";
import { EGRESS_PROBE } from "./adapters/egress.js";
import { EgressProxies } from "./adapters/egress-run.js";
import {
  clientEnv,
  describeContainer,
  describeNetwork,
  egressDnsArgs,
  egressOf,
  planSandbox,
  resolveEngine,
  sandboxProblem,
  type SandboxEngine,
} from "./adapters/sandbox.js";
import type { Adapter, Config, ContainerSandbox, PermissionTier } from "./adapters/types.js";
import { loginCheckArgv } from "./adapters/accounts.js";
import { Bridge } from "./bridge.js";
import { redactorFor, type RedactionCoverage } from "./redact.js";
import { otelCheck } from "./runtime/otel-export.js";
import { describeConcurrency } from "./throttle.js";
import { resolveRunTrust } from "./untrusted.js";

export type CheckStatus = "ok" | "warn" | "fail" | "skip";

export interface DoctorCheck {
  id: string;
  title: string;
  status: CheckStatus;
  detail: string;
  /** What to do about a warn/fail. */
  hint?: string;
  /** Adapter checks: the permission tiers it declares flags for (ODW extension). */
  tiers?: PermissionTier[];
  /** Adapter checks: how it runs untrusted — its flags, or that it has no documented way (ODW extension). */
  untrusted?: string;
}

export interface DoctorReport {
  ok: boolean;
  checks: DoctorCheck[];
}

export interface DoctorOptions {
  /** The loaded config, or the error that loading it raised. */
  config: Config | Error;
  configPath: string | null;
  /** Project directory (workflow lookup + smoke-test workspace). */
  cwd: string;
  /** Adapters to smoke-test with a real prompt; empty = none. */
  smoke: string[];
  /** Seconds per smoke prompt. */
  smokeTimeout?: number;
  runner?: CommandRunner;
  nodeVersion?: string;
  /** The environment runs would start agents with; defaults to this process's. */
  env?: Record<string, string | undefined>;
}

/** The marker a smoke prompt asks for — unlikely to appear by accident. */
export const SMOKE_TOKEN = "ODW_DOCTOR_OK";

const MIN_NODE_MAJOR = 20;

export async function runDoctor(opts: DoctorOptions): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  const add = (c: DoctorCheck) => checks.push(c);
  const runner = opts.runner ?? runCommand;

  const nodeVersion = opts.nodeVersion ?? process.versions.node;
  const major = Number(nodeVersion.split(".")[0]);
  add({
    id: "node",
    title: "Node.js runtime",
    status: major >= MIN_NODE_MAJOR ? "ok" : "fail",
    detail: `v${nodeVersion} on ${process.platform}-${process.arch}`,
    hint: major >= MIN_NODE_MAJOR ? undefined : `odw needs Node ${MIN_NODE_MAJOR} or newer`,
  });

  if (opts.config instanceof Error) {
    add({
      id: "config",
      title: "Config",
      status: "fail",
      detail: opts.config.message,
      hint: "fix the file above, or move it aside to fall back to the built-in defaults",
    });
    return { ok: false, checks };
  }
  const config = opts.config;
  add({ id: "config", title: "Config", status: "ok", detail: opts.configPath ?? "built-in defaults" });

  const runsRoot = resolveRunsRoot(config.settings.runsRoot);
  try {
    mkdirSync(runsRoot, { recursive: true });
    const probe = join(runsRoot, `.odw-doctor-${process.pid}`);
    writeFileSync(probe, "ok");
    rmSync(probe, { force: true });
    add({ id: "runs-root", title: "Run directory", status: "ok", detail: runsRoot });
  } catch (err) {
    add({
      id: "runs-root",
      title: "Run directory",
      status: "fail",
      detail: `${runsRoot}: ${(err as Error).message}`,
      hint: "set runsRoot in your config (or --runs-root) to a writable directory",
    });
  }

  const roots = [
    join(opts.cwd, ".odw", "workflows"),
    join(opts.cwd, ".claude", "workflows"),
    resolveWorkflowsRoot(config.settings.workflowsRoot),
    resolveClaudeWorkflowsRoot(config.settings.claudeWorkflowsRoot),
  ];
  const present = roots.filter((r) => existsSync(r));
  add({
    id: "workflow-dirs",
    title: "Workflow directories",
    status: "ok",
    detail: present.length ? present.join(", ") : "none yet — `odw run <file.js>` still works",
  });

  const listing = listAdapters(config);
  const installed = listing.filter((a) => a.installed);
  const def = config.settings.defaultAdapter;
  const defListing = def ? listing.find((a) => a.name === def) : undefined;
  add({
    id: "default-adapter",
    title: "Default adapter",
    status: !def ? "warn" : defListing?.installed ? "ok" : "fail",
    detail: !def
      ? `not set (${installed.length} installed: ${installed.map((a) => a.name).join(", ") || "none"})`
      : defListing
        ? `${def}${defListing.installed ? "" : " — not found on PATH"}`
        : `${def} — not a configured adapter`,
    hint: !def
      ? "run `odw init` to pick one, or pass --adapter; bare agent() calls need it"
      : defListing?.installed
        ? undefined
        : "install that CLI, or run `odw init` to choose an installed one",
  });

  // The caps a run's agents get, per adapter too, and how rate limits and fan-outs move them (ODW extensions).
  add({ id: "concurrency", title: "Concurrency", status: "ok", detail: describeConcurrency(config, { details: true }) });

  // Whether what runs keep and serve has its likely secrets redacted (ODW extension; see ./redact).
  add(redactionCheck(redactorFor(config, opts.env ?? process.env).coverage));

  // Whether each run's trace is exported, and where to: scheme and host only (ODW extension).
  add(otelCheck(config, opts.env ?? process.env));

  // The run's trust, and how an untrusted run keeps the repository out of each installed CLI (ODW extension).
  add(trustCheck(config, opts.cwd, opts.configPath));

  // Where agents run: on this machine, or in a container — its engine, image and a smoke run (ODW extension).
  for (const check of await sandboxChecks(config, runner, opts.env ?? process.env)) add(check);

  for (const a of listing) {
    // The permission tiers it can run (ODW extension): `odw run --permissions`
    // refuses read on an adapter without it, and runs full as edit — and how
    // it runs untrusted (`odw run --untrusted`).
    const tiers =
      (a.tiers.length > 0 ? `tiers: ${a.tiers.join(", ")}` : "tiers: none declared (runs as configured)") +
      ` · untrusted: ${a.untrusted}`;
    if (!a.installed) {
      add({
        id: `adapter:${a.name}`,
        title: `Adapter ${a.name}`,
        status: "skip",
        detail: `not installed · ${tiers}`,
        tiers: a.tiers,
        untrusted: a.untrusted,
      });
      continue;
    }
    // An account (ODW extension; see adapters/accounts.ts): its CLI is its adapter's — is its login there?
    if (config.adapters[a.name]!.account) {
      add(await loginCheck(config.adapters[a.name]!, runner, opts.env ?? process.env));
      continue;
    }
    const exe = config.adapters[a.name]!.command[0]!;
    const res = await runner([exe, "--version"], { timeout: 15 });
    const line = (res.stdout || res.stderr).trim().split("\n")[0]?.slice(0, 80) ?? "";
    add({
      id: `adapter:${a.name}`,
      title: `Adapter ${a.name}`,
      status: res.returncode === 0 ? "ok" : "warn",
      detail: `${res.returncode === 0 ? line || "installed" : `\`${exe} --version\` exited ${res.returncode}`} · ${a.permissionNote} · ${tiers}`,
      hint: res.returncode === 0 ? undefined : "the CLI is on PATH but did not answer --version; try running it once by hand",
      tiers: a.tiers,
      untrusted: a.untrusted,
    });
  }

  // An adapter with accounts is smoke-tested on each of them (ODW extension: accounts).
  const smoke = [...new Set(opts.smoke.flatMap((name) => config.accounts?.[name] ?? [name]))];
  for (const name of smoke) {
    const listingFor = listing.find((a) => a.name === name);
    if (!listingFor) {
      add({ id: `smoke:${name}`, title: `Smoke ${name}`, status: "fail", detail: "not a configured adapter" });
      continue;
    }
    if (!listingFor.installed) {
      add({ id: `smoke:${name}`, title: `Smoke ${name}`, status: "skip", detail: "not installed" });
      continue;
    }
    // One try: a smoke check reports a rate limit, it does not wait one out.
    const smokeConfig: Config = {
      ...config,
      settings: { ...config.settings, timeout: opts.smokeTimeout ?? 180, schemaRetries: 0, transientRetries: 0 },
    };
    const bridge = new Bridge(smokeConfig, { source: opts.cwd, runner });
    const started = Date.now();
    try {
      const outcome = await bridge.run({
        prompt: `This is a connectivity check. Reply with exactly ${SMOKE_TOKEN} and nothing else. Do not use any tools.`,
        adapter: name,
        label: "doctor",
      });
      const secs = ((Date.now() - started) / 1000).toFixed(1);
      const text = String(outcome.text ?? "");
      const answered = text.includes(SMOKE_TOKEN);
      add({
        id: `smoke:${name}`,
        title: `Smoke ${name}`,
        status: answered ? "ok" : "fail",
        detail: answered
          ? `answered headless in ${secs}s`
          : `exited cleanly but did not answer (${JSON.stringify(text.trim().slice(0, 80))})`,
        hint: answered
          ? undefined
          : "a CLI that exits 0 without answering usually needs a login, a trust prompt, or an approval mode for headless use",
      });
    } catch (err) {
      add({
        id: `smoke:${name}`,
        title: `Smoke ${name}`,
        status: "fail",
        detail: (err as Error).message.split("\n")[0]!.slice(0, 160),
        hint: "run the adapter's command by hand in this directory to see what it is waiting for",
      });
    } finally {
      // A sandbox's egress proxy, if the smoke run started one (ODW extension).
      await bridge.closeEgress();
    }
  }

  return { ok: !checks.some((c) => c.status === "fail"), checks };
}

/**
 * An account's login check (ODW extension; see adapters/accounts.ts): its
 * CLI's own non-model status command (`claude auth status`, `codex login
 * status`) run with the account's config directory — "not checked" for a CLI
 * that has none. Not logged in is a warning: the run's other accounts may be.
 */
export async function loginCheck(
  adapter: Adapter,
  runner: CommandRunner,
  env: Record<string, string | undefined> = process.env,
): Promise<DoctorCheck> {
  const account = adapter.account!;
  const check = { id: `login:${adapter.name}`, title: `Account ${adapter.name}` };
  const where = `${account.dirEnv}=${account.configDir}`;
  const argv = loginCheckArgv(adapter);
  if (!argv) return { ...check, status: "skip", detail: `${where} · login not checked — ODW knows no login check of ${adapter.command[0]}` };
  const base: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) if (value !== undefined) base[name] = value;
  const res = await runner(argv, { timeout: 15, env: { ...base, ...adapter.env } });
  const said = (res.stdout || res.stderr).trim().split("\n")[0]?.slice(0, 80) ?? "";
  if (res.returncode === 0) return { ...check, status: "ok", detail: `${where} · logged in (\`${argv.slice(1).join(" ")}\`)` };
  const login = argv[1] === "auth" ? `${argv[0]} auth login` : `${argv[0]} login`;
  return {
    ...check,
    status: "warn",
    detail: `${where} · not logged in (\`${argv.slice(1).join(" ")}\` exited ${res.returncode}${said ? `: ${said}` : ""})`,
    hint: `log it in: ${where} ${login} — until then its agents move to the adapter's other accounts`,
  };
}

/**
 * The trust check (ODW extension; see adapters/trust.ts): the config's trust
 * and how an untrusted run keeps the repository out of each installed CLI —
 * a warning when an untrusted config is the repository's own.
 */
export function trustCheck(config: Config, cwd: string, configPath: string | null): DoctorCheck {
  const check = { id: "trust", title: "Trust" };
  const run = resolveRunTrust({ flag: null, config, configPath, source: cwd, cwd });
  const untrusted: Config = { ...config, settings: { ...config.settings, trust: "untrusted" } };
  const how = trustBanner(untrusted, (adapter) => isOnPath(adapter.command[0]!)).replace(/^trust: untrusted( — )?/, "");
  const detail = `${run.trust}${run.why ? ` (${run.why})` : ""} — odw run --untrusted runs ${how || "no installed adapter"}`;
  if (run.trust === "untrusted" && run.repositoryConfig) {
    return {
      ...check,
      status: "warn",
      detail,
      hint:
        `the config in use is the repository's own (${run.repositoryConfig}): an untrusted run reads it only when you name it ` +
        `(--config, $ODW_CONFIG) — found by itself, it is skipped for your ~/.config/odw/config.json or the defaults`,
    };
  }
  return { ...check, status: "ok", detail };
}

/**
 * The sandbox checks (ODW extension; see adapters/sandbox.ts): with no
 * container anywhere, one line saying agents run on this machine. Else, for
 * the run's container and each adapter's own: the engine is on PATH, the
 * image is present (never pulled), and a smoke run — `<engine> run --rm
 * --pull never --network none <image> true`, no model involved — starts and
 * exits 0. A failure is a `fail`: such a run would stop before its first agent.
 * A box with an egress allowlist then gets an egress check ({@link egressCheck}).
 */
export async function sandboxChecks(
  config: Config,
  runner: CommandRunner,
  env: Record<string, string | undefined> = process.env,
  onPath: (cmd: string) => boolean = isOnPath,
  platform: NodeJS.Platform = process.platform,
): Promise<DoctorCheck[]> {
  const run = config.settings.sandbox ?? "none";
  const boxes: Array<{ id: string; title: string; box: ContainerSandbox }> = [];
  if (run !== "none") boxes.push({ id: "sandbox", title: "Sandbox", box: run });
  for (const adapter of Object.values(config.adapters)) {
    const box = adapter.sandbox ? planSandbox(run, adapter).box : null;
    if (box) boxes.push({ id: `sandbox:${adapter.name}`, title: `Sandbox ${adapter.name}`, box });
  }
  if (boxes.length === 0) {
    return [
      {
        id: "sandbox",
        title: "Sandbox",
        status: "ok",
        detail: "none — agents run on this machine as you (odw run --sandbox container runs them in a container)",
      },
    ];
  }
  const checks: DoctorCheck[] = [];
  const smoked = new Map<string, DoctorCheck>();
  const probed = new Map<string, DoctorCheck>();
  for (const { id, title, box } of boxes) {
    const what = describeContainer(box, onPath);
    const engine = resolveEngine(box, onPath);
    const key = `${engine}\u0000${box.image}`;
    // An egress allowlist (ODW extension): once the box runs, its proxy is tried with a smoke request each way.
    const egress = egressOf(box.network);
    const probe = async (ran: DoctorCheck): Promise<void> => {
      if (!egress || ran.status !== "ok" || !engine) return;
      const probeKey = JSON.stringify([key, egress]);
      const known = probed.get(probeKey) ?? { id, title, ...(await egressCheck(box, engine, runner, env)) };
      probed.set(probeKey, known);
      checks.push({ ...known, id: `${id}:egress`, title: `${title} egress` });
    };
    const known = smoked.get(key);
    if (known) {
      checks.push({ ...known, id, title });
      await probe(known);
      continue;
    }
    let check: DoctorCheck;
    const problem = await sandboxProblem(box, runner, env, onPath, platform);
    if (problem || !engine) {
      check = {
        id,
        title,
        status: "fail",
        detail: `${what} — ${problem ?? "no container engine"}`,
        hint: problem?.includes("image")
          ? `build it: ${engine ?? "docker"} build -t ${box.image} examples/sandbox (it must hold the agent CLIs)`
          : "install Docker or Podman, or set sandbox.engine",
      };
    } else {
      const smoke = await runner([engine, "run", "--rm", "--pull", "never", "--network", "none", box.image, "true"], {
        timeout: 60,
        env: clientEnv(env),
      });
      const said = (smoke.stderr || smoke.stdout).trim().split("\n")[0]?.slice(0, 160) ?? "";
      check =
        smoke.returncode === 0
          ? { id, title, status: "ok", detail: `${what} — engine found, image present, \`${engine} run --rm ${box.image} true\` ran` }
          : {
              id,
              title,
              status: "fail",
              detail: `${what} — \`${engine} run --rm ${box.image} true\` exited ${smoke.returncode}${said ? `: ${said}` : ""}`,
              hint: `run it by hand to see why; the image needs a \`true\` on its PATH, and ${engine} must be able to start containers`,
            };
    }
    smoked.set(key, check);
    checks.push(check);
    await probe(check);
  }
  return checks;
}

/** The host the doctor's probe asks for to be refused: reserved (RFC 2606), so never on a list by accident. */
export const PROBE_DENIED = "odw-egress-check.invalid:443";

/** The outside name the doctor's probe looks up in the agent's container: it must not resolve there. */
export const PROBE_DNS = "dns:example.com";

/**
 * The egress check (ODW extension; see adapters/egress-run.ts): bring up the
 * box's internal network and proxy as a run would, and from a container on
 * that network ask the proxy for a CONNECT to the first host the allowlist
 * names (it must answer 200: allowed, and reached) and to a reserved host
 * that no list holds (403: refused), and look up an outside name in it (it
 * must not resolve: the proxy resolves names, and DNS out of the container
 * would be a channel for data). The proxy and network go at the end.
 */
export async function egressCheck(
  box: ContainerSandbox,
  engine: SandboxEngine,
  runner: CommandRunner,
  env: Record<string, string | undefined> = process.env,
): Promise<Omit<DoctorCheck, "id" | "title">> {
  const egress = egressOf(box.network)!;
  const proxies = new EgressProxies({ runner, runId: "doctor", hostEnv: env });
  const named = egress.allow.find((entry) => !entry.startsWith("*."));
  const allowed = named === undefined ? null : (named.startsWith("[") ? /\]:\d+$/.test(named) : named.includes(":")) ? named : `${named}:443`;
  const list = describeNetwork(box.network);
  try {
    const handle = await proxies.for(engine, box.image, egress);
    const vars = proxies.env(handle, "doctor");
    // On the internal network as an agent's container is: with its resolver too.
    const argv = [engine, "run", "--rm", "--pull", "never", "--network", handle.network, ...egressDnsArgs(engine), "--cap-drop", "ALL", "--security-opt", "no-new-privileges"];
    for (const [name, value] of Object.entries(vars)) argv.push("--env", `${name}=${value}`);
    argv.push("--entrypoint", "node", egress.proxyImage ?? box.image, "-e", EGRESS_PROBE, PROBE_DENIED, PROBE_DNS, ...(allowed ? [allowed] : []));
    const ran = await runner(argv, { timeout: 90, env: clientEnv(env) });
    let answers: Record<string, number> = {};
    try {
      answers = JSON.parse(ran.stdout.trim().split("\n").pop() ?? "") as Record<string, number>;
    } catch {
      const said = (ran.stderr || ran.stdout).trim().split("\n")[0]?.slice(0, 160) ?? "";
      return {
        status: "fail",
        detail: `${list} — the probe on the internal network did not run (exit ${ran.returncode})${said ? `: ${said}` : ""}`,
        hint: "the probe and the proxy need node in the image (or set network.proxyImage to one with node)",
      };
    }
    if (answers[PROBE_DENIED] !== 403) {
      return {
        status: "fail",
        detail: `${list} — the proxy answered ${answers[PROBE_DENIED] || "nothing"} for ${PROBE_DENIED}, not 403`,
        hint: "the egress proxy must refuse hosts off its list: run `odw doctor` again, and report it if it persists",
      };
    }
    if (answers[PROBE_DNS] !== 0) {
      const name = PROBE_DNS.slice(4);
      return {
        status: "fail",
        detail: `${list} — ${answers[PROBE_DNS] === 1 ? `${name} resolves` : `could not tell whether ${name} resolves`} in a container on the internal network: DNS can carry data out around the proxy`,
        hint:
          engine === "docker"
            ? "Docker before 26.0 (and 25.0.5, 23.0.11) forwards an internal network's DNS through the host (CVE-2024-29018): upgrade Docker"
            : "the engine's DNS forwards lookups out of an internal network: upgrade it, or keep the host's resolver off loopback",
      };
    }
    if (allowed === null) {
      return { status: "ok", detail: `${list} — the proxy refused ${PROBE_DENIED} and ${PROBE_DNS.slice(4)} did not resolve; the list has only wildcards, so no allowed host was tried` };
    }
    const got = answers[allowed];
    if (got === 200) return { status: "ok", detail: `${list} — through the proxy ${allowed} was reached and ${PROBE_DENIED} refused; ${PROBE_DNS.slice(4)} did not resolve in the container` };
    return {
      status: "warn",
      detail: `${list} — the proxy refused ${PROBE_DENIED}, but answered ${got || "nothing"} for ${allowed}${got === 502 ? " (it could not reach it)" : ""}`,
      hint: "check that this machine can reach that host (DNS, firewall); the proxy resolves names itself",
    };
  } catch (err) {
    return {
      status: "fail",
      detail: `${list} — ${(err as Error).message.split("\n")[0]!.slice(0, 200)}`,
      hint: "the egress proxy runs in the agent's image (it needs node) or network.proxyImage; the engine must create internal networks",
    };
  } finally {
    await proxies.close();
  }
}

/** Variables the redaction check names before it says how many more. */
const VARIABLES_SHOWN = 5;

/**
 * The redaction check (ODW extension): what is redacted from what runs keep
 * and serve — or, with `redact: false` (or every part of it off), a warning.
 */
export function redactionCheck(coverage: RedactionCoverage): DoctorCheck {
  const check = { id: "redaction", title: "Redaction" };
  const parts: string[] = [];
  if (coverage.env) {
    const names = coverage.variables;
    const shown = names.slice(0, VARIABLES_SHOWN).join(", ");
    const more = names.length > VARIABLES_SHOWN ? `, and ${names.length - VARIABLES_SHOWN} more` : "";
    parts.push(
      names.length === 0
        ? "NAME=value of secret-looking names (no secret-named variable in this environment)"
        : `the values of ${names.length} secret-named variable${names.length === 1 ? "" : "s"} (${shown}${more}), NAME=value of secret-looking names`,
    );
  }
  if (coverage.patterns) parts.push("token shapes");
  if (coverage.extra > 0) parts.push(`${coverage.extra} extra pattern${coverage.extra === 1 ? "" : "s"}`);
  if (coverage.off || parts.length === 0) {
    return {
      ...check,
      status: "warn",
      detail: coverage.off ? 'off ("redact": false)' : "nothing to look for (redact.env and redact.patterns are false, no extra)",
      hint: `secrets agents print are kept and served in clear — ${
        coverage.off ? 'remove "redact": false from the config' : 'set "redact.env" or "redact.patterns" back to true'
      }`,
    };
  }
  return { ...check, status: "ok", detail: `on — ${parts.join(", ")}` };
}
