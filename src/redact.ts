/**
 * Redaction (an ODW extension): likely secrets out of what odw keeps and serves.
 *
 * An agent prints whatever it reads — `cat .env` included — and odw keeps it:
 * its transcript and the end of its stderr, its reply (its saved result), what
 * went wrong (the run's events and error), and what a run tells a webhook; the
 * dashboard serves all of it, off-loopback too. Before any of that is written,
 * a {@link Redactor} replaces each likely secret in it with `«redacted:<kind>»`:
 *
 *   env:NAME     `redact.env` — the value of NAME, a secret-named variable
 *                ({@link isSecretName}) of the environment odw starts agents
 *                and commands with, wherever it appears (values of 8
 *                characters or more, matched exactly); and the value of any
 *                `NAME=value` printed whose NAME looks secret (a `.env` file,
 *                `env` output), whatever it is
 *   anthropic, openai, github, slack, aws, google, jwt, private_key, bearer
 *                `redact.patterns` — well-known token shapes; a `Bearer`
 *                token keeps its scheme (`Bearer «redacted:bearer»`)
 *   extra        `redact.extra` — a match of one of the configured regular
 *                expressions
 *
 * A value the workflow itself returns is the user's data: it goes through the
 * redactor's {@link Redactor.shapes} — the token shapes and `extra`, never the
 * values of variables — since a workflow may return a config it read on purpose.
 *
 * Everything is compiled once, when the run builds its redactor
 * ({@link redactorFor}); the environment's values are matched by a single
 * regular expression of them all, escaped, longest first. Output arriving in
 * chunks is redacted as it arrives by a {@link RedactStream}, which holds back
 * only what a secret could still be completing.
 *
 * What is passed TO agents — their prompts, their environment — is never
 * redacted, nor what a workflow gets back from agent() or exec(): only what odw
 * writes down about them.
 */

import type { Config, RedactSettings } from "./adapters/types.js";

/** Characters a value must have to be redacted wherever it appears: shorter ones are too likely to be ordinary text. */
export const MIN_SECRET_CHARS = 8;

/** What a redactor looks for when it is given no `redact` setting: the default's (see adapters/builtin.ts). */
const DEFAULTS: RedactSettings = { env: true, patterns: true, extra: [] };

/** How a redacted secret reads. */
export function marker(kind: string): string {
  return `«redacted:${kind}»`;
}

/** A redaction marker. */
const MARKER = /«redacted:[^»\s]{1,128}»/;

/** Does `text` hold a redaction marker? */
export function hasMarker(text: string): boolean {
  return text.includes("«redacted:") && MARKER.test(text);
}

/**
 * Both ends of a long diagnostic — its first and last `half` characters, with
 * " … " between — never cutting a redaction marker in half; short text as it is.
 */
export function bothEnds(text: string, half: number): string {
  if (text.length <= 2 * half) return text;
  let head = half;
  const open = text.lastIndexOf("«", head - 1);
  if (open !== -1 && text.startsWith("«redacted:", open)) {
    const close = text.indexOf("»", open);
    if (close >= head) head = close + 1;
  }
  let tail = text.length - half;
  const before = text.lastIndexOf("«", tail - 1);
  if (before !== -1 && text.startsWith("«redacted:", before) && text.indexOf("»", before) >= tail) tail = before;
  return head >= tail ? text : `${text.slice(0, head)} … ${text.slice(tail)}`;
}

// --- what is secret ---------------------------------------------------------------

/**
 * Names of variables whose values are secrets: `*_KEY` (`*_API_KEY`,
 * `*APIKEY`), `*TOKEN`, `*SECRET*`, `*PASSWORD*` (`PASSWD`, `PASSPHRASE`,
 * `*_PWD`), `*_PAT`, `AUTHORIZATION`, cloud credentials (`*ACCESS_KEY*`,
 * `*PRIVATE_KEY*`, `*CONNECTION_STRING`, `*CREDENTIALS`, `*KEYFILE_JSON`),
 * webhook URLs — matched without regard to case.
 */
const SECRET_NAME =
  /SECRET|PASSWORD|PASSWD|PASSPHRASE|TOKEN$|(?:^|_)(?:API_?)?KEY$|(?:ACCESS|PRIVATE)_?KEY|_PWD$|_PAT$|(?:^|_)AUTHORIZATION$|CONNECTION_STRING$|CREDENTIALS?(?:_JSON)?$|KEYFILE_JSON$|WEBHOOK(?:_URL)?$/i;

/** Does `name` name a variable whose value is likely a secret? */
export function isSecretName(name: string): boolean {
  return SECRET_NAME.test(name);
}

