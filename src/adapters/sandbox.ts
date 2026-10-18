/**
 * The container sandbox (an ODW extension): run agent CLIs in a container.
 *
 * Without it ODW runs each agent CLI on this machine, as you, confined only by
 * the CLI's own permission flags (./permissions). With `sandbox: { kind:
 * "container", image }` in the config, `odw run --sandbox container`, an
 * adapter's `sandbox` or an agent()'s, each CLI run becomes
 *
 *   <engine> run --rm -i --init --pull never --name odw-<run>-<agent>-<rand> …  <image> <the CLI's argv>
 *
 * on Docker or Podman, with:
 *
 *   - the agent's workspace (its worktree, or the run's source) bound
 *     read-write at the same path, and the working directory there — so
 *     diffs, transcripts, `expect` checks and `{workspace}` keep working;
 *   - nothing else of the host's filesystem but a private home and the files
 *     the CLI run itself needs (its prompt, schema and reply files) — and the
 *     `mounts` the config lists, read-only unless it says otherwise. The home
 *     is a fresh temporary directory, removed after the run, holding a copy of
 *     the CLI's own login and config files (`cliConfig: "copy"`, the default;
 *     {@link CLI_CONFIGS} names them from each CLI's docs), so the agent can
 *     read them but never change yours; `"mount-ro"` binds them read-only
 *     instead, `"none"` leaves the home empty (API keys in the environment);
 *   - your uid:gid (`--user`; Podman also `--userns keep-id`), so what it
 *     writes in the workspace is yours; no capabilities (`--cap-drop ALL`),
 *     `--security-opt no-new-privileges`, `--pids-limit` (512 by default),
 *     optional `--memory` and `--cpus`, a read-only root filesystem with a
 *     tmpfs `/tmp`, and an init process that forwards signals;
 *   - only the environment `agentEnv` lets through (./agent-env), passed by
 *     name (`--env NAME`, the value read from the engine client's own
 *     environment) so no secret appears in a process listing — less the
 *     host's paths (PATH, HOME, TMPDIR, XDG_*, the CLIs' config-dir variables);
 *   - the engine's default network (`network: "default"`: agent CLIs must
 *     reach their model API), none at all (`"none"`), or only the hosts of
 *     an allowlist (`{ allow: [...] }`): an internal network of the run's,
 *     whose way out is an egress proxy sidecar (./egress, ./egress-run).
 *     Nothing is published: a server the agent starts on its `ODW_PORT` is
 *     reachable only inside its container.
 *
 * A container is named by ODW and labelled `odw.run=<runId>`. A CLI run that
 * did not exit cleanly — a timeout, a stall, a stop, a crash — has its
 * container killed by name (`<engine> kill`, then `rm --force`): killing the
 * engine client alone would leave the container running. The worker's
 * backstop at exit does the same for every container still live.
 *
 * The image is the user's: it must hold the CLI, and is never pulled
 * (`--pull never`). A missing engine or image is a ConfigError — from `odw
 * doctor`, and before the first container starts.
 *
 * The argv is built by a pure function ({@link containerArgv}), unit-tested
 * without an engine.
 */

