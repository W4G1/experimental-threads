import { assertEquals } from "@std/assert";
import { delay } from "@std/async";
import { shutdown, spawn } from "experimental-threads";
import {
  getCounter,
  getSignal,
  setCounter,
  setSignal,
  sharedMutex,
} from "./shared.ts";

Deno.test("Nested Worker Mutex Locking", async () => {
  try {
    setSignal(0);

    // Main thread takes the lock first
    // We store the guard to access data and to unlock later
    const guard = await sharedMutex.value.lock();

    // Use the exposed value from the lock to set data safely
    new Int32Array(guard.value).set([1]);

    // Start worker chain (Main -> W1 -> W2)
    const task = eval(spawn(async () => {
      // W1 reads unsafely (without lock) to verify Main thread's write
      if (getCounter() !== 1) throw new Error("W1 read failed");

      // W1 updates unsafely
      setCounter(2);

      await eval(spawn(async () => {
        // Signal we are ready, then try to lock
        setSignal(1);

        const start = performance.now();

        // This attempts to lock. It will block until Main calls guard[Symbol.dispose]()
        using _lock = await sharedMutex.value.lock();

        // Verify we actually waited for Main to unlock
        if (performance.now() - start < 10) {
          throw new Error("Mutex failed to block");
        }

        // Now we safely hold the lock, verify W1's write
        if (getCounter() !== 2) throw new Error("W2 read failed");

        // Write final value
        setCounter(3);
      }));
    }));

    // Wait for W2 to be ready and blocked
    while (getSignal() === 0) await delay(10);
    await delay(20); // Small buffer to ensure W2 hit the lock

    // Unlock Main, allowing W2 to finish
    guard[Symbol.dispose]();

    await task;
    assertEquals(getCounter(), 3);
  } finally {
    shutdown();
  }
});
