import type { Clock, Limits } from "./types.js";
import {
  cancelled,
  LLMConfigurationError,
  LLMError,
  timeout,
} from "./errors.js";
export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
};
interface Entry {
  at: number;
  tokens: number;
}
interface Pool {
  active: number;
  history: Entry[];
  limits: Required<Limits>;
}
interface Job {
  tokens: number;
  pools: Pool[];
  resolve: (release: (actual?: number) => void) => void;
  reject: (e: unknown) => void;
  cleanup: () => void;
}
function pool(limits: Limits, scoped = false): Pool {
  const compiled = {
    concurrency: scoped ? Infinity : 20,
    rpm: Infinity,
    tpm: Infinity,
    queueSize: 1000,
    queueTimeoutMs: 30000,
    windowMs: 60000,
    ...limits,
  };
  for (const [key, value] of Object.entries(compiled))
    if (
      !(value > 0) ||
      (!Number.isFinite(value) &&
        !["rpm", "tpm", ...(scoped ? ["concurrency"] : [])].includes(key)) ||
      (!Number.isInteger(value) && value !== Infinity)
    )
      throw new LLMConfigurationError(`Invalid scheduler limit: ${key}`);
  return { active: 0, history: [], limits: Object.freeze(compiled) };
}
/** Single admission queue atomically reserves all configured pools, preventing partial quota acquisition. */
export class MemoryScheduler {
  private global: Pool;
  private scopes: Record<string, Pool>;
  private queue: Job[] = [];
  private timer?: unknown;
  private closed = false;
  readonly limits: Required<Limits>;
  constructor(
    limits: Limits = {},
    private clock: Clock = systemClock,
    scopes: Record<string, Limits> = {},
  ) {
    this.global = pool(limits);
    this.limits = this.global.limits;
    this.scopes = Object.fromEntries(
      Object.entries(scopes).map(([k, v]) => [k, pool(v, true)]),
    );
  }
  snapshot() {
    return {
      active: this.global.active,
      queued: this.queue.length,
      limits: { ...this.limits },
      scopes: Object.fromEntries(
        Object.entries(this.scopes).map(([k, p]) => [
          k,
          { active: p.active, limits: { ...p.limits } },
        ]),
      ),
    };
  }
  acquire(
    tokens: number,
    signal?: AbortSignal,
    scopeKeys: string[] = [],
  ): Promise<(actual?: number) => void> {
    if (this.closed || signal?.aborted) return Promise.reject(cancelled());
    const pools = [
      this.global,
      ...new Set(
        scopeKeys
          .filter((k) => Object.hasOwn(this.scopes, k))
          .map((k) => this.scopes[k]),
      ),
    ];
    if (!Number.isFinite(tokens) || tokens < 0)
      return Promise.reject(
        new LLMConfigurationError("Invalid token estimate"),
      );
    if (pools.some((p) => tokens > p.limits.tpm))
      return Promise.reject(
        new LLMError("RATE_LIMIT", "Reservation exceeds TPM capacity"),
      );
    if (
      this.queue.length >= this.limits.queueSize ||
      pools.some(
        (p) =>
          this.queue.filter((j) => j.pools.includes(p)).length >=
          p.limits.queueSize,
      )
    )
      return Promise.reject(
        new LLMError("OVERLOADED", "Scheduler queue is full"),
      );
    return new Promise((resolve, reject) => {
      let expiry: unknown;
      const remove = (error: LLMError) => {
        const i = this.queue.indexOf(job);
        if (i < 0) return;
        this.queue.splice(i, 1);
        job.cleanup();
        reject(error);
        this.pump();
      };
      const onAbort = () => remove(cancelled());
      const job: Job = {
        tokens,
        pools,
        resolve,
        reject,
        cleanup: () => {
          this.clock.clearTimeout(expiry);
          signal?.removeEventListener("abort", onAbort);
        },
      };
      expiry = this.clock.setTimeout(
        () => remove(timeout("Queue")),
        Math.min(...pools.map((p) => p.limits.queueTimeoutMs)),
      );
      signal?.addEventListener("abort", onAbort, { once: true });
      this.queue.push(job);
      this.pump();
    });
  }
  private pump() {
    if (this.timer !== undefined) {
      this.clock.clearTimeout(this.timer);
      this.timer = undefined;
    }
    const now = this.clock.now();
    while (this.queue.length) {
      const job = this.queue[0];
      let waitUntil = Infinity,
        blocked = false;
      for (const p of job.pools) {
        p.history = p.history.filter((x) => x.at + p.limits.windowMs > now);
        if (p.active >= p.limits.concurrency) blocked = true;
        if (
          p.history.length >= p.limits.rpm ||
          p.history.reduce((n, x) => n + x.tokens, 0) + job.tokens >
            p.limits.tpm
        ) {
          blocked = true;
          if (p.history.length)
            waitUntil = Math.min(
              waitUntil,
              p.history[0].at + p.limits.windowMs,
            );
        }
      }
      if (blocked) {
        if (Number.isFinite(waitUntil))
          this.timer = this.clock.setTimeout(
            () => this.pump(),
            Math.max(1, waitUntil - now),
          );
        break;
      }
      this.queue.shift();
      job.cleanup();
      const reservations = job.pools.map((p) => {
        p.active++;
        const entry = { at: now, tokens: job.tokens };
        if (Number.isFinite(p.limits.rpm) || Number.isFinite(p.limits.tpm))
          p.history.push(entry);
        return { p, entry };
      });
      let released = false;
      job.resolve((actual) => {
        if (released) return;
        released = true;
        for (const { p, entry } of reservations) {
          p.active--;
          if (actual !== undefined && Number.isFinite(actual) && actual >= 0)
            entry.tokens = actual;
        }
        this.pump();
      });
    }
  }
  close() {
    this.closed = true;
    if (this.timer !== undefined) this.clock.clearTimeout(this.timer);
    for (const job of this.queue.splice(0)) {
      job.cleanup();
      job.reject(cancelled());
    }
  }
}
