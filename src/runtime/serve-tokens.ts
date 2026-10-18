/**
 * Named tokens for `odw serve --tokens FILE` (ODW extension): several people
 * read, and perhaps answer checkpoints on, one dashboard, each with a token
 * of their own — so what they do is attributed to them, and one can be
 * withdrawn without the others.
 *
 * The file is a JSON array of `{ name, scope: "read" | "approve", hash }`,
 * `hash` the sha256 of the token in lowercase hex: it never holds a token.
 * `odw token add <name> [--scope approve] --file FILE` prints a new random
 * token once and appends its hash; `odw token list|remove` read and edit it.
 * The file is written 0600, atomically.
 */

import { createHash } from "node:crypto";
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";

import { expandHome } from "../adapters/config.js";
import { generateToken } from "./serve-auth.js";

export type TokenScope = "read" | "approve";

/** One named token, as the file keeps it. */
export interface NamedToken {
  name: string;
  scope: TokenScope;
  /** sha256 of the token, lowercase hex. */
  hash: string;
}

/** A token's name: 1–64 of letters, digits and `. _ @ + -`, starting with a letter or digit. */
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._@+-]{0,63}$/;
const HASH_RE = /^[0-9a-f]{64}$/;

/** Is `value` usable as a token's name? */
export function isTokenName(value: unknown): value is string {
  return typeof value === "string" && NAME_RE.test(value);
}

/** sha256 of a token, lowercase hex: what the file keeps of it. */
export function tokenHash(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** Why a token file cannot be used. */
export class TokenFileError extends Error {}

/** The tokens of `text` (a token file's content); throws a TokenFileError naming what is wrong. */
export function parseTokens(text: string, file = "the token file"): NamedToken[] {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (err) {
    throw new TokenFileError(`${file} is not JSON: ${(err as Error).message}`);
  }
  if (!Array.isArray(data)) throw new TokenFileError(`${file} must be a JSON array of { name, scope, hash }`);
  const names = new Set<string>();
  const hashes = new Set<string>();
  return data.map((entry, i) => {
    const e = (entry !== null && typeof entry === "object" ? entry : {}) as Record<string, unknown>;
    if (!isTokenName(e.name)) throw new TokenFileError(`${file}[${i}]: name must be 1-64 of A-Z a-z 0-9 . _ @ + - (starting with a letter or digit)`);
    if (e.scope !== "read" && e.scope !== "approve") throw new TokenFileError(`${file}[${i}] (${e.name}): scope must be "read" or "approve"`);
    if (typeof e.hash !== "string" || !HASH_RE.test(e.hash)) {
      throw new TokenFileError(`${file}[${i}] (${e.name}): hash must be the token's sha256, 64 lowercase hex characters — never the token`);
    }
    if (names.has(e.name)) throw new TokenFileError(`${file}: the name ${e.name} is there twice`);
    if (hashes.has(e.hash)) throw new TokenFileError(`${file}: ${e.name}'s hash is another token's too`);
    names.add(e.name);
    hashes.add(e.hash);
    return { name: e.name, scope: e.scope, hash: e.hash };
  });
}

/** The tokens of `file`; with `missingOk`, none when it does not exist. */
export function readTokens(file: string, options: { missingOk?: boolean } = {}): NamedToken[] {
  if (options.missingOk && !existsSync(file)) return [];
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (err) {
    throw new TokenFileError(`cannot read ${file}: ${(err as Error).message}`);
  }
  return parseTokens(text, file);
}

/** Write `tokens` to `file`, 0600, atomically. */
export function writeTokens(file: string, tokens: NamedToken[]): void {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(tokens, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
}

/** Add a token named `name` to `file` (created when missing); returns the token, which nothing keeps. */
export function addToken(file: string, name: string, scope: TokenScope = "read"): string {
  if (!isTokenName(name)) throw new TokenFileError("a token's name is 1-64 of A-Z a-z 0-9 . _ @ + - (starting with a letter or digit)");
  const tokens = readTokens(file, { missingOk: true });
  if (tokens.some((t) => t.name === name)) throw new TokenFileError(`${file} already has a token named ${name}: odw token remove ${name} first`);
  const token = generateToken();
  writeTokens(file, [...tokens, { name, scope, hash: tokenHash(token) }]);
  return token;
}

const TOKEN_USAGE =
  "usage: odw token add <name> [--scope read|approve] --file FILE\n" +
  "       odw token list --file FILE [--json]\n" +
  "       odw token remove <name> --file FILE\n";

/**
 * `odw token add|list|remove` (ODW extension): the named tokens of an `odw
 * serve --tokens FILE`. `add` prints the new token on stdout, once — the file
 * keeps its hash only — and says the rest on stderr. A running server read
 * the file when it started: restart it to take a change.
 */
export function cmdToken(rest: string[]): number {
  const [sub, ...args] = rest;
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { file: { type: "string" }, scope: { type: "string" }, json: { type: "boolean" } },
  });
  const [name, extra] = positionals;
  const named = name !== undefined && extra === undefined;
  if (!values.file || !(sub === "list" ? positionals.length === 0 : (sub === "add" || sub === "remove") && named)) {
    process.stderr.write(TOKEN_USAGE);
    return 2;
  }
  const file = resolve(expandHome(values.file));
  try {
    if (sub === "list") {
      const tokens = readTokens(file, { missingOk: true });
      if (values.json) process.stdout.write(`${JSON.stringify(tokens.map((t) => ({ name: t.name, scope: t.scope })), null, 2)}\n`);
      else if (tokens.length === 0) process.stderr.write(`no tokens in ${file}\n`);
      else for (const t of tokens) process.stdout.write(`${t.name.padEnd(24)}  ${t.scope}\n`);
      return 0;
    }
    if (sub === "remove") {
      if (!removeToken(file, name!)) {
        process.stderr.write(`odw token: ${file} has no token named ${name}\n`);
        return 1;
      }
      process.stderr.write(`removed ${name} from ${file} — restart odw serve --tokens for it to take effect\n`);
      return 0;
    }
    const scope = values.scope ?? "read";
    if (scope !== "read" && scope !== "approve") {
      process.stderr.write("odw token: --scope is read or approve\n");
      return 2;
    }
    const token = addToken(file, name!, scope);
    process.stdout.write(`${token}\n`);
    process.stderr.write(
      `added ${name} (${scope}) to ${file}: the token above is shown once and kept nowhere — give it to ${name}\n` +
        `  odw serve --tokens ${file}   (restart a running one to take it)\n`,
    );
    return 0;
  } catch (err) {
    if (!(err instanceof TokenFileError)) throw err;
    process.stderr.write(`odw token: ${err.message}\n`);
    return 1;
  }
}

/** Remove the token named `name` from `file`; false when it has none. */
export function removeToken(file: string, name: string): boolean {
  const tokens = readTokens(file);
  const kept = tokens.filter((t) => t.name !== name);
  if (kept.length === tokens.length) return false;
  writeTokens(file, kept);
  return true;
}
