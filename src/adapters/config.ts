/**
 * Configuration loader (L1) — STUB (M1).
 *
 * Will discover and load `odw.config.json`, merge it over the built-in adapters
 * and default settings, and resolve auto values (concurrency from CPU count,
 * runs root from `~/.odw/runs`). Sources, highest priority first:
 *
 *   1. an explicit path passed to {@link loadConfig}
 *   2. `$ODW_CONFIG`
 *   3. `./odw.config.json`
 *   4. `~/.config/odw/config.json`
 */

import { notImplemented } from "../errors.js";
import type { Config } from "./types.js";

export const CONFIG_ENV_VAR = "ODW_CONFIG";

export function loadConfig(_path?: string | null): Config {
  throw notImplemented("config loading (M1)");
}

export function defaultConfig(): Config {
  throw notImplemented("config loading (M1)");
}

/** Concrete concurrency cap, auto-derived from CPU count when unset. */
export function resolveConcurrency(concurrency: number | null): number {
  if (concurrency !== null) return Math.max(1, concurrency);
  // Mirror the reference runtime: at most 16, always leaving a couple of cores.
  // (cpus() is read here only as a pure helper; safe to compute now.)
  throw notImplemented("config loading (M1)");
}
