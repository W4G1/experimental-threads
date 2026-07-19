import { assertEquals } from "@std/assert";
import { par, shutdown } from "experimental-threads";

Deno.test("par maps items across workers preserving order", async () => {
  try {
    const factor = 3;
    const items = Array.from({ length: 100 }, (_, i) => i);

    const out = await eval(
      par(items, (x: number, i: number) => x * factor + i),
    );

    assertEquals(out, items.map((x, i) => x * factor + i));
  } finally {
    shutdown();
  }
});

Deno.test("par handles an empty input", async () => {
  try {
    const out = await eval(par([] as number[], (x: number) => x * 2));
    assertEquals(out, []);
  } finally {
    shutdown();
  }
});
