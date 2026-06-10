import { assertEquals } from "@std/assert";
import { shutdown, spawn } from "experimental-threads";

// Top-level spawn: the worker re-executes this module's top level, so this
// must run inline inside the worker instead of recursing into new workers
// forever.
const r = await eval(spawn(() => 1 + 1));

Deno.test({
  name: "top-level spawn completes without recursing",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: () => {
    try {
      assertEquals(r, 2);
    } finally {
      shutdown();
    }
  },
});
