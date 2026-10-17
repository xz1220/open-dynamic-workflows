/**
 * Per-agent ports (an ODW extension).
 *
 * Every agent process gets `ODW_PORT`, so a workflow can tell its agents
 * "start your dev server on $ODW_PORT" and parallel agents never fight over a
 * port. A {@link PortPool} hands them out for one run from
 * `settings.portRange`: unique among the run's agents running at once, held
 * for the whole agent call (every attempt of it) and released when it settles.
 *
 * Within that guarantee it prefers ports nothing on this machine listens on —
 * a server an earlier agent left behind, another run's agent, an unrelated
 * service — and it hands ports out round-robin from a random point of the
 * range, so a just-released port is not reused at once and two runs started
 * together rarely pick the same ones.
 */

import { createServer } from "node:net";

export class PortPool {
  private readonly held = new Set<number>();
  /** Offset into the range where the next search starts. */
  private cursor: number;

  constructor(
    private readonly first: number,
    private readonly last: number,
  ) {
    this.cursor = Math.floor(Math.random() * this.size);
  }

  private get size(): number {
    return this.last - this.first + 1;
  }

  /**
   * Claim a port no running agent of this run holds — one nothing listens on
   * when there is such a port — or `null` when this run's agents hold every
   * port of the range.
   */
  async acquire(): Promise<number | null> {
    for (let i = 0; i < this.size; i++) {
      const port = this.at(this.cursor + i);
      if (this.held.has(port)) continue;
      // Claimed before the probe awaits, so a concurrent acquire() moves on.
      this.held.add(port);
      if (await looksFree(port)) return this.claimed(port);
      this.held.delete(port);
    }
    // Everything unclaimed looks busy: the probe is a preference, uniqueness
    // within the run is the guarantee.
    for (let i = 0; i < this.size; i++) {
      const port = this.at(this.cursor + i);
      if (this.held.has(port)) continue;
      this.held.add(port);
      return this.claimed(port);
    }
    return null;
  }

  /** Give a port back once the agent holding it has settled. */
  release(port: number): void {
    this.held.delete(port);
  }

  private at(offset: number): number {
    return this.first + (offset % this.size);
  }

  private claimed(port: number): number {
    this.cursor = port - this.first + 1;
    return port;
  }
}

/**
 * Whether nothing listens on `port` on this machine's loopback addresses.
 * Best effort: only "address in use" counts as taken — a probe the system
 * refuses for any other reason (no IPv6, a sandbox) says nothing. Loopback
 * only, so the probe never asks a desktop firewall for permission.
 */
async function looksFree(port: number): Promise<boolean> {
  for (const host of ["127.0.0.1", "::1"]) {
    if (await inUse(port, host)) return false;
  }
  return true;
}

function inUse(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.unref();
    server.once("error", (err: NodeJS.ErrnoException) => resolve(err.code === "EADDRINUSE"));
    server.listen({ port, host, exclusive: true }, () => server.close(() => resolve(false)));
  });
}
