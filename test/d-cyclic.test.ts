import { shutdown, spawn } from "experimental-threads";

Deno.test("cyclic captured object survives hydration", async () => {
  try {
    const obj: any = { a: 1 };
    obj.self = obj; // structuredClone supports cycles

    const r = await eval(spawn(() => obj.a));
    if (r !== 1) throw new Error(`BUG: got ${r}`);
  } finally {
    shutdown();
  }
});
