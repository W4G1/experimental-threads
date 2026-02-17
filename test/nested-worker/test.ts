import { assertEquals } from "@std/assert";
import { delay } from "@std/async";
import { shutdown, spawn } from "experimental-threads";
import { getRaw, rawMutex, setRaw } from "./shared.ts";

Deno.test("Nested Raw Mutex Serialization", async () => {
  try {
    const mainGuard = await rawMutex.lock();

    setRaw(rawMutex, 1);

    // Spawn W1
    const task = eval(spawn(async () => {
      // Check W1 read
      if (getRaw(rawMutex) !== 1) throw new Error("W1 read fail");
      setRaw(rawMutex, 2);

      // Spawn W2 (Nested)
      await eval(spawn(async () => {
        // Block until Main unlocks.
        // using 'using' automatically calls [Symbol.dispose]() at end of scope
        using _guard = await rawMutex.lock();

        // Check W2 read
        if (getRaw(rawMutex) !== 2) throw new Error("W2 read fail");
        setRaw(rawMutex, 3);
      }));
    }));

    // Wait for W2 to block, then Unlock Main
    await delay(100);

    // Unlock by disposing the guard
    mainGuard[Symbol.dispose]();

    await task;
    assertEquals(getRaw(rawMutex), 3);
  } finally {
    shutdown();
  }
});
