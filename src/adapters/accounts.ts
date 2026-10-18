/**
 * Several accounts of one CLI in one run (an ODW extension).
 *
 * The `accounts` setting names, per adapter, the logins it may run as — each
 * a config directory of its CLI's own:
 *
 *     "accounts": {
 *       "claude": [
 *         { "name": "work", "configDir": "~/.claude-work" },
 *         { "name": "home", "configDir": "~/.claude-home" }
 *       ]
 *     }
 *
 * Each entry becomes an adapter of its own, `<adapter>@<name>` (`claude@work`):
 * the same definition as its adapter, with the CLI's documented config-dir
 * variable set to the account's directory, and its own concurrency cap and
 * quota breaker (both are kept per adapter name). An adapter whose CLI has no
 * such variable is refused: two logins would share one directory.
 *
 *   - Claude Code: `CLAUDE_CONFIG_DIR` moves `~/.claude` and `~/.claude.json`
 *     (https://code.claude.com/docs/en/settings#environment-variables).
 *   - Codex: `CODEX_HOME` moves `~/.codex` — its `auth.json` and `config.toml`
 *     (https://developers.openai.com/codex/config-advanced#config-and-state-locations).
 *
 * A call on the adapter itself (`adapter: "claude"`, the default adapter, a
 * fallback chain naming it) means "any of its accounts": the bridge expands it
 * into a chain of the accounts, ordered by headroom ({@link byHeadroom}), and
 * hands the work over when one runs out (see ../handoff). A call naming one
 * account (`adapter: "claude@work"`) runs on that one alone.
 *
 * Whether one person may pool several accounts is up to each provider's
 * terms of service; ODW only switches between the logins it is given.
 */

import { ConfigError } from "../errors.js";
import { cliConfigOf } from "./sandbox.js";
import type { Adapter } from "./types.js";

/** What an account adapter is (an ODW extension): the adapter it is an account of, and its login. */
export interface AccountOf {
  /** The adapter it is an account of (`claude`). */
  adapter: string;
  /** The account's name (`work`). */
  name: string;
  /** Its config directory, `~` expanded. */
  configDir: string;
  /** The CLI's variable that points it there (`CLAUDE_CONFIG_DIR`). */
  dirEnv: string;
}

/** An account's name: letters, digits, `_`, `-` and `.`. */
export const ACCOUNT_NAME = /^[\w.-]+$/;

const KNOWN_ACCOUNT_KEYS = ["name", "configDir", "concurrency", "label"] as const;

/**
 * Validate `accounts` and add an adapter per account to `adapters` (in
 * place): adapter name → its accounts' adapter names, in config order. Every
 * mistake is a ConfigError naming where it is.
 */
