import { assertEquals, assertRejects } from "@std/assert";
import { shutdown, spawn } from "experimental-threads";

Deno.test("cancel() fires the closure's AbortSignal", async () => {
  try {
    const handle = eval(spawn(async (signal?: AbortSignal) => {
      while (!signal!.aborted) {
        await new Promise((r) => setTimeout(r, 20));
      }
      return "cancelled";
    }));

    handle.cancel();
    assertEquals(await handle, "cancelled");
  } finally {
    shutdown();
  }
});

Deno.test("abort() hard-terminates the worker and rejects", async () => {
  try {
    const handle = eval(spawn(async () => {
      await new Promise((r) => setTimeout(r, 60_000));
      return "never";
    }));

    setTimeout(() => handle.abort(), 50);
    await assertRejects(
      async () => {
        await handle;
      },
      Error,
      "Thread aborted",
    );
  } finally {
    shutdown();
  }
});
