/**
 * The per-run context shared by the primitives — STUB wiring (M2).
 *
 * A {@link RunContext} is the single object a running workflow talks to,
 * indirectly, through the primitives. It bundles the wired-up layers (bridge,
 * scheduler), the control and event sink, the run's `args`, and the mutable
 * display state (`currentPhase`). {@link buildContext} is the one place that
 * wires the layers together from a {@link Config}.
 */

import { notImplemented } from "./errors.js";
import type { Config } from "./adapters/types.js";
import type { Bridge } from "./bridge.js";
import type { Scheduler } from "./scheduler.js";
import type { Control } from "./control.js";
import type { EventSink, WorkflowEvent } from "./events.js";

export interface RunContext {
  config: Config;
  bridge: Bridge;
  scheduler: Scheduler;
  control: Control;
  sink: EventSink;
  args: unknown;
  currentPhase: string | null;
  emit(ev: WorkflowEvent): void;
}

export interface BuildContextOptions {
  source?: string;
  args?: unknown;
  sink?: EventSink;
  control?: Control;
}

export function buildContext(_config: Config, _options: BuildContextOptions = {}): RunContext {
  throw notImplemented("context wiring (M2)");
}
