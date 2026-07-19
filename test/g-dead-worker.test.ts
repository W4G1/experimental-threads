import { shutdown, spawn } from "experimental-threads";

// Single call site so both invocations hit the same worker pool.
function task(n: number) {
  return eval(spawn(() => {
    setTimeout(() => (globalThis as any).self.close(), 50);
    return n;
  }));
}

Deno.test({
  name: "worker that dies after a task is not reused from the pool",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    try {
      const r1 = await task(1);
      if (r1 !== 1) throw new Error("first task failed");

      // Worker self-closes 50ms later while idle in the pool.
      await new Promise((r) => setTimeout(r, 300));

      const r2 = await Promise.race([
        task(2),
        new Promise((r) => setTimeout(() => r("TIMEOUT"), 3000)),
      ]);
      if (r2 === "TIMEOUT") {
        throw new Error(
          "BUG CONFIRMED: second task hung because a dead worker was reused from the pool",
        );
      }
    } finally {
      shutdown();
    }
  },
});
