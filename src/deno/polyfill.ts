// @ts-nocheck: polyfill file for deno

// Deno drains the V8 message loop only at the start of each event loop iteration,
// rather than continuously. This means Atomics.waitAsync notifications may not
// fire until the loop is woken up by another event. The patch below keeps the
// loop churning via recursive setImmediate calls for the duration of each wait,
// ensuring atomic wakeups are processed promptly.

import { setImmediate } from "node:timers";

const originalWaitAsync = Atomics.waitAsync;

// @ts-ignore: overwriting native function signature
Atomics.waitAsync = function (
  typedArray: Int32Array | BigInt64Array,
  index: number,
  value: number | bigint,
  timeout?: number,
) {
  // @ts-ignore: simplified signature
  const result = originalWaitAsync(typedArray, index, value, timeout);

  if (!result.async) return result;

  const wrappedPromise = (async () => {
    let active = true;
    const keepAlive = () => { if (active) setImmediate(keepAlive); };
    keepAlive();
    try {
      return await result.value;
    } finally {
      active = false;
    }
  })();

  return { async: true, value: wrappedPromise };
};
