import { Global, Mutex, shutdown, spawn } from "experimental-threads";

// Global declared in the SAME file as the spawn() call (as in the README example)
const sharedLock = new Global(new Mutex(new SharedArrayBuffer(4)));

Deno.test("Global declared in spawning file is shared with worker", async () => {
  try {
    {
      using guard = await sharedLock.value.lock();
      new Int32Array(guard.value)[0] = 42;
    }

    const seen = await eval(spawn(async () => {
      using guard = await sharedLock.value.lock();
      return new Int32Array(guard.value)[0];
    }));

    if (seen !== 42) {
      throw new Error(
        `BUG CONFIRMED: worker saw ${seen}, expected 42 — memory not shared`,
      );
    }
  } finally {
    shutdown();
  }
});
