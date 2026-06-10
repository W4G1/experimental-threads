import { shutdown, spawn } from "experimental-threads";

Deno.test("for-of loop variable is captured", async () => {
  try {
    for (const item of [10]) {
      const r = await eval(spawn(() => item + 1));
      if (r !== 11) throw new Error(`BUG: worker computed ${r}, expected 11`);
    }
  } finally {
    shutdown();
  }
});