import { spawn } from "node:child_process";
import { existsSync, rmSync, statSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";

import { ConfigError } from "../errors.js";
import { globMatcher } from "./agent-env.js";
import { ADAPTER_HOSTS, buildEgressAllow, expandAdapterHosts, intersectAllow, type EgressAllow } from "./egress.js";
import { isOnPath } from "./executable.js";
import { onKillAll, type CommandRunner } from "./runner.js";
import type {
  Adapter,
  Config,
  ContainerSandbox,
  ContainerSpec,
  SandboxCliConfig,
  SandboxMount,
  SandboxNetwork,
  SandboxSetting,
} from "./types.js";

export type SandboxEngine = "docker" | "podman";

export const ENGINES: readonly SandboxEngine[] = ["docker", "podman"];

/** Where the container's home is bound: a private temporary directory of the host's. */
export const CONTAINER_HOME = "/odw/home";

/** `--pids-limit` when the config sets none: room for a CLI, its tools and a test run, not for a fork bomb. */
export const DEFAULT_PIDS = 512;

/** The container's `/tmp`: writable, executable (test runners build there), no setuid or devices. */
export const TMPFS = "/tmp:rw,nosuid,nodev,exec";

/** The defaults of a container sandbox's optional fields. */
export const CONTAINER_DEFAULTS: Omit<ContainerSandbox, "image"> = {
  kind: "container",
  engine: null,
  network: "default",
  mounts: [],
  cliConfig: "copy",
  memory: null,
  cpus: null,
  pids: DEFAULT_PIDS,
};

// --- config -------------------------------------------------------------------

const CONTAINER_KEYS = ["kind", "engine", "image", "network", "mounts", "cliConfig", "memory", "cpus", "pids"] as const;
const MOUNT_KEYS = ["source", "target", "readonly"] as const;
const NETWORKS: readonly SandboxNetwork[] = ["none", "default"];
const CLI_CONFIG_MODES: readonly SandboxCliConfig[] = ["copy", "mount-ro", "none"];

/** The run's `sandbox` setting, validated: `"none"`, or a container with an image. */
export function buildSandboxSetting(raw: unknown): SandboxSetting {
  if (raw === "none") return "none";
  const spec = buildContainerSpec(raw, '"sandbox"');
  if (spec.image === undefined) {
    throw new ConfigError(`"sandbox.image" is required: the image the agent CLIs run in (it must hold them; ODW never pulls it)`);
  }
  return { ...CONTAINER_DEFAULTS, ...spec, image: spec.image };
}

/** An adapter's `sandbox`, validated: the container fields it sets (`"none"` is not one: it may only tighten). */
export function buildAdapterSandbox(name: string, raw: unknown): ContainerSpec {
  if (raw === "none") {
    throw new ConfigError(
      `adapter '${name}' 'sandbox' cannot be "none": an adapter may only put its CLI in a container — leave it out to follow the run's`,
    );
  }
  return buildContainerSpec(raw, `adapter '${name}' 'sandbox'`);
}

/** `odw run --sandbox container [--sandbox-image <image>]` (ODW extension), as a run's meta keeps it. */
export interface SandboxFlag {
  kind: "container";
  image: string | null;
}

/** A run meta's `sandbox`, when it is one; null otherwise. */
export function sandboxFlagOf(raw: unknown): SandboxFlag | null {
  if (raw === null || typeof raw !== "object" || (raw as { kind?: unknown }).kind !== "container") return null;
  const image = (raw as { image?: unknown }).image;
  return { kind: "container", image: typeof image === "string" && image !== "" ? image : null };
}

/**
 * The run's sandbox under `--sandbox container`: the config's container
 * (`--sandbox-image` replacing its image), or a container of that image with
 * the defaults. Without an image from either, a ConfigError.
 */
export function withSandboxFlag(setting: SandboxSetting, flag: SandboxFlag | null): SandboxSetting {
  if (!flag) return setting;
  const image = flag.image === null ? null : buildImage(flag.image, "--sandbox-image");
  if (setting !== "none") return image ? { ...setting, image } : setting;
  if (!image) {
    throw new ConfigError(
      `--sandbox container needs an image: pass --sandbox-image <image>, or set "sandbox": { "kind": "container", "image": "<image>" } ` +
        `in odw.config.json (examples/sandbox/Dockerfile builds one)`,
    );
  }
  return { ...CONTAINER_DEFAULTS, image, mounts: [] };
}

/** Every adapter's sandbox has an image: its own, or the run's (checked once both are built). */
export function checkSandboxImages(config: Config): void {
  if (config.settings.sandbox !== "none") return;
  for (const adapter of Object.values(config.adapters)) {
    if (adapter.sandbox && adapter.sandbox.image === undefined) {
      throw new ConfigError(
        `adapter '${adapter.name}' 'sandbox' needs an "image" (the config's "sandbox" gives none): the image its CLI runs in`,
      );
    }
  }
}

/** Validate a container sandbox object; `where` names it in errors. Fields left out stay out. */
export function buildContainerSpec(raw: unknown, where: string): ContainerSpec {
  if (raw === "container") return { kind: "container" };
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ConfigError(`${where} must be "none" or { "kind": "container", "image": "<image>", … }; got ${JSON.stringify(raw)}`);
  }
  const spec = raw as Record<string, unknown>;
  for (const key of Object.keys(spec)) {
    if (!(CONTAINER_KEYS as readonly string[]).includes(key) && !key.startsWith("$") && !key.startsWith("//")) {
      throw new ConfigError(`${where} has an unknown field "${key}"; known: ${CONTAINER_KEYS.join(", ")}`);
    }
  }
  if (spec.kind !== "container") throw new ConfigError(`${where}.kind must be "container"; got ${JSON.stringify(spec.kind)}`);
  const out: ContainerSpec = { kind: "container" };
  if (spec.engine != null) {
    if (!(ENGINES as readonly unknown[]).includes(spec.engine)) {
      throw new ConfigError(`${where}.engine must be "docker" or "podman" (or left out: docker when installed, else podman); got ${JSON.stringify(spec.engine)}`);
    }
    out.engine = spec.engine as SandboxEngine;
  }
  if (spec.image != null) out.image = buildImage(spec.image, `${where}.image`);
  if (spec.network != null) out.network = buildNetwork(spec.network, `${where}.network`);
  if (spec.cliConfig != null) out.cliConfig = choice(spec.cliConfig, CLI_CONFIG_MODES, `${where}.cliConfig`);
  if (spec.mounts != null) {
    if (!Array.isArray(spec.mounts)) throw new ConfigError(`${where}.mounts must be a list of { "source", "target"?, "readonly"? }`);
    out.mounts = spec.mounts.map((mount, i) => buildMount(mount, `${where}.mounts[${i}]`));
  }
  if (spec.memory != null) out.memory = buildMemory(spec.memory, `${where}.memory`);
  if (spec.cpus != null) {
    if (typeof spec.cpus !== "number" || !(spec.cpus > 0) || !Number.isFinite(spec.cpus)) {
      throw new ConfigError(`${where}.cpus must be a positive number of CPUs; got ${JSON.stringify(spec.cpus)}`);
    }
    out.cpus = spec.cpus;
  }
  if (spec.pids != null) out.pids = buildPids(spec.pids, `${where}.pids`);
  return out;
}

/** `"none"`, `"default"`, or an egress allowlist `{ allow, proxyImage? }` (see ./egress). */
function buildNetwork(raw: unknown, where: string): SandboxNetwork {
  if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) return buildEgressAllow(raw as Record<string, unknown>, where);
  if ((NETWORKS as readonly unknown[]).includes(raw)) return raw as SandboxNetwork;
  throw new ConfigError(`${where} must be "none" or "default", or { "allow": ["api.anthropic.com", …] | "adapter" }; got ${JSON.stringify(raw)}`);
}

/** The allowlist of a network, or null when it is "none" or "default". */
export function egressOf(network: SandboxNetwork): EgressAllow | null {
  return typeof network === "object" ? network : null;
}

/**
 * The stricter of two networks: none over everything, an allowlist over the
 * default network, and of two allowlists the hosts both allow. `hosts` are
 * the adapter's (what `"adapter"` stands for).
 */
export function tighterNetwork(a: SandboxNetwork, b: SandboxNetwork | undefined, hosts?: readonly string[]): SandboxNetwork {
  if (b === undefined) return withHosts(a, hosts);
  if (a === "none" || b === "none") return "none";
  if (a === "default") return withHosts(b, hosts);
  if (b === "default") return withHosts(a, hosts);
  const proxyImage = b.proxyImage ?? a.proxyImage;
  return {
    allow: intersectAllow(expandAdapterHosts(a.allow, hosts), expandAdapterHosts(b.allow, hosts)),
    ...(proxyImage ? { proxyImage } : {}),
  };
}

