// @ts-nocheck: polyfill file for deno

// Deno drains the V8 message loop only at the start of each event loop iteration,
// rather than continuously. This means Atomics.waitAsync notifications may not
// fire until the loop is woken up by another event. The patch below keeps the
// loop churning for the duration of each wait, ensuring atomic wakeups are
// processed promptly.
//
// The churn is tiered so long-lived waits stay cheap: for the first 100ms of a
// wait it spins on setImmediate (sub-millisecond wakeups for hot paths such as
// contended mutex handoffs), after which it drops to a 10ms timer (negligible
// CPU, at most ~10ms notification latency).

import { clearImmediate, setImmediate } from "node:timers";

const originalWaitAsync = Atomics.waitAsync;
const FAST_WINDOW_MS = 100;
const SLOW_TICK_MS = 10;

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
    let immediate: ReturnType<typeof setImmediate> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // performance.now() is monotonic: a system clock adjustment mid-wait
    // cannot stretch or collapse the fast window like Date.now() could.
    const start = performance.now();
    const keepAlive = () => {
      if (!active) return;
      if (performance.now() - start < FAST_WINDOW_MS) {
        immediate = setImmediate(keepAlive);
      } else {
        timer = setTimeout(keepAlive, SLOW_TICK_MS);
      }
    };
    keepAlive();
    try {
      return await result.value;
    } finally {
      active = false;
      if (immediate !== undefined) clearImmediate(immediate);
      if (timer !== undefined) clearTimeout(timer);
    }
  })();

  return { async: true, value: wrappedPromise };
};
