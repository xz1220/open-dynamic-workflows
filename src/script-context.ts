/**
 * The script context a workflow body runs in (an ODW extension):
 * `scriptContext: "host" | "strict"`.
 *
 *   - `"host"` — the body is compiled in the worker's own context (./loader),
 *     as before: `process`, `require`, `fetch`, timers and whatever else the
 *     worker's globals reach are in scope. The default for local runs.
 *   - `"strict"` — the body is compiled and run in a fresh `vm` context that
 *     holds only the injected primitives (`agent`, `parallel`, `pipeline`,
 *     `phase`, `log`, `args`, `budget`, `workflow`, and the ODW extensions
 *     `validate`, `exec`, `checkpoint`) and the standard JavaScript built-ins:
 *     the bare ECMAScript realm Claude Code's Workflow tool gives a script. No
 *     `process`, `require`, `fetch`, timers or `console`; no `eval()` or
 *     `new Function()` (code generation from strings is off); a dynamic
 *     `import()` is refused when the body compiles (and `importModuleDynamically`
 *     rejects one all the same). Using one of these fails with a message that
 *     says so, not a bare ReferenceError.
 *
 * Values cross between the two realms through a membrane ({@link StrictRealm}):
 * what a primitive returns or throws reaches the script as a copy made in the
 * script's realm (plain objects, arrays, dates, errors; functions wrapped), and
 * an error the script throws reaches the worker as one of the worker's own
 * errors — the same object again when it is one the worker threw.
 *
 * Unless the config sets `scriptContext`, a run is strict when a trigger
 * started it (or the run it reruns or replays), when its workflow is a Claude Code plugin's, or when its input or
 * its repository is untrusted ({@link resolveScriptContext}).
 *
 * `vm` is NOT a security boundary. Strict takes away what a well-meaning but
 * unknown script could casually reach; it does not stop a hostile one from
 * finding a way out of the context, and a script still drives agents that act
 * with the run's permissions. Read a workflow before you run it.
 *
 * {@link scanCapabilities} is the static half, for `odw check --capabilities`:
 * which identifiers outside the dialect a script names, and which ODW
 * extension primitives it calls.
 */

import { Script, createContext, type Context } from "node:vm";

import { maskCode, locationAt } from "./loader.js";
import { WorkflowScriptError } from "./errors.js";

export type ScriptContext = "host" | "strict";
export const SCRIPT_CONTEXTS = ["host", "strict"] as const satisfies readonly ScriptContext[];

export function isScriptContext(value: unknown): value is ScriptContext {
  return value === "host" || value === "strict";
}

/** What a run is, as far as its script context goes. */
export interface ScriptContextRun {
  /** meta.json's origin: "trigger" for a run a trigger started. */
  origin?: unknown;
  /** meta.json's sourceOrigin: "trigger" for a replay or rerun of a run a trigger started. */
  sourceOrigin?: unknown;
  /** Whether its workflow is a Claude Code plugin's (meta.plugin). */
  plugin: boolean;
  /** Whether its input is untrusted (a trigger's, `--untrusted-input`). */
  untrustedInput: boolean;
  /** Whether the run itself is untrusted (`--untrusted`, `trust: "untrusted"`). */
  untrustedRepo: boolean;
}

/**
 * The run's script context and why: the config's `scriptContext` when it sets
 * one, else strict for a triggered run, a plugin's workflow, or untrusted
 * input or repository, and host for the rest.
 */
export function resolveScriptContext(
  setting: ScriptContext | null | undefined,
  run: ScriptContextRun,
): { context: ScriptContext; why: string } {
  if (setting) return { context: setting, why: `scriptContext: "${setting}" in the config` };
  if (run.origin === "trigger") return { context: "strict", why: "a trigger started this run" };
  if (run.sourceOrigin === "trigger") return { context: "strict", why: "a trigger started the run this one replays" };
  if (run.plugin) return { context: "strict", why: "the workflow is a Claude Code plugin's" };
  if (run.untrustedInput) return { context: "strict", why: "the run's input is untrusted" };
  if (run.untrustedRepo) return { context: "strict", why: "the run is untrusted" };
  return { context: "host", why: "a local run" };
}

/**
 * Globals outside the dialect, by what a script that names one wants: a
 * strict context has none of these (`globalThis` aside, which there is the
 * context's own bare global). The message a ReferenceError for one of them
 * becomes says so.
 */