/** A network with `"adapter"` replaced by the adapter's hosts. */
function withHosts(network: SandboxNetwork, hosts: readonly string[] | undefined): SandboxNetwork {
  if (typeof network !== "object" || !network.allow.includes(ADAPTER_HOSTS)) return network;
  return { ...network, allow: expandAdapterHosts(network.allow, hosts) };
}

function choice<T extends string>(raw: unknown, choices: readonly T[], where: string): T {
  if ((choices as readonly unknown[]).includes(raw)) return raw as T;
  throw new ConfigError(`${where} must be ${choices.map((c) => `"${c}"`).join(" or ")}; got ${JSON.stringify(raw)}`);
}

/** An image reference as the engines take it: one word, not an option. */
function buildImage(raw: unknown, where: string): string {
  if (typeof raw === "string" && /^[A-Za-z0-9][^\s]*$/.test(raw)) return raw;
  throw new ConfigError(`${where} must be an image reference such as "odw-agents:latest"; got ${JSON.stringify(raw)}`);
}

/** `--memory`: a whole number of bytes, or a number with a b, k, m or g suffix. */
function buildMemory(raw: unknown, where: string): string {
  const text = typeof raw === "number" && Number.isInteger(raw) && raw > 0 ? String(raw) : raw;
  if (typeof text === "string" && /^\d+(\.\d+)?[bkmg]?$/i.test(text) && memoryBytes(text) > 0) return text.toLowerCase();
  throw new ConfigError(`${where} must be a size such as "4g" or "512m" (or a whole number of bytes); got ${JSON.stringify(raw)}`);
}

function buildPids(raw: unknown, where: string): number {
  if (typeof raw === "number" && Number.isInteger(raw) && raw > 0) return raw;
  throw new ConfigError(`${where} must be a positive whole number of processes; got ${JSON.stringify(raw)}`);
}

/** A `--memory` size in bytes. */
export function memoryBytes(size: string): number {
  const match = /^(\d+(?:\.\d+)?)([bkmg]?)$/i.exec(size);
  if (!match) return NaN;
  const unit = { "": 1, b: 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3 }[match[2]!.toLowerCase() as "" | "b" | "k" | "m" | "g"];
  return Math.floor(Number(match[1]) * unit);
}

/**
 * A bind mount: an absolute (or `~/`) host path that exists, bound at
 * `target` (default: the same path), read-only unless `readonly: false`. No
 * comma in either path: `--mount` would read it as another field.
 */
function buildMount(raw: unknown, where: string): SandboxMount {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ConfigError(`${where} must be { "source": "/abs/path", "target"?: "/abs/path", "readonly"?: true }`);
  }
  const mount = raw as Record<string, unknown>;
  for (const key of Object.keys(mount)) {
    if (!(MOUNT_KEYS as readonly string[]).includes(key)) throw new ConfigError(`${where} has an unknown field "${key}"; known: ${MOUNT_KEYS.join(", ")}`);
  }
  const source = mountPath(mount.source, `${where}.source`, true);
  const target = mount.target == null ? source : mountPath(mount.target, `${where}.target`, false);
  if (mount.readonly != null && typeof mount.readonly !== "boolean") {
    throw new ConfigError(`${where}.readonly must be true or false; got ${JSON.stringify(mount.readonly)}`);
  }
  return { source, target, readonly: mount.readonly !== false };
}

function mountPath(raw: unknown, where: string, host: boolean): string {
  if (typeof raw !== "string" || raw === "") throw new ConfigError(`${where} must be an absolute path; got ${JSON.stringify(raw)}`);
  const path = host && (raw === "~" || raw.startsWith("~/")) ? join(homedir(), raw.slice(1)) : raw;
  if (!isAbsolute(path)) throw new ConfigError(`${where} must be an absolute path; got ${JSON.stringify(raw)}`);
  const problem = pathProblem(path);
  if (problem) throw new ConfigError(`${where} ${problem}; got ${JSON.stringify(raw)}`);
  return resolve(path);
}

/** Why a path cannot go in a `--mount` field, or null. */
export function pathProblem(path: string): string | null {
  return /[,\n\r\0]/.test(path) ? "cannot hold a comma or a line break (it goes in a --mount field)" : null;
}

// --- planning -----------------------------------------------------------------

/** What an agent()'s `sandbox` option may say (ODW extension): it may only tighten. */
export const CALL_KEYS = ["kind", "image", "network", "cliConfig", "memory", "cpus", "pids"] as const;

/** The sandbox one agent's CLI runs in, as {@link planSandbox} decides it. */
export interface SandboxPlan {
  /** The container, or null: on the host. */
  box: ContainerSandbox | null;
  /** Why the call may not have the sandbox it asked for (the call fails, before anything starts). */
  error?: string;
}

/**
 * The sandbox an agent on `adapter` runs in: the run's, with the adapter's
 * fields over it — its image, engine and cliConfig replace the run's, its
 * mounts add to them, and of network and the limits the stricter wins — and
 * then the call's own `option`, which may only tighten: turn the container on
 * (with an image when nothing above gives one), take the network away, lower
 * a limit, or drop the CLI's config. Anything else is an error, and so is a
 * malformed option.
 */
