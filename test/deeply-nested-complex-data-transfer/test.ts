import { assertEquals } from "@std/assert";
import { shutdown, spawn } from "experimental-threads";

// Top-level SharedArrayBuffer to test true memory sharing
export const rawSab = new SharedArrayBuffer(4);

Deno.test("Deeply Nested Complex Data Transfer", async () => {
  const complexPayload = {
    primitiveNum: 123.45,
    primitiveStr: "Hello Worker",
    primitiveBool: true,
    primitiveNull: null as null | string,
    map: new Map<string, number>([["keyA", 10], ["keyB", 20]]),
    set: new Set<string>(["alpha", "beta", "gamma"]),
    arr: [1, 2, 3, { nestedInArray: true }],
    obj: {
      foo: "bar",
      deep: {
        date: new Date("2024-01-01T00:00:00.000Z"),
      },
    },
    uint8: new Uint8Array([10, 20, 30, 40]),
    buffer: new ArrayBuffer(8), // Should be transferred
  };

  try {
    // Setup Initial State in Main
    const sabView = new Int32Array(rawSab);
    sabView[0] = 100; // Initial value

    // Spawn W1
    const result = await eval(spawn(async () => {
      const view1 = new Int32Array(rawSab);

      // Verify shared memory (read)
      if (view1[0] !== 100) {
        throw new Error(`W1: SAB mismatch. Got ${view1[0]}`);
      }

      // Verify transfer
      if (complexPayload.primitiveNum !== 123.45) {
        throw new Error("W1: Num fail");
      }
      if (complexPayload.map.get("keyA") !== 10) {
        throw new Error("W1: Map fail");
      }
      if (!complexPayload.set.has("beta")) throw new Error("W1: Set fail");
      if (
        complexPayload.obj.deep.date.toISOString() !==
          "2024-01-01T00:00:00.000Z"
      ) {
        throw new Error("W1: Date fail");
      }
      if (complexPayload.uint8[2] !== 30) throw new Error("W1: Uint8 fail");

      // Mutate shared memory
      view1[0] = 200;

      // Spawn W2 (nested)
      return await eval(spawn(async () => {
        // W2 captures 'complexPayload' from W1's scope,
        // effectively testing a clone-of-a-clone.

        const view2 = new Int32Array(rawSab);

        // Verify shared memory (Read saw mutation from W1)
        if (view2[0] !== 200) {
          throw new Error(`W2: SAB mismatch. Got ${view2[0]}`);
        }

        // Verify payload integrity (deeply nested)
        if (complexPayload.map.get("keyB") !== 20) {
          throw new Error("W2: Map fail");
        }
        if (complexPayload.arr.length !== 4) {
          throw new Error("W2: Array length fail");
        }
        // @ts-ignore
        if (complexPayload.arr[3].nestedInArray !== true) {
          throw new Error("W2: Deep obj fail");
        }

        // Mutate shared memory
        view2[0] = 300;

        return "Success from W2";
      }));
    }));

    assertEquals(result, "Success from W2");

    // The SAB should reflect the write from W2
    assertEquals(new Int32Array(rawSab)[0], 300);
  } finally {
    shutdown();
  }
});
