/**
 * Placeholder expansion for adapter command templates.
 *
 * An adapter command is a list of argument templates such as
 * `["codex", "exec", "--cd", "{workspace}", "-"]`. Before a command runs, every
 * known `{name}` token is replaced with a value from the call context. Unknown
 * `{...}` tokens are left untouched so literal braces survive; a known token
 * missing from the context expands to an empty string.
 */

export const PLACEHOLDERS = [
  "prompt",
  "prompt_file",
  "workspace",
  "source",
  "adapter",
  "role",
] as const;

export type PlaceholderName = (typeof PLACEHOLDERS)[number];
export type PlaceholderContext = Partial<Record<PlaceholderName, string>>;

const TOKEN = new RegExp(`\\{(${PLACEHOLDERS.join("|")})\\}`, "g");

/** Replace every known `{placeholder}` in `template` using `context`. */
export function expand(template: string, context: PlaceholderContext): string {
  return template.replace(TOKEN, (_match, name: PlaceholderName) => context[name] ?? "");
}

/** Expand a list of argument templates. */
export function expandAll(templates: string[], context: PlaceholderContext): string[] {
  return templates.map((t) => expand(t, context));
}
