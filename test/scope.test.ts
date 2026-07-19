import { assertEquals } from "@std/assert";
import { Global, scope, shutdown, spawn } from "experimental-threads";

const counter = new Global(new SharedArrayBuffer(4));

Deno.test("scope joins unawaited threads on dispose", async () => {
  try {
    {
      await using _s = scope();
      eval(spawn(() => {
        Atomics.add(new Int32Array(counter.value), 0, 1);
      }));
      eval(spawn(() => {
        Atomics.add(new Int32Array(counter.value), 0, 1);
      }));
    }
    // Both threads are guaranteed to have finished here.
    assertEquals(Atomics.load(new Int32Array(counter.value), 0), 2);
  } finally {
    shutdown();
  }
});
