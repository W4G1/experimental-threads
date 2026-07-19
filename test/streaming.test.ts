import { assertEquals } from "@std/assert";
import { shutdown, spawn } from "experimental-threads";

Deno.test("generator closures stream yields and return a final value", async () => {
  try {
    const n = 4;
    const handle = eval(spawn(async function* () {
      for (let i = 0; i < n; i++) yield i * 2;
      return "done";
    }));

    const seen: number[] = [];
    for await (const v of handle) seen.push(v);

    assertEquals(seen, [0, 2, 4, 6]);
    assertEquals(await handle, "done");
  } finally {
    shutdown();
  }
});