export function planSandbox(run: SandboxSetting, adapter: Pick<Adapter, "sandbox" | "egressHosts">, option?: unknown): SandboxPlan {
  let box: ContainerSandbox | null = run === "none" ? null : run;
  const spec = adapter.sandbox;
  const hosts = adapter.egressHosts;
  if (spec) {
    if (box) box = mergeSpec(box, spec, hosts);
    else if (spec.image) box = { ...CONTAINER_DEFAULTS, ...spec, image: spec.image, mounts: [...(spec.mounts ?? [])] };
  }
  // An allowlist's "adapter" stands for the hosts this adapter declares (see ./egress).
  if (box && egressOf(box.network)?.allow.includes(ADAPTER_HOSTS)) box = { ...box, network: withHosts(box.network, hosts) };
  if (option === undefined || option === null) return { box };
  const fail = (why: string): SandboxPlan => ({ box, error: `agent(): sandbox ${why}` });
  if (option === "none") {
    return box ? fail(`"none" cannot take this agent out of its container: a call may only tighten the sandbox`) : { box };
  }
  if (option === "container") {
    return box ? { box } : fail(`"container" needs an image: pass { image: "<image>" }, or set "sandbox" in odw.config.json`);
  }
  if (typeof option !== "object" || Array.isArray(option)) {
    return fail(`must be "none", "container" or { network, memory, cpus, pids, cliConfig, image }; got ${JSON.stringify(option)}`);
  }
  const ask = option as Record<string, unknown>;
  const unknown = Object.keys(ask).find((key) => !(CALL_KEYS as readonly string[]).includes(key));
  if (unknown) return fail(`has an unknown field "${unknown}" (a call may set ${CALL_KEYS.join(", ")}; mounts and engine are the config's)`);
  if (ask.kind !== undefined && ask.kind !== "container") return fail(`kind must be "container"; got ${JSON.stringify(ask.kind)}`);
  let spec2: ContainerSpec;
  try {
    spec2 = buildContainerSpec({ ...ask, kind: "container" }, "sandbox");
  } catch (err) {
    return fail((err as Error).message.replace(/^"?sandbox"?\.?/, ""));
  }
  if (spec2.image !== undefined && box && spec2.image !== box.image) {
    return fail(`image cannot change the image '${box.image}' the run or adapter set: a call may only tighten the sandbox`);
  }
  if (!box) {
    if (spec2.image === undefined) return fail(`needs an image: pass { image: "<image>" }, or set "sandbox" in odw.config.json`);
    return { box: { ...CONTAINER_DEFAULTS, ...spec2, image: spec2.image, mounts: [] } };
  }
  if (spec2.network === "default" && box.network !== "default") {
    return fail(
      box.network === "none"
        ? `network "default" would give this agent the network its sandbox has none of`
        : `network "default" would lift its sandbox's egress allowlist: a call may only tighten it`,
    );
  }
  if (typeof spec2.network === "object" && box.network === "none") {
    return fail(`network { allow } would give this agent the network its sandbox has none of`);
  }
  if (spec2.cliConfig !== undefined && spec2.cliConfig !== box.cliConfig && spec2.cliConfig !== "none") {
    return fail(`cliConfig may only be "none" (or the sandbox's own "${box.cliConfig}") in a call`);
  }
  if (spec2.memory != null && box.memory !== null && memoryBytes(spec2.memory) > memoryBytes(box.memory)) {
    return fail(`memory "${spec2.memory}" is more than the sandbox's "${box.memory}": a call may only lower it`);
  }
  if (spec2.cpus != null && box.cpus !== null && spec2.cpus > box.cpus) {
    return fail(`cpus ${spec2.cpus} is more than the sandbox's ${box.cpus}: a call may only lower it`);
  }
  if (spec2.pids !== undefined && spec2.pids > box.pids) return fail(`pids ${spec2.pids} is more than the sandbox's ${box.pids}: a call may only lower it`);
  return {
    box: {
      ...box,
      network: tighterNetwork(box.network, spec2.network, hosts),
      cliConfig: spec2.cliConfig ?? box.cliConfig,
      memory: spec2.memory ?? box.memory,
      cpus: spec2.cpus ?? box.cpus,
      pids: spec2.pids ?? box.pids,
    },
  };
}

/** The run's container with an adapter's fields over it (see {@link planSandbox}). */
function mergeSpec(box: ContainerSandbox, spec: ContainerSpec, hosts?: readonly string[]): ContainerSandbox {
  const lower = <T extends number>(a: T | null, b: T | null | undefined): T | null => (b == null ? a : a == null ? b : (Math.min(a, b) as T));
  const memory =
    spec.memory == null ? box.memory : box.memory == null || memoryBytes(spec.memory) < memoryBytes(box.memory) ? spec.memory : box.memory;
  return {
    ...box,
    engine: spec.engine ?? box.engine,
    image: spec.image ?? box.image,
    cliConfig: spec.cliConfig ?? box.cliConfig,
    network: tighterNetwork(box.network, spec.network, hosts),
    mounts: [...box.mounts, ...(spec.mounts ?? [])],
    memory,
    cpus: lower(box.cpus, spec.cpus),
    pids: lower(box.pids, spec.pids) ?? DEFAULT_PIDS,
  };
}

/** The engine a sandbox runs on: its own, else docker when it is on PATH, else podman when it is; null: neither. */
export function resolveEngine(box: Pick<ContainerSandbox, "engine">, onPath: (cmd: string) => boolean = isOnPath): SandboxEngine | null {
  if (box.engine) return box.engine;
  return ENGINES.find((engine) => onPath(engine)) ?? null;
}

/** What an agent's events and AgentView say of its sandbox (ODW extension). */
export interface SandboxView {
  kind: "container";
  engine: SandboxEngine | null;
  image: string;
  /** "allowlist": only the hosts of `allow`, through an egress proxy. */
  network: "none" | "default" | "allowlist";
  allow?: string[];
}

export function sandboxView(box: ContainerSandbox, onPath?: (cmd: string) => boolean): SandboxView {
  const egress = egressOf(box.network);
  return {
    kind: "container",
    engine: resolveEngine(box, onPath),
    image: box.image,
    ...(egress ? { network: "allowlist", allow: egress.allow } : { network: box.network as "none" | "default" }),
  };
}

/** A network in a few words: `default`, `none`, `allowlist (api.anthropic.com, claude.ai +1)`. */
export function describeNetwork(network: SandboxNetwork): string {
  const egress = egressOf(network);
  if (!egress) return network as string;
  if (egress.allow.length === 0) return "allowlist (empty: every host refused)";
  const shown = egress.allow.slice(0, 2).join(", ");
  return `allowlist (${shown}${egress.allow.length > 2 ? ` +${egress.allow.length - 2}` : ""})`;
}

