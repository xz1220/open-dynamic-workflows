/**
 * The model that served an agent, beside the one it asked for (an ODW
 * extension; `output.servedModel`, `modelMismatch`).
 *
 * A call's `model` is only a request: an organisation's allowlist, a plan, a
 * retired id or a CLI's own setting can put the agent on another model, and
 * the reply says nothing of it. Where a CLI's events name the model that
 * served the agent (Claude Code's init event, its assistant messages and the
 * result's `modelUsage`), ODW records it with the agent; a CLI that names
 * none is "not reported" — nothing is guessed, least of all from the reply.
 *
 * The comparison is lenient on spelling, strict on the model:
 *
 *   - a tier (`"@fast"`) is first the id the call sent its CLI;
 *   - case, a `[1m]`-style suffix and a provider prefix (`anthropic/…`,
 *     `us.anthropic.…`) do not count;
 *   - an alias or a shorter id matches a served id that holds it whole,
 *     between separators: `opus` and `claude-opus-4-8` match `claude-opus-4-8`
 *     and `claude-opus-4-8-20260101`, `sonnet` does not match `claude-opus-5-5`;
 *   - Claude Code's own aliases: `best` is opus, `opusplan` opus or sonnet,
 *     and `default` matches whatever its CLI picked.
 *
 * The agent was served as asked when any served model matches — a session
 * also spends on helper models (Claude Code summarises a WebFetch on haiku) —
 * and substituted when none does.
 */

/** Aliases that stand for more than their own name (Claude Code's model aliases). */
const ALIASES: Readonly<Record<string, readonly string[] | null>> = {
  /** Whatever the CLI's account defaults to: anything matches. */
  default: null,
  best: ["opus"],
  opusplan: ["opus", "sonnet"],
};

/** What a model id is compared as: lower case, without a `[…]` suffix. */
function normal(id: string): string {
  return id.trim().toLowerCase().replace(/\[[^\]]*\]$/, "");
}

/** The characters model ids are made of words with. */
const SEPARATOR = /[-._/:@\s]/;

/**
 * What may follow the requested name in a served id and still be the same
 * model: a version or date (`-4-5`, `-20250929`, `@20250929`) or a release
 * word. A word like `mini`, `nano`, `lite` or `flash` names another model —
 * `gpt-5-mini` is not `gpt-5`.
 */
const SAME_MODEL_TAIL = /^(?:\d+|latest|preview|exp|experimental|v\d+)$/;

/** Whether `served` holds `wanted` whole, between separators (or its ends), followed only by a version, date or release word. */
function holds(served: string, wanted: string): boolean {
  if (!wanted) return false;
  for (let at = served.indexOf(wanted); at !== -1; at = served.indexOf(wanted, at + 1)) {
    const before = at === 0 || SEPARATOR.test(served[at - 1]!);
    const end = at + wanted.length;
    const after = end === served.length || SEPARATOR.test(served[end]!);
    if (!before || !after) continue;
    const tail = served.slice(end).split(SEPARATOR).filter((word) => word !== "");
    if (tail.every((word) => SAME_MODEL_TAIL.test(word))) return true;
  }
  return false;
}

/** Whether a served model id is the requested one, by the rules above. */
export function sameModel(requested: string, served: string): boolean {
  const want = normal(requested);
  const got = normal(served);
  if (want === got) return true;
  const alias = Object.prototype.hasOwnProperty.call(ALIASES, want) ? ALIASES[want] : undefined;
  if (alias === null) return true;
  // A provider prefix on the request (`anthropic/claude-sonnet-4-5`) names the same model.
  const bare = want.includes("/") ? want.slice(want.lastIndexOf("/") + 1) : want;
  return (alias ?? [bare]).some((name) => holds(got, name));
}

/**
 * Whether the agent asked for `requested` was substituted: its CLI named the
 * models in `served` and none of them is it. False when it asked for no
 * model, or its CLI named none.
 */
export function isSubstituted(requested: string | undefined, served: readonly string[] | undefined): boolean {
  if (!requested || !served || served.length === 0) return false;
  return !served.some((model) => sameModel(requested, model));
}

/** What a run's log says of a substitution: who, the CLI, what was asked and what served it. */
export function substitutionNote(who: string, cli: string, requested: string, served: readonly string[], policy: "warn" | "fail"): string {
  const by = served.join(", ");
  return (
    `${who}: asked ${cli} for model '${requested}' but it was served by ${by} — ` +
    (policy === "fail"
      ? "it fails (modelMismatch: \"fail\")"
      : "its reply is kept; modelMismatch: \"fail\" fails such an agent")
  );
}
