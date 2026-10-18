/**
 * Who is acting (ODW extension): the names runs and decisions are attributed to.
 *
 *   launchedBy (meta.json)   who started a run: locally the git user.email, else
 *                            $USER; a named `odw serve --tokens` token's name;
 *                            `trigger:<name>` for a signed trigger's run
 *   who (decisions, control) who answered a checkpoint or paused, resumed or
 *                            stopped a run: `cli:<$USER> <git user.email>` from
 *                            the CLI, a named token's name from the dashboard
 *
 * Names are labels, not credentials: a local user can write any of them into
 * a run directory. They say who did what among people who share one box.
 */

import { spawnSync } from "node:child_process";

/** A name kept on record: printable, at most this many characters. */
export const WHO_MAX = 200;

let cached: { user: string | null; email: string | null } | null = null;

/** The local user — $USER (or $USERNAME) and git's user.email, either null when unset — read once per process. */
export function localUser(): { user: string | null; email: string | null } {
  if (cached) return cached;
  const user = clean(process.env.USER ?? process.env.USERNAME ?? null);
  let email: string | null = null;
  try {
    const out = spawnSync("git", ["config", "user.email"], { encoding: "utf8", timeout: 2000, windowsHide: true });
    email = out.status === 0 ? clean(out.stdout) : null;
  } catch {
    email = null; // no git: the user alone
  }
  cached = { user, email };
  return cached;
}

/** Who a local launch is attributed to: the git user.email, else $USER; null when neither is set. */
export function localLauncher(): string | null {
  const { user, email } = localUser();
  return email ?? user;
}

/** Who a CLI decision or control is attributed to: `cli:<user> <email>`, `cli:<user>`, `cli:<email>`, or `cli`. */
export function cliActor(): string {
  const { user, email } = localUser();
  const name = user && email ? `${user} <${email}>` : (user ?? email);
  return clean(name ? `cli:${name}` : "cli")!;
}

/** A name as kept on record: trimmed, control characters out, at most {@link WHO_MAX} characters; null when empty. */
export function clean(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const text = value.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, WHO_MAX);
  return text === "" ? null : text;
}

/** Is `value` a name as {@link clean} keeps it (what a decision log's `who` may hold)? */
export function isWho(value: unknown): value is string {
  return typeof value === "string" && clean(value) === value;
}

/** Forget the cached local user (tests). */
export function resetLocalUser(): void {
  cached = null;
}
