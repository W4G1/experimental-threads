import { shutdown, spawn } from "experimental-threads";
import type { Config } from "./h-types-aux.ts";

Deno.test("type-only annotation inside spawned fn does not break eval", async () => {
  try {
    const r = await eval(spawn(() => {
      const c: Config = { n: 5 };
      return c.n;
    }));
    if (r !== 5) throw new Error(`BUG: got ${r}`);
  } finally {
    shutdown();
  }
});