/** A container in a few words: `docker, image odw-agents, network default, cli config copy`. */
export function describeContainer(box: ContainerSandbox, onPath?: (cmd: string) => boolean): string {
  const engine = resolveEngine(box, onPath) ?? "no engine found";
  const limits = [box.memory && `memory ${box.memory}`, box.cpus && `cpus ${box.cpus}`, `pids ${box.pids}`].filter(Boolean).join(", ");
  const mounts = box.mounts.length > 0 ? `, ${box.mounts.length} extra mount${box.mounts.length === 1 ? "" : "s"}` : "";
  return `${engine}, image ${box.image}, network ${describeNetwork(box.network)}, cli config ${box.cliConfig}, ${limits}${mounts}`;
}

/**
 * The start banner's sandbox line: where the run's agents run, and each
 * adapter `isInstalled` whose own sandbox differs. One line.
 */
export function sandboxBanner(config: Config, onPath?: (cmd: string) => boolean): string {
  const run = config.settings.sandbox ?? "none";
  const own = Object.values(config.adapters)
    .filter((adapter) => adapter.sandbox)
    .map((adapter) => {
      const box = planSandbox(run, adapter).box;
      const egress = box && egressOf(box.network);
      return box
        ? `${adapter.name}: image ${box.image}${box.network === "none" ? ", no network" : egress ? `, network ${describeNetwork(box.network)}` : ""}`
        : null;
    })
    .filter((line): line is string => line !== null);
  const head =
    run === "none"
      ? "sandbox: none — agents run on this machine as you"
      : `sandbox: container (${describeContainer(run, onPath)}) — agents and exec() steps run in it`;
  return own.length > 0 ? `${head}; ${own.join("; ")}` : head;
}

// --- the container's argv -------------------------------------------------------

/** Everything one container run needs: what {@link containerArgv} turns into an argv. */
export interface ContainerRun {
  engine: SandboxEngine;
  image: string;
  name: string;
  /** The host's uid and gid, set as the container's user; null where the platform has none. */
  user: { uid: number; gid: number } | null;
  /** The working directory: the workspace, at the same path. */
  workdir: string;
  /** Every bind mount, the workspace's included. */
  mounts: SandboxMount[];
  network: SandboxNetwork;
  /** The network it joins instead (an egress allowlist's internal network; see ./egress-run). */
  networkName?: string;
  /** Variables the container gets from the engine client's environment, by name (secrets stay out of argv). */
  passEnv: string[];
  /** Variables set to these values (no secrets: HOME, TMPDIR). */
  setEnv: Record<string, string>;
  memory: string | null;
  cpus: number | null;
  pids: number;
  labels: Record<string, string>;
  /** What runs in it: the CLI's argv. */
  command: string[];
}

/** The engine argv of one container run. Pure: what it says is all there is. */
export function containerArgv(run: ContainerRun): string[] {
  const argv: string[] = [run.engine, "run", "--rm", "-i", "--init", "--pull", "never", "--name", run.name];
  for (const [key, value] of Object.entries(run.labels)) argv.push("--label", `${key}=${value}`);
  if (run.user) {
    argv.push("--user", `${run.user.uid}:${run.user.gid}`);
    // Rootless Podman maps container uids to subordinate ones: keep-id keeps yours yours.
    if (run.engine === "podman") argv.push("--userns", "keep-id");
  }
  argv.push("--cap-drop", "ALL", "--security-opt", "no-new-privileges");
  argv.push("--read-only", "--tmpfs", TMPFS);
  argv.push("--pids-limit", String(run.pids));
  if (run.memory) argv.push("--memory", run.memory);
  if (run.cpus) argv.push("--cpus", String(run.cpus));
  if (run.networkName) argv.push("--network", run.networkName);
  else if (run.network === "none") argv.push("--network", "none");
  // An allowlist without its internal network would be the default one: never.
  else if (typeof run.network === "object") throw new Error("sandbox: an egress allowlist needs its run's internal network");
  argv.push("--workdir", run.workdir);
  for (const mount of run.mounts) {
    argv.push("--mount", `type=bind,source=${mount.source},target=${mount.target}${mount.readonly ? ",readonly" : ""}`);
  }
  for (const [name, value] of Object.entries(run.setEnv)) argv.push("--env", `${name}=${value}`);
  for (const name of run.passEnv) argv.push("--env", name);
  argv.push(run.image, ...run.command);
  return argv;
}

/** A container name ODW assigns: `odw-<run>-<agent>-<6 hex>`, in the engines' name alphabet. */
export function containerName(runId: string | undefined, agentId: number | string | undefined, random: () => number = Math.random): string {
  const part = (value: string): string => value.replace(/[^A-Za-z0-9_.-]/g, "-").slice(0, 48);
  const rand = Math.floor(random() * 0x1000000)
    .toString(16)
    .padStart(6, "0");
  return ["odw", runId ? part(runId) : "run", agentId !== undefined ? part(String(agentId)) : "x", rand].join("-");
}

/** The host's uid:gid, where the platform has them. */
export function hostUser(): { uid: number; gid: number } | null {
  return typeof process.getuid === "function" && typeof process.getgid === "function"
    ? { uid: process.getuid(), gid: process.getgid() }
    : null;
}

// --- environment ----------------------------------------------------------------

/**
 * Variables that stay on the host: its own paths, meaningless or harmful in
 * the container (its PATH would hide the image's; HOME, TMPDIR and the CLIs'
 * config-dir variables point where the container has nothing).
 */
export const CONTAINER_ENV_DROP: readonly string[] = [
  "PATH",
  "HOME",
  "TMPDIR",
  "TEMP",
  "TMP",
  "SHELL",
  "PWD",
  "OLDPWD",
  "XDG_*",
  "CLAUDE_CONFIG_DIR",
  "CODEX_HOME",
];

/**
 * What the engine client itself needs to find and reach its engine: its PATH
 * and home (contexts, `~/.docker`), the user and locale, Podman's runtime and
 * storage dirs, and the documented DOCKER_* and CONTAINER(S)_* variables.
 */
export const ENGINE_ENV: readonly string[] = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "LANG",
  "LC_*",
  "TMPDIR",
  "TZ",
  "XDG_*",
  "DOCKER_*",
  "CONTAINER_*",
  "CONTAINERS_*",
  "REGISTRY_AUTH_FILE",
];

