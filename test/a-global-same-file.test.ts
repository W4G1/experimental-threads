import { Mutex, Shared, shutdown, spawn } from "experimental-threads";

// Shared declared in the SAME file as the spawn() call (as in the README example)
const sharedLock = new Shared(new Mutex(new SharedArrayBuffer(4)));

Deno.test("Shared declared in spawning file is shared with worker", async () => {
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
        `BUG CONFIRMED: worker saw ${seen}, expected 42, memory not shared`,
      );
    }
  } finally {
    shutdown();
  }
});