/** Not inside a longer run of token characters. */
const START = String.raw`(?<![A-Za-z0-9_-])`;
/** A line break, as printed or JSON-escaped (a key file printed as a JSON string). */
const NL = String.raw`(?:\r?\n|\\r\\n|\\n)`;
const KEY_BEGIN = String.raw`-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-----`;
const KEY_END = String.raw`-----END [A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-----`;
/** A private key's body line: base64 — the whole line — or a header (`Proc-Type: 4,ENCRYPTED`). */
const KEY_LINE = String.raw`(?:[A-Za-z0-9+/=]+(?=[ \t]*(?:[\r\n"]|\\[rn]|$|-----END ))|[A-Za-z][A-Za-z-]*:[^\r\n\\]*)`;

/** The well-known token shapes `redact.patterns` looks for, by kind. */
const SHAPES: ReadonlyArray<readonly [kind: string, source: string]> = [
  // A whole block — or, its end not printed, its first line and the body lines that follow it.
  [
    "private_key",
    String.raw`${KEY_BEGIN}(?:[A-Za-z0-9+/=]{16,}|(?:(?:[ \t]*${NL})+[ \t]*${KEY_LINE}){1,1000})?(?:(?:[ \t]*${NL})*[ \t]*${KEY_END})?`,
  ],
  ["anthropic", String.raw`${START}sk-ant-[A-Za-z0-9_-]{20,}`],
  ["openai", String.raw`${START}sk-(?:(?:proj|svcacct|admin|None)-[A-Za-z0-9_-]{20,}|[A-Za-z0-9]{32,})`],
  ["github", String.raw`${START}(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})`],
  ["slack", String.raw`${START}xox[abprs]-[A-Za-z0-9-]{10,}`],
  ["aws", String.raw`(?<![A-Za-z0-9])A(?:KI|SI)A[A-Z0-9]{16}(?![A-Za-z0-9])`],
  ["google", String.raw`${START}AIza[A-Za-z0-9_-]{35}`],
  ["jwt", String.raw`${START}eyJ[A-Za-z0-9_-]{5,}\.eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{10,}`],
  // RFC 6750's b64token, with a digit in it: "Bearer authentication" is prose.
  ["bearer", String.raw`\b[Bb]earer[ \t]+(?=[\w.~+/-]*[0-9])[\w.~+/-]{12,}=*`],
];

/** The kinds of token shape `redact.patterns` redacts, in the order they are tried. */
export const PATTERN_KINDS: readonly string[] = SHAPES.map(([kind]) => kind);

/** A `Bearer` token's scheme, kept in front of its marker. */
const BEARER_SCHEME = /^[Bb]earer[ \t]+/;

/** One way to find secrets: a global regular expression and what each match becomes. */
interface Rule {
  re: RegExp;
  to: (match: string, ...args: any[]) => string;
}

/** The token shapes, as one expression: the group that matched names the kind. */
const SHAPES_RULE: Rule = {
  re: new RegExp(SHAPES.map(([kind, source]) => `(?<${kind}>${source})`).join("|"), "g"),
  to: (match: string, ...args: unknown[]): string => {
    const groups = args[args.length - 1] as Record<string, string | undefined>;
    const kind = PATTERN_KINDS.find((name) => groups[name] !== undefined) ?? "secret";
    return kind === "bearer" ? `${BEARER_SCHEME.exec(match)?.[0] ?? ""}${marker(kind)}` : marker(kind);
  },
};

/**
 * `NAME=value`, `NAME="value"` or `NAME='value'` — a `.env` line, `env`
 * output, `export NAME=…`: its value is redacted when NAME looks secret. A
 * value already redacted is left as it is.
 */