const OUT_OF_DIALECT_GLOBALS: Record<string, string> = {
  process: "Node.js's process — pass what the script needs in args",
  require: "Node.js's module loader — the primitives are injected, nothing is imported",
  module: "Node.js's module object",
  exports: "Node.js's module exports",
  __dirname: "Node.js's module path",
  __filename: "Node.js's module path",
  Buffer: "Node.js's Buffer",
  global: "Node.js's global object",
  fetch: "the network — ask an agent to fetch it",
  console: "a console — log() writes to the run",
  setTimeout: "timers",
  setInterval: "timers",
  setImmediate: "timers",
  clearTimeout: "timers",
  clearInterval: "timers",
  queueMicrotask: "Node.js's queueMicrotask",
  structuredClone: "structuredClone — JSON.parse(JSON.stringify(x)) copies data",
  URL: "the WHATWG URL class",
  URLSearchParams: "the WHATWG URLSearchParams class",
  TextEncoder: "TextEncoder",
  TextDecoder: "TextDecoder",
  AbortController: "AbortController",
  crypto: "Web Crypto",
};

/** The tail every strict refusal shares. */
const STRICT_TAIL =
  'a strict script context (scriptContext: "strict") has only the workflow primitives and standard JavaScript built-ins';

/** A strict-context ReferenceError, EvalError or import refusal said plainly; null for any other error. */
export function readableStrictMessage(name: string, message: string): string | null {
  const missing = /^(\S+) is not defined$/.exec(message);
  if (name === "ReferenceError" && missing && Object.hasOwn(OUT_OF_DIALECT_GLOBALS, missing[1]!)) {
    const id = missing[1]!;
    return `${id} is not defined: ${STRICT_TAIL}, not ${OUT_OF_DIALECT_GLOBALS[id]}`;
  }
  if (name === "EvalError" && /code generation from strings/i.test(message)) {
    return `eval() and new Function() are not available: ${STRICT_TAIL}, and compiles no code from strings`;
  }
  return null;
}

/** Why a body that calls import() does not compile strict. */
function importRefusal(): string {
  return `import() is not available: ${STRICT_TAIL} — the primitives are injected, nothing is imported`;
}

/** A dynamic import() in a strict context: refused (the compile-time check catches the direct ones). */
function refuseImport(): never {
  throw new WorkflowScriptError(importRefusal());
}

