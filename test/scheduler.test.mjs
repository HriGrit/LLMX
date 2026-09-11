import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryScheduler } from "../dist/index.js";
class Clock {
  time = 0;
  timers = new Map();
  next = 0;
  now = () => this.time;
  setTimeout = (fn, ms) => {
    const id = this.next++;
    this.timers.set(id, { fn, at: this.time + ms });
    return id;
  };
  clearTimeout = (id) => this.timers.delete(id);
  advance(ms) {
    const end = this.time + ms;
    for (;;) {
      const next = [...this.timers.entries()]
        .filter(([, t]) => t.at <= end)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      this.time = next[1].at;
      this.timers.delete(next[0]);
      next[1].fn();
    }
    this.time = end;
  }
}
test("concurrency capacity is never exceeded and release is idempotent", async () => {
  const s = new MemoryScheduler({ concurrency: 1 });
  const a = await s.acquire(1);
  let admitted = false;
  const p = s.acquire(1).then((r) => {
    admitted = true;
    return r;
  });
  await Promise.resolve();
  assert.equal(admitted, false);
  assert.equal(s.snapshot().active, 1);
  a();
  a();
  const b = await p;
  assert.equal(s.snapshot().active, 1);
  b();
  assert.equal(s.snapshot().active, 0);
  s.close();
});
test("sliding RPM includes completed requests until exact expiry", async () => {
  const clock = new Clock(),
    s = new MemoryScheduler({ rpm: 1, queueTimeoutMs: 120000 }, clock);
  (await s.acquire(1))();
  let admitted = false;
  const p = s.acquire(1).then((r) => {
    admitted = true;
    return r;
  });
  clock.advance(59999);
  await Promise.resolve();
  assert.equal(admitted, false);
  clock.advance(1);
  (await p)();
  s.close();
});
test("TPM reservations refund actual usage and account for overruns", async () => {
  const clock = new Clock(),
    s = new MemoryScheduler({ tpm: 10, queueTimeoutMs: 120000 }, clock);
  const a = await s.acquire(8);
  const p = s.acquire(4);
  a(6);
  const b = await p;
  b(12);
  let admitted = false;
  const q = s.acquire(1).then((r) => {
    admitted = true;
    return r;
  });
  await Promise.resolve();
  assert.equal(admitted, false);
  clock.advance(60000);
  (await q)();
  s.close();
});
test("queued cancellation removes work without RPM or TPM charges", async () => {
  const clock = new Clock(),
    s = new MemoryScheduler({ concurrency: 1, rpm: 2 }, clock);
  const a = await s.acquire(3),
    c = new AbortController();
  const p = s.acquire(3, c.signal);
  c.abort();
  await assert.rejects(p, { code: "CANCELLED" });
  assert.equal(s.snapshot().queued, 0);
  a();
  (await s.acquire(3))();
  s.close();
});
test("queue timeout and bounded queue reject with typed errors", async () => {
  const clock = new Clock(),
    s = new MemoryScheduler(
      { concurrency: 1, queueSize: 1, queueTimeoutMs: 10 },
      clock,
    );
  const a = await s.acquire(1);
  const pending = s.acquire(1);
  await assert.rejects(s.acquire(1), { code: "OVERLOADED" });
  const check = assert.rejects(pending, { code: "TIMEOUT" });
  clock.advance(10);
  await check;
  a();
  s.close();
});
test("oversized token reservation fails immediately", async () => {
  const s = new MemoryScheduler({ tpm: 5 });
  await assert.rejects(s.acquire(6), { code: "RATE_LIMIT" });
  s.close();
});
test("invalid scheduler limits fail at construction", () => {
  for (const value of [0, -1, NaN, 1.5])
    assert.throws(() => new MemoryScheduler({ concurrency: value }), {
      code: "CONFIGURATION",
    });
});
test("scoped quotas reserve atomically and cancelled waiting jobs charge no pool", async () => {
  const clock = new Clock(),
    s = new MemoryScheduler({ rpm: 2, queueTimeoutMs: 120000 }, clock, {
      provider: { rpm: 1, queueTimeoutMs: 120000 },
    });
  (await s.acquire(1, undefined, ["provider"]))();
  const c = new AbortController();
  const p = s.acquire(1, c.signal, ["provider"]);
  c.abort();
  await assert.rejects(p, { code: "CANCELLED" });
  (await s.acquire(1))(); // Cancelled job did not consume global RPM.
  assert.equal(s.snapshot().active, 0);
  s.close();
});
