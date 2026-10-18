/**
 * Prefixed to every git odw runs on the host: no fsmonitor and no hooks,
 * whatever the repository's config says. A worktree's agent can write its
 * files (and, in a container sandbox, nothing of its git metadata — see
 * adapters/sandbox.ts), so a command its config names must never run here.
 */
export const SAFE_GIT: readonly string[] = ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null"];