/** A direct call of the dynamic `import()` — not `x.import(…)`. */
const CALLS_IMPORT = /(?<![\w$.])import\s*\(/;

/**
 * Refuse a body that calls `import()` before it compiles strict, with where
 * (the body keeps the source's lines and columns).
 */
export function assertNoDynamicImport(body: string, filename: string): void {
  const masked = maskCode(body, { keepInterpolations: true });
  const hit = CALLS_IMPORT.exec(masked);
  if (!hit) return;
  const at = locationAt(body, hit.index);
  throw new WorkflowScriptError(`failed to compile workflow ${filename}: ${importRefusal()} (line ${at.line}:${at.column})`, at);
}

/**
 * The membrane, compiled in the script's realm so what it builds has that
 * realm's prototypes. `remember(scriptError, hostError)` and `recall(hostError)`
 * pair the errors it copies; `toHostError` turns a script error into the
 * worker's own.
 */
const MEMBRANE_SOURCE = `(function (remember, recall, toHostError) {
  "use strict";
  const isArray = Array.isArray;
  const keys = Object.keys;
  const defineProperty = Object.defineProperty;
  const tagOf = Function.prototype.call.bind(Object.prototype.toString);
  const timeOf = Function.prototype.call.bind(Date.prototype.getTime);
  const ERRORS = { Error, TypeError, RangeError, SyntaxError, ReferenceError, EvalError, URIError };
  const mine = (v) => v instanceof Object;
  const field = (value) => ({ value, writable: true, enumerable: true, configurable: true });
  const hidden = (value) => ({ value, writable: true, enumerable: false, configurable: true });
  function toScript(v, seen) {
    if (v === null || (typeof v !== "object" && typeof v !== "function")) return v;
    if (mine(v)) return v;
    if (!seen) seen = new Map();
    if (seen.has(v)) return seen.get(v);
    if (typeof v === "function") {
      const f = wrapHost(v);
      seen.set(v, f);
      for (const k of keys(v)) defineProperty(f, k, field(toScript(v[k], seen)));
      return f;
    }
    const tag = tagOf(v);
    if (tag === "[object Error]") return errorToScript(v, seen);
    if (tag === "[object Date]") {
      const d = new Date(timeOf(v));
      seen.set(v, d);
      return d;
    }
    if (typeof v.then === "function") {
      const p = settle(v);
      seen.set(v, p);
      return p;
    }
    if (isArray(v)) {
      const a = [];
      seen.set(v, a);
      for (let i = 0; i < v.length; i++) a[i] = toScript(v[i], seen);
      return a;
    }
    const o = {};
    seen.set(v, o);
    for (const k of keys(v)) defineProperty(o, k, field(toScript(v[k], seen)));
    return o;
  }
  function errorToScript(e, seen) {
    const back = recall(e);
    if (back !== undefined) return back;
    const name = String(e.name);
    const Ctor = ERRORS[name] || Error;
    const c = new Ctor(String(e.message));
    seen.set(e, c);
    if (c.name !== name) defineProperty(c, "name", hidden(name));
    for (const k of keys(e)) {
      try { defineProperty(c, k, field(toScript(e[k], seen))); } catch {}
    }
    if (typeof e.stack === "string") defineProperty(c, "stack", hidden(e.stack));
    remember(c, e);
    return c;
  }
  function settle(p) {
    const q = (async () => {
      try { return toScript(await p); } catch (e) { throw toScript(e); }
    })();
    q.catch(() => {});
    return q;
  }
  function wrapHost(fn) {
    return function (...args) {
      let r;
      try { r = fn(...args.map(toHostArg)); } catch (e) { throw toScript(e); }
      if (r !== null && typeof r === "object" && !mine(r) && typeof r.then === "function") return settle(r);
      return toScript(r);
    };
  }
  function toHostArg(v) {
    if (typeof v === "function" && mine(v)) return wrapScript(v);
    if (isArray(v) && mine(v) && v.some((x) => typeof x === "function")) {
      return v.map((x) => (typeof x === "function" && mine(x) ? wrapScript(x) : x));
    }
    return v;
  }
  function wrapScript(f) {
    return function (...args) {
      let r;
      try { r = f(...args.map((a) => toScript(a))); } catch (e) { throw toHostError(e); }
      if (r !== null && typeof r === "object" && typeof r.then === "function") {
        return r.then(undefined, (e) => { throw toHostError(e); });
      }
      return r;
    };
  }
  return toScript;
})`;

/** A fresh context for one workflow body, and the membrane between it and the worker. */
export interface StrictRealm {
  context: Context;
  /** A worker value as the script sees it: a copy in the script's realm, functions wrapped. */
  toScript(value: unknown): unknown;
  /** A value the script threw, as the worker's own error (the original when the worker threw it first). */
  toHostError(value: unknown): unknown;
  /** Compile options for the body's Script. */
  scriptOptions: { importModuleDynamically: () => never };
}

/** A new strict realm: a bare global, no code generation from strings. */
export function createStrictRealm(filename: string): StrictRealm {
  const context = createContext(Object.create(null) as object, {
    name: `odw strict: ${filename}`,
    codeGeneration: { strings: false, wasm: false },
  });
  // V8 gives every context an inspector-only console: a log that goes nowhere. Gone, so using it says why.
  new Script("delete globalThis.console").runInContext(context);
  const scriptToHost = new WeakMap<object, unknown>();
  const hostToScript = new WeakMap<object, unknown>();
  const remember = (scriptError: object, hostError: object): void => {
    scriptToHost.set(scriptError, hostError);
    hostToScript.set(hostError, scriptError);
  };
  const recall = (hostError: object): unknown => hostToScript.get(hostError);
  const toHostError = (value: unknown): unknown => {
    if (value === null || typeof value !== "object") return value;
    if (scriptToHost.has(value)) return scriptToHost.get(value);
    if (value instanceof Error) return value; // already the worker's
    if (Object.prototype.toString.call(value) !== "[object Error]") return value; // a thrown plain object
    const e = value as Error;
    const name = String(e.name);
    const message = String(e.message);
    const readable = readableStrictMessage(name, message);
    const Ctor = HOST_ERRORS[name] ?? Error;
    const host = new Ctor(readable ?? message);
    if (host.name !== name) Object.defineProperty(host, "name", { value: name, writable: true, configurable: true });
    for (const key of Object.keys(e)) (host as unknown as Record<string, unknown>)[key] = (e as unknown as Record<string, unknown>)[key];
    if (typeof e.stack === "string") {
      // The script's own frames, under the (perhaps reworded) first line.
      const frames = e.stack.split("\n").filter((line) => /^\s+at /.test(line));
      host.stack = [`${name}: ${readable ?? message}`, ...frames].join("\n");
    }
    remember(e, host);
    return host;
  };
  const toScript = new Script(MEMBRANE_SOURCE, { filename: "odw:strict-membrane" })
    .runInContext(context)(remember, recall, toHostError) as (value: unknown) => unknown;
  return { context, toScript, toHostError, scriptOptions: { importModuleDynamically: refuseImport } };
}

const HOST_ERRORS: Record<string, ErrorConstructor> = {
  Error,
  TypeError,
  RangeError,
  SyntaxError,
  ReferenceError,
  EvalError,
  URIError,
};

/** One identifier outside the dialect a script names, where it first does, and how often. */
export interface CapabilityUse {
  name: string;
  line: number;
  column: number;
  count: number;
  /** Whether a strict context has it at all (only `globalThis`, its own bare global, does). */
  strict: boolean;
}

/** What `odw check --capabilities` reports. */
export interface CapabilityReport {
  /** Identifiers outside Claude Code's dialect: Node.js and web globals, eval, Function(), import(). */
  outOfDialect: CapabilityUse[];
  /** The ODW extension primitives the script calls (`validate`, `exec`, `checkpoint`, `workflow.input`). */
  extensions: string[];
}

/** What the static scan looks for beyond OUT_OF_DIALECT_GLOBALS: [shown name, pattern, in strict]. */
const SPECIAL_USES: Array<[string, RegExp, boolean]> = [
  ["globalThis", /(?<![\w$.])globalThis(?![\w$])/g, true],
  ["eval", /(?<![\w$.])eval(?![\w$])/g, false],
  ["Function(", /(?<![\w$.])Function\s*\(/g, false],
  ["import(", /(?<![\w$.])import\s*\(/g, false],
];

const EXTENSION_USES: Array<[string, RegExp]> = [
  ["validate", /(?<![\w$.])validate\s*\(/],
  ["exec", /(?<![\w$])(?<!\.\s*)exec\s*\(/],
  ["checkpoint", /(?<![\w$])(?<!\.\s*)checkpoint\s*\(/],
  ["workflow.input", /(?<![\w$.])workflow\s*\.\s*input(?![\w$])/],
];

/**
 * Statically list what a workflow source names outside the dialect, and the
 * ODW extension primitives it calls — over a mask of the source (comments and
 * strings blanked, `${…}` kept), skipping property names (`x.process`,
 * `{ process: 1 }`) and identifiers the script declares itself. A list, not a
 * verdict: a name may sit in a branch that never runs.
 */
export function scanCapabilities(source: string): CapabilityReport {
  const masked = maskCode(source, { keepInterpolations: true });
  const declared = (name: string): boolean =>
    new RegExp(`\\b(?:const|let|var|function|class)\\s+${name.replace(/\$/g, "\\$")}\\b`).test(masked);
  const outOfDialect: CapabilityUse[] = [];
  const record = (name: string, re: RegExp, strict: boolean): void => {
    let first = -1;
    let count = 0;
    for (const m of masked.matchAll(re)) {
      // An object key (`{ process: 1 }`, `, require: x`) names no global.
      if (/^[\w$]+$/.test(name) && /^\s*:/.test(masked.slice(m.index + m[0].length)) && /[{,]\s*$/.test(masked.slice(0, m.index))) continue;
      if (first < 0) first = m.index;
      count++;
    }
    if (count === 0) return;
    const at = locationAt(source, first);
    outOfDialect.push({ name, line: at.line, column: at.column, count, strict });
  };
  for (const name of Object.keys(OUT_OF_DIALECT_GLOBALS)) {
    if (declared(name)) continue;
    record(name, new RegExp(`(?<![\\w$.])${name}(?![\\w$])`, "g"), false);
  }
  for (const [name, re, strict] of SPECIAL_USES) record(name, re, strict);
  outOfDialect.sort((a, b) => a.line - b.line || a.column - b.column);
  const extensions = EXTENSION_USES.filter(([name, re]) => re.test(masked) && !(name !== "workflow.input" && declared(name))).map(([name]) => name);
  return { outOfDialect, extensions };
}
