/**
 * Dual-compat audit: prove a workflow's `meta` is a pure literal.
 *
 * The Claude Code Workflow tool extracts `meta` WITHOUT running the body, so it
 * accepts only a pure literal — no variables, calls, spreads, arithmetic, or
 * template interpolation. odw's own loader is deliberately lenient (it `eval`s
 * the span), so a workflow can drift to a `meta` Claude Code would reject and
 * still run here. This module is the guard rail that keeps a workflow portable
 * *back* to Claude Code: it parses the meta literal with a strict pure-literal
 * grammar and fails on anything Claude's static reader could not accept.
 *
 * It is a CI/test check only. It is intentionally NOT imported by the loader or
 * the CLI: the loader stays lenient and there is no runtime interception. The
 * grammar is the oracle the roadmap asks for — `JSON.parse` of the same span
 * would reject the dialect's unquoted keys and single quotes, so a real parser
 * that accepts JS literal syntax but rejects every *computed* form is used
 * instead.
 */

/** The result of auditing one workflow's meta. */
export interface MetaCheck {
  /** A `export const meta =` declaration was located. */
  found: boolean;
  /** The meta literal is pure (Claude-Code-portable). */
  pure: boolean;
  /** Why it is not found / not pure; null when pure. */
  reason: string | null;
  /** meta.name when the literal parsed, else null. */
  name: string | null;
}

const META_DECL = /export\s+const\s+meta\s*=/;

/** Audit the `meta` literal in a workflow's source. Never executes the body. */
export function checkMeta(source: string): MetaCheck {
  const m = META_DECL.exec(source);
  if (!m) {
    return { found: false, pure: false, reason: "no `export const meta =` declaration", name: null };
  }
  const parser = new LiteralParser(source, m.index + m[0].length);
  try {
    const value = parser.parse();
    const name = isRecord(value) && typeof value.name === "string" ? value.name : null;
    return { found: true, pure: true, reason: null, name };
  } catch (err) {
    if (err instanceof ImpureError) {
      return { found: true, pure: false, reason: err.message, name: null };
    }
    throw err;
  }
}

/** The filename stem (basename without extension) used by run-by-name. */
export function workflowStem(filename: string): string {
  const base = filename.split(/[\\/]/).pop() ?? filename;
  return base.replace(/\.[^.]*$/, "");
}

// --- the pure-literal grammar ------------------------------------------------

/** Thrown when the meta literal contains anything a static reader cannot accept. */
class ImpureError extends Error {}

/**
 * A recursive-descent parser for exactly the pure-literal subset: objects and
 * arrays of strings, numbers, booleans, null, nested objects/arrays — and
 * nothing else. Any identifier in value position (a variable / call), a spread,
 * a template interpolation, or an operator between values raises {@link ImpureError}.
 */
class LiteralParser {
  private pos: number;

  constructor(
    private readonly src: string,
    start: number,
  ) {
    this.pos = start;
  }

  /** Parse the single meta value (an object). The body after it is ignored. */
  parse(): unknown {
    this.skipTrivia();
    if (this.src[this.pos] !== "{") throw new ImpureError("meta must be an object literal");
    return this.parseValue();
  }

  private parseValue(): unknown {
    this.skipTrivia();
    const ch = this.src[this.pos];
    if (ch === undefined) throw new ImpureError("unexpected end of meta literal");
    if (ch === "{") return this.parseObject();
    if (ch === "[") return this.parseArray();
    if (ch === '"' || ch === "'" || ch === "`") return this.parseString();
    if (ch === "-" || ch === "+" || (ch >= "0" && ch <= "9")) return this.parseNumber();
    const word = this.peekWord();
    if (word === "true" || word === "false" || word === "null") {
      this.pos += word.length;
      return word === "null" ? null : word === "true";
    }
    if (word) {
      throw new ImpureError(
        `non-literal value '${word}' (a variable, call, or computed expression) — ` +
          "meta must be a pure literal",
      );
    }
    throw new ImpureError(`unexpected token '${ch}' in meta — meta must be a pure literal`);
  }

  private parseObject(): Record<string, unknown> {
    this.expect("{");
    const obj: Record<string, unknown> = {};
    for (;;) {
      this.skipTrivia();
      const ch = this.src[this.pos];
      if (ch === "}") {
        this.pos++;
        return obj;
      }
      if (ch === ".") {
        throw new ImpureError("spread or computed member in meta — meta must be a pure literal");
      }
      const key = this.parseKey();
      this.skipTrivia();
      this.expect(":");
      obj[key] = this.parseValue();
      this.skipTrivia();
      const sep = this.src[this.pos];
      if (sep === ",") {
        this.pos++;
        continue;
      }
      if (sep === "}") {
        this.pos++;
        return obj;
      }
      throw new ImpureError(
        `expected ',' or '}' in meta object but found '${sep ?? "<eof>"}' — ` +
          "meta must be a pure literal",
      );
    }
  }

