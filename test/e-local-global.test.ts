import { Mutex, Shared, shutdown, spawn } from "experimental-threads";

Deno.test("Shared held in a local variable works in worker", async () => {
  try {
    const g = new Shared(new Mutex(new SharedArrayBuffer(4)));
    {
      using guard = await g.value.lock();
      new Int32Array(guard.value)[0] = 7;
    }

    const seen = await eval(spawn(async () => {
      using guard = await g.value.lock();
      return new Int32Array(guard.value)[0];
    }));

    if (seen !== 7) throw new Error(`BUG: worker saw ${seen}`);
  } finally {
    shutdown();
  }
});
