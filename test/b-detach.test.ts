import { shutdown, spawn } from "experimental-threads";

Deno.test("capturing a local typed array does not destroy it on the main thread", async () => {
  try {
    const data = new Uint8Array([1, 2, 3, 4]);

    const first = await eval(spawn(() => data[0]));
    if (first !== 1) throw new Error(`worker read wrong value: ${first}`);

    if (data.byteLength === 0) {
      throw new Error(
        `BUG CONFIRMED: captured Uint8Array was transferred (detached) — main-thread copy destroyed`,
      );
    }
  } finally {
    shutdown();
  }
});