/**
 * Split an agent's environment for a container run: the names the container
 * gets (`pass`: all of `agentEnv` but {@link CONTAINER_ENV_DROP}), and the
 * engine client's environment — {@link ENGINE_ENV} of the host's, with those
 * variables' values over it, for the client to hand on.
 */
export function containerEnv(
  agentEnv: Record<string, string | undefined>,
  hostEnv: Record<string, string | undefined>,
): { pass: string[]; client: Record<string, string> } {
  const drop = globMatcher([...CONTAINER_ENV_DROP], false);
  const engine = globMatcher([...ENGINE_ENV], false);
  const client: Record<string, string> = {};
  for (const [name, value] of Object.entries(hostEnv)) if (value !== undefined && engine(name)) client[name] = value;
  const pass: string[] = [];
  for (const [name, value] of Object.entries(agentEnv)) {
    if (value === undefined || drop(name) || name === "" || name.includes("=")) continue;
    // A name the client needs with another value (none of ENGINE_ENV passes, but be sure) stays the client's.
    if (engine(name) && client[name] !== undefined && client[name] !== value) continue;
    pass.push(name);
    client[name] = value;
  }
  return { pass: pass.sort(), client };
}

// --- the CLI's own config ------------------------------------------------------------

/**
 * Where a CLI keeps its login and config, from its docs — the files a
 * container's home gets a copy of (`cliConfig: "copy"`) or a read-only bind
 * of (`"mount-ro"`). Only these: not the CLI's session history, logs or
 * caches, nor its whole directory.
 */
export interface CliConfigDef {
  /** The CLI's directory under the home, as the container gets it. */
  dir: string;
  /** The variable that moves it on the host, if any. */
  dirEnv?: string;
  /** Files and directories in it that are login or config. */
  entries: string[];
  /** A file at the home's top (in the directory when `dirEnv` is set), copied as JSON with `dropKeys` left out. */
  homeFile?: { name: string; dropKeys: string[] };
  /** How its agents log in without these files: said when there is nothing to copy. */
  envHint: string;
}

/**
 * - Claude Code (https://code.claude.com/docs/en/authentication, /settings):
 *   `~/.claude/.credentials.json` holds the login on Linux and Windows (macOS
 *   keeps it in the Keychain), `settings.json`, `CLAUDE.md`, `agents/`,
 *   `commands/` and `skills/` are the user's own config; `~/.claude.json`
 *   holds preferences, the OAuth account and user MCP servers — copied
 *   without its `projects` (every other repository's state). `CLAUDE_CONFIG_DIR`
 *   moves all of it.
 * - Codex (https://developers.openai.com/codex/noninteractive, config
 *   reference): `~/.codex/auth.json` (the login), `config.toml`, `AGENTS.md`;
 *   `CODEX_HOME` moves them. Not its sessions or history.
 * - Gemini CLI (https://geminicli.com/docs/get-started/authentication,
 *   /configuration): `~/.gemini/settings.json`, `oauth_creds.json` and
 *   `google_accounts.json` (a Google login), `GEMINI.md`, `.env`.
 */
export const CLI_CONFIGS: Record<string, CliConfigDef> = {
  claude: {
    dir: ".claude",
    dirEnv: "CLAUDE_CONFIG_DIR",
    entries: [".credentials.json", "settings.json", "CLAUDE.md", "agents", "commands", "skills"],
    homeFile: { name: ".claude.json", dropKeys: ["projects"] },
    envHint:
      "set CLAUDE_CODE_OAUTH_TOKEN (from `claude setup-token`) or ANTHROPIC_API_KEY — on macOS Claude Code keeps its login in the Keychain",
  },
  codex: {
    dir: ".codex",
    dirEnv: "CODEX_HOME",
    entries: ["auth.json", "config.toml", "AGENTS.md"],
    envHint: "set CODEX_API_KEY (codex exec reads it), or run `codex login` on this machine",
  },
  gemini: {
    dir: ".gemini",
    entries: ["settings.json", "oauth_creds.json", "google_accounts.json", "GEMINI.md", ".env"],
    envHint: "set GEMINI_API_KEY, or log in with `gemini` on this machine",
  },
};

/** The config definition of the CLI an argv runs (by its program's base name), if ODW knows it. */
export function cliConfigOf(command: readonly string[]): { cli: string; def: CliConfigDef } | null {
  const program = basename(command[0] ?? "").replace(/\.(exe|cmd)$/i, "");
  const def = Object.prototype.hasOwnProperty.call(CLI_CONFIGS, program) ? CLI_CONFIGS[program] : undefined;
  return def ? { cli: program, def } : null;
}

/** A container's private home, made ready for one run. */
export interface SandboxHome {
  /** The host directory bound at {@link CONTAINER_HOME}. */
  dir: string;
  /** Read-only binds of the CLI's files into it (`mount-ro`). */
  mounts: SandboxMount[];
  /** What the run's log should hear once: nothing to copy, or a file it could not read. */
  note?: string;
  /** Remove the directory. Never throws. */
  cleanup(): Promise<void>;
}

/**
 * Make a private home for one container run: a fresh temporary directory
 * (this user's alone), holding — by `mode` — a copy of the CLI's config
 * files, read-only binds of them, or nothing. `env` is the environment the
 * CLI would start with on the host (it may move the CLI's directory).
 */