const ASSIGNMENT_RULE: Rule = {
  re: /(?<![A-Za-z0-9_])([A-Z_][A-Z0-9_]*)=(?!["']?«)(?:"([^"\r\n]{8,})"|'([^'\r\n]{8,})'|([^\s"'`\\]{8,}))/g,
  to: (match: string, name: string, quoted?: string, single?: string): string => {
    if (!isSecretName(name)) return match;
    const hidden = marker(`env:${name}`);
    return `${name}=${quoted !== undefined ? `"${hidden}"` : single !== undefined ? `'${hidden}'` : hidden}`;
  },
};

/** The flags a `redact.extra` expression is compiled with. */
const EXTRA_FLAGS = "g";

/** What is wrong with a `redact.extra` entry, or null when it is a usable expression. */
export function extraProblem(source: unknown): string | null {
  if (typeof source !== "string" || source === "") return "must be a regular expression source (a non-empty string)";
  let re: RegExp;
  try {
    re = new RegExp(source, EXTRA_FLAGS);
  } catch (err) {
    return `is not a valid regular expression: ${err instanceof Error ? err.message : String(err)}`;
  }
  return re.test("") ? "matches empty text, so it would mark every position" : null;
}

function extraRule(source: string): Rule {
  // An expression that matches empty text somewhere (a lookahead) marks nothing there.
  return { re: new RegExp(source, EXTRA_FLAGS), to: (match: string) => (match === "" ? match : marker("extra")) };
}

/** Characters of a value — or of one line of a longer one — that are matched, at most: a longer one is no secret. */
const MAX_VALUE_CHARS = 16 * 1024;

/**
 * Each secret-named variable's value as it may be printed — as it is, trimmed,
 * JSON-escaped, and each line of a value of several lines with no space in it
 * (a private key's body) — mapped to the variable's name (the first name wins
 * a value two share); and every variable that has one.
 */
function envValues(sources: RedactorOptions["env"]): { values: Map<string, string>; names: Set<string> } {
  const values = new Map<string, string>();
  const names = new Set<string>();
  for (const env of sources ?? []) {
    if (!env) continue;
    for (const name of Object.keys(env).sort()) {
      const value = env[name];
      if (typeof value !== "string" || !isSecretName(name)) continue;
      const forms = [value, value.trim(), JSON.stringify(value).slice(1, -1)];
      if (value.includes("\n")) forms.push(...value.split(/\r?\n/).map((line) => line.trim()).filter((line) => !/\s/.test(line)));
      for (const form of forms) {
        if (form.length < MIN_SECRET_CHARS || form.length > MAX_VALUE_CHARS) continue;
        names.add(name);
        if (!values.has(form)) values.set(form, name);
      }
    }
  }
  return { values, names };
}

/** The environment's values as one expression, longest first (a value holding another is redacted whole). */
function envRule(values: Map<string, string>): Rule {
  const alternatives = [...values.keys()].sort((a, b) => b.length - a.length).map(escapeRegExp);
  return { re: new RegExp(alternatives.join("|"), "g"), to: (match: string) => marker(`env:${safeName(values.get(match) ?? "")}`) };
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

/** A variable's name as a marker can carry it. */
function safeName(name: string): string {
  return name.replace(/[^\w.-]/g, "_").slice(0, 100) || "_";
}

// --- the redactor -------------------------------------------------------------------

/**
 * The fields of a record or an event that name things — its type, its run, its
 * adapter, its branch, its resume key, … — which odw and every reader key on:
 * never redacted.
 */
const NAMES = new Set(["type", "runId", "sourceRunId", "key", "adapter", "fellBackFrom", "branch", "permissions", "reason"]);

/** What a redactor looks for, as `odw doctor` reports it. */
export interface RedactionCoverage {
  /** `redact: false`: nothing is redacted. */
  off: boolean;
  /** `redact.env`: secret-named variables' values, and `NAME=value` of secret-looking names. */
  env: boolean;
  /** The secret-named variables whose values are redacted, sorted. */
  variables: string[];
  /** `redact.patterns`: well-known token shapes. */
  patterns: boolean;
  /** How many `redact.extra` expressions. */
  extra: number;
}

/** Characters a stream keeps back of a line too long to wait for, at least and at most. */
const MIN_CARRY = 4096;
const MAX_CARRY = MAX_VALUE_CHARS;

/**
 * Replaces the likely secrets in what odw writes down (see the module doc).
 * Built once per run, by {@link createRedactor} or {@link redactorFor}.
 */
export class Redactor {
  /** The same redactor but for the environment's values: what a workflow's own return value goes through. */
  readonly shapes: Redactor;
  /**
   * Characters a stream holds back of a line too long to wait for: enough for
   * the longest secret it knows to still be arriving in them.
   */
  readonly carry: number;

  /** @internal Use {@link createRedactor}. */
  constructor(
    private readonly rules: readonly Rule[],
    /** What it looks for (`odw doctor`). */
    readonly coverage: RedactionCoverage,
    longest: number,
    shapes?: Redactor,
  ) {
    this.shapes = shapes ?? this;
    this.carry = Math.min(MAX_CARRY, Math.max(MIN_CARRY, longest + 1));
  }

  /** Is there anything to redact at all? */
  get active(): boolean {
    return this.rules.length > 0;
  }

  /** `text` with each likely secret replaced by its marker — `text` itself when there is none. */
  text(text: string): string {
    let out = text;
    for (const rule of this.rules) out = out.replace(rule.re, rule.to);
    return out;
  }

  /**
   * A JSON-like value with every string in it redacted, object keys included —
   * the value itself (not a copy) when nothing was. Read as JSON.stringify
   * reads it: a `toJSON` is called, a cycle is left alone.
   */
  value<T>(value: T): T {
    return this.active ? (this.walk(value, [], { marked: false }) as T) : value;
  }

  /**
   * A saved record or an event, its fields redacted but those it is keyed by
   * ({@link NAMES}), and marked `redacted: true` when it holds a marker —
   * redacted now, or before it got here (a failure's message); the record
   * itself when it holds none.
   */
  record<T extends object>(record: T): T {
    if (!this.active) return record;
    const seen = { marked: false };
    let changed = false;
    const entries = Object.entries(record).map(([key, value]): [string, unknown] => {
      if (NAMES.has(key)) return [key, value];
      const after = this.walk(value, [], seen);
      if (after !== value) changed = true;
      return [key, after];
    });
    if (!changed && !seen.marked) return record;
    return { ...(changed ? Object.fromEntries(entries) : record), redacted: true } as T;
  }

  /**
   * One line of a JSONL stream (its newline, if any, kept): an event has its
   * strings redacted — its keys too — and is then written anew, marked
   * `"redacted": true`; any other line is redacted as text. A line with nothing
   * to redact comes back exactly as it was received.
   */
  jsonLine(line: string): string {
    if (!this.active) return line;
    const first = line.search(/\S/);
    if (first !== -1 && (line[first] === "{" || line[first] === "[")) {
      let event: unknown;
      try {
        event = JSON.parse(line);
      } catch {
        event = undefined; // not an event after all: text
      }
      if (typeof event === "object" && event !== null) {
        const out = this.value(event);
        if (out === event) return line;
        const marked = Array.isArray(out) ? out : { ...(out as object), redacted: true };
        return JSON.stringify(marked) + (line.endsWith("\n") ? "\n" : "");
      }
    }
    return this.text(line);
  }

  /** A stream of text arriving in chunks, redacted as it arrives (see {@link RedactStream}). */
  stream(): RedactStream {
    return new RedactStream(this);
  }

  /**
   * Where `text` may be cut near `at` without cutting a secret in two: `at`,
   * or the start of a secret that spans it.
   */
  cutBefore(text: string, at: number): number {
    let cut = Math.max(0, at);
    for (let moved = true; moved && cut > 0; ) {
      moved = false;
      for (const { re } of this.rules) {
        re.lastIndex = 0;
        for (let m = re.exec(text); m !== null && m.index < cut; m = re.exec(text)) {
          if (m.index + m[0].length > cut) {
            cut = m.index;
            moved = true;
            break;
          }
          if (m[0] === "") re.lastIndex++;
        }
        re.lastIndex = 0;
      }
    }
    return cut;
  }

  /**
   * Where the line starts of the last private key in `text` that begins
   * before `before` and has not ended — -1 when there is none, or when token
   * shapes are not redacted.
   */
  openKey(text: string, before: number): number {
    if (!this.coverage.patterns) return -1;
    let open = -1;
    KEY_BEGIN_RE.lastIndex = 0;
    for (let m = KEY_BEGIN_RE.exec(text); m !== null && m.index < before; m = KEY_BEGIN_RE.exec(text)) open = m.index;
    KEY_BEGIN_RE.lastIndex = 0;
    if (open === -1) return -1;
    KEY_END_RE.lastIndex = open;
    const ended = KEY_END_RE.test(text);
    KEY_END_RE.lastIndex = 0;
    return ended ? -1 : text.lastIndexOf("\n", open) + 1;
  }

  /** `value` redacted (see {@link value}); `seen.marked` is set once a string of it holds a marker. */
  private walk(value: unknown, path: object[], seen: { marked: boolean }): unknown {
    if (typeof value === "string") {
      const out = this.text(value);
      if (!seen.marked && hasMarker(out)) seen.marked = true;
      return out;
    }
    if (value === null || typeof value !== "object" || path.includes(value)) return value;
    const toJSON = (value as { toJSON?: unknown }).toJSON;
    if (typeof toJSON === "function") {
      const json: unknown = toJSON.call(value);
      if (json === value) return value;
      const after = this.walk(json, path, seen);
      return after === json ? value : after;
    }
    path.push(value);
    try {
      if (Array.isArray(value)) {
        let changed = false;
        const out = value.map((item) => {
          const after = this.walk(item, path, seen);
          if (after !== item) changed = true;
          return after;
        });
        return changed ? out : value;
      }
      let changed = false;
      const entries = Object.keys(value).map((key): [string, unknown] => {
        const item = (value as Record<string, unknown>)[key];
        const name = this.walk(key, path, seen) as string;
        const after = this.walk(item, path, seen);
        if (name !== key || after !== item) changed = true;
        return [name, after];
      });
      // fromEntries makes every key an own property, `__proto__` included.
      return changed ? Object.fromEntries(entries) : value;
    } finally {
      path.pop();
    }
  }
}

const KEY_BEGIN_RE = new RegExp(KEY_BEGIN, "g");
const KEY_END_RE = new RegExp(KEY_END, "g");

/** Characters of a line still arriving that a stream holds before it lets the start of it go. */
const HOLD_CHARS = 32 * 1024;
/** Characters a stream holds, at most, of a private key whose end line has not come. */
const KEY_HOLD_CHARS = 64 * 1024;

/**
 * Text arriving in chunks (an agent's stdout), redacted as it arrives without
 * holding it whole: whole lines go at once; a line still arriving waits for its
 * end — one that grows too long goes but for its last few characters (the
 * redactor's `carry`), never cut inside a secret; and a private key's lines
 * wait for its end line. So a secret split across two chunks is still redacted.
 */
export class RedactStream {
  private held = "";

  constructor(private readonly redactor: Redactor) {}

  /** What the stream printed next. Returns what can be kept of it now, redacted ("" while it waits). */
  write(chunk: string): string {
    this.held += chunk;
    const cut = this.cutPoint();
    if (cut <= 0) return "";
    const ready = this.held.slice(0, cut);
    this.held = this.held.slice(cut);
    return this.redactor.text(ready);
  }

  /** The stream ended (or is set aside): all it held, redacted. */
  end(): string {
    const rest = this.held;
    this.held = "";
    return rest && this.redactor.text(rest);
  }

  /** How much of what is held can go now. */
  private cutPoint(): number {
    const text = this.held;
    let cut = text.lastIndexOf("\n") + 1;
    if (text.length - cut > HOLD_CHARS) cut = this.redactor.cutBefore(text, text.length - this.redactor.carry);
    const open = this.redactor.openKey(text, cut);
    if (open !== -1 && text.length - open <= KEY_HOLD_CHARS) cut = Math.min(cut, open);
    return cut;
  }
}

// --- building one -------------------------------------------------------------------

export interface RedactorOptions {
  /**
   * The environments whose secret-named variables' values are redacted
   * (`redact.env`): odw's own, each adapter's `env`.
   */
  env?: ReadonlyArray<Readonly<Record<string, string | undefined>> | undefined>;
}

/**
 * A redactor for the `redact` setting — `false` for one that redacts nothing,
 * absent for the defaults — over `options.env`. Throws on an `extra`
 * expression that does not compile (the config loader refuses those first).
 */
export function createRedactor(setting: RedactSettings | false | null | undefined, options: RedactorOptions = {}): Redactor {
  if (setting === false) return new Redactor([], { off: true, env: false, variables: [], patterns: false, extra: 0 }, 0);
  const on = setting ?? DEFAULTS;
  const extra = (on.extra ?? []).map(extraRule);
  const shapeRules = [...(on.patterns ? [SHAPES_RULE] : []), ...extra];
  const { values, names } = on.env ? envValues(options.env) : { values: new Map<string, string>(), names: new Set<string>() };
  const variables = [...names].sort();
  const coverage = { off: false, env: on.env, variables, patterns: on.patterns, extra: extra.length };
  const shapes = new Redactor(shapeRules, { ...coverage, env: false, variables: [] }, 0);
  const longest = Math.max(0, ...[...values.keys()].map((value) => value.length));
  // The environment's exact values first (they say which variable), then the shapes, then any NAME=value left.
  const rules = [
    ...(values.size > 0 ? [envRule(values)] : []),
    ...(on.patterns ? [SHAPES_RULE] : []),
    ...(on.env ? [ASSIGNMENT_RULE] : []),
    ...extra,
  ];
  return new Redactor(rules, coverage, longest, shapes);
}

/**
 * A run's redactor: its config's `redact`, over the environment odw starts
 * agents and exec() commands with — its own (`env`), and each adapter's `env`.
 */
export function redactorFor(config: Pick<Config, "adapters" | "settings">, env: Readonly<Record<string, string | undefined>> = process.env): Redactor {
  return createRedactor(config.settings.redact, {
    env: [env, ...Object.values(config.adapters).map((adapter) => adapter.env)],
  });
}
