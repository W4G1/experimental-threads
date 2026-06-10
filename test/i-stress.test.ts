import { shutdown, spawn } from "experimental-threads";
import { counter } from "./i-stress-shared.ts";

Deno.test({
  name: "mutex guarantees mutual exclusion under contention",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    try {
      const WORKERS = 4;
      const ITERS = 500;

      const tasks = [];
      for (let w = 0; w < WORKERS; w++) {
        tasks.push(eval(spawn(async () => {
          for (let i = 0; i < ITERS; i++) {
            using guard = await counter.value.lock();
            const view = new Int32Array(guard.value);
            const v = view[0]!;
            // force an interleaving window while holding the lock
            await new Promise((r) => setTimeout(r, 0));
            view[0] = v + 1;
          }
        })));
      }
      await Promise.all(tasks);

      using guard = await counter.value.lock();
      const total = new Int32Array(guard.value)[0];
      if (total !== WORKERS * ITERS) {
        throw new Error(
          `BUG: lost updates — got ${total}, expected ${WORKERS * ITERS}`,
        );
      }
      console.log(`OK: ${total} increments, no lost updates`);
    } finally {
      shutdown();
    }
  },
});