export async function prepareHome(
  command: readonly string[],
  mode: SandboxCliConfig,
  env: Record<string, string | undefined>,
  home: string = homedir(),
): Promise<SandboxHome> {
  const dir = await mkdtemp(join(tmpdir(), "odw-home-"));
  const cleanup = (): Promise<void> => rm(dir, { recursive: true, force: true }).catch(() => {});
  const out: SandboxHome = { dir, mounts: [], cleanup };
  const known = cliConfigOf(command);
  if (mode === "none") return out;
  if (!known) {
    out.note =
      `sandbox: ODW knows no config files of '${basename(command[0] ?? "")}', so its container starts with an empty home — ` +
      `pass its login in the environment (agentEnvPass), or bind its config with sandbox.mounts`;
    return out;
  }
  const { cli, def } = known;
  try {
    const moved = def.dirEnv ? env[def.dirEnv] : undefined;
    const hostDir = moved ? resolve(moved) : join(home, def.dir);
    const inHome = join(dir, def.dir);
    await mkdir(inHome, { recursive: true, mode: 0o700 });
    let found = 0;
    for (const entry of def.entries) {
      const from = join(hostDir, entry);
      if (!existsSync(from)) continue;
      found++;
      const to = join(inHome, entry);
      if (mode === "copy") {
        await cp(from, to, { recursive: true, dereference: true, force: true });
      } else {
        // The mount point is made here, so the engine need not create one in this directory.
        if (statSync(from).isDirectory()) await mkdir(to, { recursive: true });
        else await writeFile(to, "", { mode: 0o600 });
        out.mounts.push({ source: from, target: `${CONTAINER_HOME}/${def.dir}/${entry}`, readonly: true });
      }
    }
    if (def.homeFile) {
      const from = moved ? join(hostDir, def.homeFile.name) : join(home, def.homeFile.name);
      if (existsSync(from)) {
        found++;
        const to = join(dir, def.homeFile.name);
        if (mode === "copy") {
          const kept = await filteredJson(from, def.homeFile.dropKeys);
          if (kept === null) out.note = `sandbox: ${from} is not JSON ODW can read — its container gets no copy of it`;
          else await writeFile(to, kept, { mode: 0o600 });
        } else {
          await writeFile(to, "", { mode: 0o600 });
          out.mounts.push({ source: from, target: `${CONTAINER_HOME}/${def.homeFile.name}`, readonly: true });
        }
      }
    }
    if (found === 0) out.note = `sandbox: no ${cli} login or config in ${hostDir} to ${mode === "copy" ? "copy" : "bind"} — ${def.envHint}`;
    for (const mount of out.mounts) {
      const problem = pathProblem(mount.source);
      if (problem) throw new ConfigError(`sandbox: ${mount.source} ${problem}`);
    }
    return out;
  } catch (err) {
    await cleanup();
    throw err;
  }
}

/** A JSON file's text without `dropKeys` at its top; null when it is not a JSON object. */
async function filteredJson(path: string, dropKeys: string[]): Promise<string | null> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as unknown;
    if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
    const kept = { ...(value as Record<string, unknown>) };
    for (const key of dropKeys) delete kept[key];
    return JSON.stringify(kept, null, 2);
  } catch {
    return null;
  }
}

// --- the engine -------------------------------------------------------------------

/**
 * Why a sandbox cannot run here — no engine, no such image — or null. Asks
 * the engine (`image inspect`), never pulls. `env` is the engine client's.
 */
export async function sandboxProblem(
  box: ContainerSandbox,
  runner: CommandRunner,
  env: Record<string, string | undefined> = process.env,
  onPath: (cmd: string) => boolean = isOnPath,
  platform: NodeJS.Platform = process.platform,
): Promise<string | null> {
  if (platform === "win32") {
    return "the container sandbox needs a Linux or macOS host (it binds the workspace at the same path in a Linux container)";
  }
  const engine = resolveEngine(box, onPath);
  if (!engine || !onPath(engine)) {
    return box.engine
      ? `sandbox engine '${box.engine}' is not on PATH — install it, or set sandbox.engine to the one you have`
      : "no container engine on PATH (docker or podman) — install one, or run without --sandbox";
  }
  const inspect = await runner([engine, "image", "inspect", "--format", "{{.Id}}", box.image], { timeout: 30, env: clientEnv(env) });
  if (inspect.returncode !== 0) {
    const said = (inspect.stderr || inspect.stdout).trim().split("\n")[0]?.slice(0, 160) ?? "";
    return (
      `sandbox image '${box.image}' is not present in ${engine} (ODW never pulls) — build it ` +
      `(see examples/sandbox/Dockerfile) or \`${engine} pull ${box.image}\`${said ? `; ${engine} said: ${said}` : ""}`
    );
  }
  return null;
}

/** The engine client's environment, from the host's. */
export function clientEnv(env: Record<string, string | undefined>): Record<string, string> {
  return containerEnv({}, env).client;
}

/** Containers ODW started that have not been accounted for: name → engine. */
const live = new Map<string, { engine: SandboxEngine; home?: string }>();
/** Networks ODW created (an egress allowlist's; see ./egress-run) not yet removed: name → engine. */
const liveNetworks = new Map<string, SandboxEngine>();
let backstop: (() => void) | undefined;

/** Count a container as live until the returned function is called, so the worker's backstop kills it too. */
export function trackContainer(name: string, engine: SandboxEngine, home?: string): () => void {
  live.set(name, { engine, ...(home ? { home } : {}) });
  armBackstop();
  return () => {
    live.delete(name);
  };
}

/** Count a network as live until the returned function is called: the backstop removes it after the containers. */
export function trackNetwork(name: string, engine: SandboxEngine): () => void {
  liveNetworks.set(name, engine);
  armBackstop();
  return () => {
    liveNetworks.delete(name);
  };
}

function armBackstop(): void {
  // Synchronous and fire-and-forget: it may run in a process 'exit' handler.
  backstop ??= onKillAll(() => {
    for (const engine of ENGINES) {
      const containers = [...live].filter(([, entry]) => entry.engine === engine).map(([name]) => name);
      const networks = [...liveNetworks].filter(([, owner]) => owner === engine).map(([name]) => name);
      for (const [file, args] of backstopCommands(engine, containers, networks)) {
        try {
          spawn(file, args, { detached: true, stdio: "ignore" }).unref();
        } catch {
          /* the engine is gone: nothing to do */
        }
      }
    }
    // A private home holds copies of the CLI's login: it must not outlive the run.
    for (const entry of live.values()) if (entry.home) rmSync(entry.home, { recursive: true, force: true });
    live.clear();
    liveNetworks.clear();
  });
}

