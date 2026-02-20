import { assertEquals } from "@std/assert";
import { delay } from "@std/async";
import { shutdown, spawn } from "experimental-threads";
import { sharedMutex } from "./shared.ts";

Deno.test("Nested Worker Mutex Locking", async () => {
  try {
    // Main thread takes the lock first
    // We store the guard to access data and to unlock later
    using guard = await sharedMutex.value.lock();

    // Use the exposed value from the lock to set data safely
    new Int32Array(guard.value).set([1]);

    // Start worker chain (Main -> W1 -> W2)
    const task = eval(spawn(async () => {
      const start = performance.now();
      using guard = await sharedMutex.value.lock();

      // Verify we actually waited for parent thread to unlock
      if (performance.now() - start < 10) {
        throw new Error("Mutex failed to block");
      }

      const view = new Int32Array(guard.value);

      assertEquals(view[0], 1);

      view[0] = 2;

      const task2 = eval(spawn(async () => {
        const start = performance.now();

        // This attempts to lock. It will block until Main calls guard[Symbol.dispose]()
        using guard = await sharedMutex.value.lock();

        // Verify we actually waited for parent thread to unlock
        if (performance.now() - start < 10) {
          throw new Error("Mutex failed to block");
        }

        const view = new Int32Array(guard.value);

        // Now we safely hold the lock, verify W1's write
        if (view[0] !== 2) throw new Error("W2 read failed");

        // Write final value
        view[0] = 3;
      }));

      await delay(2000);

      guard.unlock();

      await task2;
    }));

    await delay(2000);

    // Unlock Main, allowing W2 to finish
    guard.unlock();

    await task;

    {
      using guard = await sharedMutex.value.lock();
      const view = new Int32Array(guard.value);
      assertEquals(view[0], 3);
    }
  } finally {
    shutdown();
  }
});