  private parseArray(): unknown[] {
    this.expect("[");
    const arr: unknown[] = [];
    for (;;) {
      this.skipTrivia();
      const ch = this.src[this.pos];
      if (ch === "]") {
        this.pos++;
        return arr;
      }
      if (ch === ".") {
        throw new ImpureError("spread in meta array — meta must be a pure literal");
      }
      arr.push(this.parseValue());
      this.skipTrivia();
      const sep = this.src[this.pos];
      if (sep === ",") {
        this.pos++;
        continue;
      }
      if (sep === "]") {
        this.pos++;
        return arr;
      }
      throw new ImpureError(
        `expected ',' or ']' in meta array but found '${sep ?? "<eof>"}' — ` +
          "meta must be a pure literal",
      );
    }
  }

  private parseKey(): string {
    this.skipTrivia();
    const ch = this.src[this.pos];
    if (ch === '"' || ch === "'") return this.parseString();
    const word = this.peekWord();
    if (word) {
      this.pos += word.length;
      return word;
    }
    if (ch !== undefined && ch >= "0" && ch <= "9") return String(this.parseNumber());
    if (ch === "[") {
      throw new ImpureError("computed property key in meta — meta must be a pure literal");
    }
    throw new ImpureError(
      `invalid property key starting at '${ch ?? "<eof>"}' — meta must be a pure literal`,
    );
  }

  private parseString(): string {
    const quote = this.src[this.pos]!;
    this.pos++;
    let out = "";
    while (this.pos < this.src.length) {
      const c = this.src[this.pos]!;
      if (c === "\\") {
        out += unescapeChar(this.src[this.pos + 1]);
        this.pos += 2;
        continue;
      }
      if (quote === "`" && c === "$" && this.src[this.pos + 1] === "{") {
        throw new ImpureError("template interpolation in meta — meta must be a pure literal");
      }
      if (c === quote) {
        this.pos++;
        return out;
      }
      out += c;
      this.pos++;
    }
    throw new ImpureError("unterminated string in meta literal");
  }

  private parseNumber(): number {
    const re = /[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/y;
    re.lastIndex = this.pos;
    const m = re.exec(this.src);
    if (!m) throw new ImpureError("invalid number in meta literal");
    this.pos += m[0].length;
    const after = this.src[this.pos];
    if (after !== undefined && /[A-Za-z_$]/.test(after)) {
      throw new ImpureError(
        `non-decimal numeric literal near '${m[0]}${after}' in meta — meta must be a pure literal`,
      );
    }
    return Number(m[0]);
  }

  private skipTrivia(): void {
    for (;;) {
      const c = this.src[this.pos];
      if (c === " " || c === "\t" || c === "\n" || c === "\r") {
        this.pos++;
        continue;
      }
      if (c === "/" && this.src[this.pos + 1] === "/") {
        while (this.pos < this.src.length && this.src[this.pos] !== "\n") this.pos++;
        continue;
      }
      if (c === "/" && this.src[this.pos + 1] === "*") {
        this.pos += 2;
        while (this.pos < this.src.length && !(this.src[this.pos] === "*" && this.src[this.pos + 1] === "/")) {
          this.pos++;
        }
        this.pos += 2;
        continue;
      }
      return;
    }
  }

  private expect(ch: string): void {
    if (this.src[this.pos] !== ch) {
      throw new ImpureError(`expected '${ch}' but found '${this.src[this.pos] ?? "<eof>"}' in meta`);
    }
    this.pos++;
  }

  private peekWord(): string | null {
    const re = /[A-Za-z_$][A-Za-z0-9_$]*/y;
    re.lastIndex = this.pos;
    const m = re.exec(this.src);
    return m ? m[0] : null;
  }
}

function unescapeChar(c: string | undefined): string {
  switch (c) {
    case "n":
      return "\n";
    case "t":
      return "\t";
    case "r":
      return "\r";
    case "b":
      return "\b";
    case "f":
      return "\f";
    case "v":
      return "\v";
    case "0":
      return "\0";
    default:
      return c ?? ""; // \" \' \` \\ \/ and the rest stand for themselves
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