/**
 * What the backstop runs, detached, for one engine's live containers and
 * networks: each container's `rm --force`; with networks, one shell that
 * removes the containers first and then the networks (a network with a
 * container still on it cannot go). Names are ODW's own (`[A-Za-z0-9_.-]`)
 * and passed as arguments, never spliced into the script.
 */
export function backstopCommands(engine: SandboxEngine, containers: string[], networks: string[]): Array<[string, string[]]> {
  if (networks.length === 0) return containers.map((name) => [engine, ["rm", "--force", name]]);
  const script = 'e="$1"; n="$2"; shift 2; if [ "$#" -gt 0 ]; then "$e" rm --force "$@"; fi; set -f; for net in $n; do "$e" network rm "$net"; done';
  return [["/bin/sh", ["-c", script, "odw-backstop", engine, networks.join(" "), ...containers]]];
}

/**
 * Stop a container by name and make sure nothing of it is left: `kill`, then
 * `rm --force` (one that never started is not running, so kill alone would
 * leave it). Best-effort and quiet: it may already be gone.
 */
export async function killContainer(runner: CommandRunner, engine: SandboxEngine, name: string, env: Record<string, string>): Promise<void> {
  await runner([engine, "kill", name], { timeout: 15, env }).catch(() => undefined);
  await runner([engine, "rm", "--force", name], { timeout: 15, env }).catch(() => undefined);
}

/** What one container run needs besides its box: see {@link openContainer}. */
export interface OpenContainer {
  box: ContainerSandbox;
  engine: SandboxEngine;
  runner: CommandRunner;
  /** The CLI's (or command's) argv. */
  command: string[];
  /** The workspace: bound read-write at the same path, and the working directory. */
  workspace: string;
  /** Another working directory (an exec() step's cwd), bound read-write too when outside the workspace. */
  workdir?: string;
  /** More binds this run needs: its prompt, schema and reply files. */
  extraMounts?: SandboxMount[];
  /** The environment it would start with on the host (after agentEnv). */
  env: Record<string, string | undefined>;
  /** The host's environment, for the engine client. */
  hostEnv?: Record<string, string | undefined>;
  /** `none` for an exec() step: it gets an empty home whatever the box says. */
  cliConfig?: SandboxCliConfig;
  runId?: string;
  agentId?: number | string;
  /** The host's home the CLI's config is read from (tests). */
  home?: string;
  /**
   * An egress allowlist's way out (see ./egress-run): the run's internal
   * network it joins, and the proxy variables it gets. Required when the box
   * has an allowlist.
   */
  egress?: { network: string; env: Record<string, string> };
}

/** One container run, ready: its argv and client environment, and what ends it. */
export interface OpenedContainer {
  argv: string[];
  env: Record<string, string>;
  name: string;
  note?: string;
  /**
   * After the engine client settled: a run that did not exit cleanly
   * (`clean` false: a timeout, a stall, a stop, a crash, a non-zero exit) has
   * its container killed. Then the private home goes. Never throws.
   */
  close(clean: boolean): Promise<void>;
}

/** The `.git` file or directory of each of `dirs` that has one, mounted read-only over its read-write parent. */
export function gitMetadata(dirs: string[]): Array<{ source: string; target: string; readonly: boolean }> {
  return dirs.map((dir) => join(dir, ".git")).filter((path) => existsSync(path)).map((path) => ({ source: path, target: path, readonly: true }));
}

/** Prepare one container run: its home, mounts, environment and argv (see the module comment). */
export async function openContainer(opts: OpenContainer): Promise<OpenedContainer> {
  const { box, engine } = opts;
  const workdir = opts.workdir ?? opts.workspace;
  for (const path of [opts.workspace, workdir]) {
    const problem = pathProblem(path);
    if (problem) throw new ConfigError(`sandbox: the working directory ${path} ${problem}`);
  }
  if (egressOf(box.network) && !opts.egress) throw new Error("sandbox: an egress allowlist needs its run's internal network");
  const inside = workdir === opts.workspace || workdir.startsWith(opts.workspace.endsWith("/") ? opts.workspace : `${opts.workspace}/`);
  const home = await prepareHome(opts.command, opts.cliConfig ?? box.cliConfig, opts.env, opts.home);
  const name = containerName(opts.runId, opts.agentId);
  const split = containerEnv(opts.env, opts.hostEnv ?? process.env);
  const setEnv: Record<string, string> = { HOME: CONTAINER_HOME, TMPDIR: "/tmp", ...opts.egress?.env };
  // What ODW sets is not the host's to override: its proxy variables above all.
  const pass = split.pass.filter((name) => !Object.prototype.hasOwnProperty.call(setEnv, name));
  const argv = containerArgv({
    engine,
    image: box.image,
    name,
    user: hostUser(),
    workdir,
    mounts: [
      { source: opts.workspace, target: opts.workspace, readonly: false },
      ...(inside ? [] : [{ source: workdir, target: workdir, readonly: false }]),
      // Git's metadata stays read-only: odw runs git on the host in these
      // directories afterwards (to capture a diff), and config planted there
      // — core.fsmonitor, core.hooksPath, a filter — would run on the host.
      ...gitMetadata(inside ? [opts.workspace] : [opts.workspace, workdir]),
      { source: home.dir, target: CONTAINER_HOME, readonly: false },
      ...home.mounts,
      ...(opts.extraMounts ?? []),
      ...box.mounts,
    ],
    network: box.network,
    ...(opts.egress ? { networkName: opts.egress.network } : {}),
    passEnv: pass,
    setEnv,
    memory: box.memory,
    cpus: box.cpus,
    pids: box.pids,
    labels: { "odw.run": opts.runId ?? "none" },
    command: opts.command,
  });
  const untrack = trackContainer(name, engine, home.dir);
  let closed = false;
  return {
    argv,
    env: split.client,
    name,
    note: home.note,
    close: async (clean) => {
      if (closed) return;
      closed = true;
      if (!clean) await killContainer(opts.runner, engine, name, split.client);
      untrack();
      await home.cleanup();
    },
  };
}