export function buildAccounts(
  raw: unknown,
  adapters: Record<string, Adapter>,
  expandHome: (path: string) => string,
): Record<string, string[]> {
  const shape = `{ "<adapter>": [{ "name": "<account>", "configDir": "<dir>" }, …] }`;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ConfigError(`"accounts" must be an object: ${shape}; got ${JSON.stringify(raw)}`);
  }
  const pools: Record<string, string[]> = {};
  for (const [base, entries] of Object.entries(raw as Record<string, unknown>)) {
    if (base.startsWith("$") || base.startsWith("//")) continue; // comment conventions
    const where = `"accounts.${base}"`;
    const adapter = Object.prototype.hasOwnProperty.call(adapters, base) ? adapters[base]! : undefined;
    if (!adapter) {
      throw new ConfigError(`${where} names unknown adapter '${base}'; available: ${Object.keys(adapters).sort().join(", ")}`);
    }
    if (adapter.account) throw new ConfigError(`${where}: '${base}' is itself an account`);
    const dirEnv = cliConfigOf(adapter.command)?.def.dirEnv;
    if (!dirEnv) {
      throw new ConfigError(
        `${where}: ODW knows no config-dir variable of '${adapter.command[0]}' to give each account its own login ` +
          `(claude: CLAUDE_CONFIG_DIR, codex: CODEX_HOME), so its accounts cannot be told apart`,
      );
    }
    if (!Array.isArray(entries) || entries.length === 0) {
      throw new ConfigError(`${where} must be a non-empty list of accounts: [{ "name": "<account>", "configDir": "<dir>" }, …]`);
    }
    const names: string[] = [];
    for (const [i, entry] of entries.entries()) {
      const at = `${where}[${i}]`;
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
        throw new ConfigError(`${at} must be an object: { "name": "<account>", "configDir": "<dir>" }; got ${JSON.stringify(entry)}`);
      }
      const spec = entry as Record<string, unknown>;
      const unknown = Object.keys(spec).filter((key) => !(KNOWN_ACCOUNT_KEYS as readonly string[]).includes(key));
      if (unknown.length > 0) {
        throw new ConfigError(`${at} takes ${KNOWN_ACCOUNT_KEYS.join(", ")}; got ${unknown.map((key) => JSON.stringify(key)).join(", ")}`);
      }
      if (typeof spec.name !== "string" || !ACCOUNT_NAME.test(spec.name)) {
        throw new ConfigError(`${at}.name must be letters, digits, "_", "-" and "."; got ${JSON.stringify(spec.name)}`);
      }
      if (typeof spec.configDir !== "string" || spec.configDir.trim() === "") {
        throw new ConfigError(`${at}.configDir must be the account's config directory; got ${JSON.stringify(spec.configDir)}`);
      }
      const configDir = expandHome(spec.configDir);
      if (!configDir.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(configDir)) {
        throw new ConfigError(`${at}.configDir must be an absolute path or start with ~/; got ${JSON.stringify(spec.configDir)}`);
      }
      const name = `${base}@${spec.name}`;
      if (Object.prototype.hasOwnProperty.call(adapters, name)) {
        throw new ConfigError(`${at}: adapter '${name}' is already configured`);
      }
      const account: Adapter = {
        ...adapter,
        name,
        env: { ...adapter.env, [dirEnv]: configDir },
        account: { adapter: base, name: spec.name, configDir, dirEnv },
      };
      if (spec.label != null) {
        if (typeof spec.label !== "string") throw new ConfigError(`${at}.label must be a string; got ${JSON.stringify(spec.label)}`);
        account.label = spec.label;
      } else if (adapter.label !== undefined) {
        account.label = `${adapter.label} (${spec.name})`;
      }
      if (spec.concurrency != null) {
        if (typeof spec.concurrency !== "number" || !Number.isInteger(spec.concurrency) || spec.concurrency < 1) {
          throw new ConfigError(`${at}.concurrency must be a positive integer; got ${JSON.stringify(spec.concurrency)}`);
        }
        account.concurrency = spec.concurrency;
      }
      adapters[name] = account;
      names.push(name);
    }
    pools[base] = names;
  }
  return pools;
}

/** What the run has seen of one account so far: what {@link byHeadroom} orders by. */
export interface Headroom {
  /** In a quota pause: the quota breaker took it out, or — under quotaWait — its quota is spent until a reset. */
  out: boolean;
  /** Its quota failures this run. */
  quotaFailures: number;
  /** The run's agents routed to it and not yet settled. */
  running: number;
}

/**
 * Order accounts by observed headroom: those not in a quota pause first, then
 * the fewest quota failures this run, then the fewest agents running on it;
 * ties keep the config's order.
 */
export function byHeadroom<T>(accounts: readonly T[], seen: (account: T) => Headroom): T[] {
  const keyed = accounts.map((account, i) => ({ account, i, h: seen(account) }));
  keyed.sort(
    (a, b) =>
      Number(a.h.out) - Number(b.h.out) ||
      a.h.quotaFailures - b.h.quotaFailures ||
      a.h.running - b.h.running ||
      a.i - b.i,
  );
  return keyed.map((k) => k.account);
}

/**
 * The argv that asks a CLI whether it is logged in without calling a model
 * (for `odw doctor`), run with the account's config-dir variable; null when
 * the CLI has none ODW knows — the doctor then says "not checked".
 *
 *   - Claude Code: `claude auth status` exits 0 when logged in, 1 when not
 *     (https://code.claude.com/docs/en/cli-reference).
 *   - Codex: `codex login status` exits 0 when logged in, non-zero when not
 *     (https://developers.openai.com/codex/cli/reference).
 */
export function loginCheckArgv(adapter: Adapter): string[] | null {
  const known = cliConfigOf(adapter.command);
  const exe = adapter.command[0]!;
  if (known?.cli === "claude") return [exe, "auth", "status"];
  if (known?.cli === "codex") return [exe, "login", "status"];
  return null;
}
