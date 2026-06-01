/**
 * Cross-process run control backed by the run directory — STUB (M4).
 *
 * Same contract as the in-process controls in `control.ts`, but the pause/stop
 * signal arrives through a file the CLI writes. The worker polls that file at
 * each safe point. Decoupled from the {@link RunStore} through callbacks so it
 * has no knowledge of the directory layout.
 */

import { notImplemented } from "../errors.js";
import type { Control } from "../control.js";

export interface FileControlOptions {
  readAction: () => string | null;
  onState?: (state: string) => void;
  pollIntervalMs?: number;
}

export class FileControl implements Control {
  constructor(private readonly options: FileControlOptions) {
    void this.options;
  }

  checkpoint(): Promise<void> {
    throw notImplemented("file control (M4)");
  }

  state(): string {
    throw notImplemented("file control (M4)");
  }
}
