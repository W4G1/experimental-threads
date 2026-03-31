// @ts-nocheck: polyfill file for deno

// Applies a monkey patch for Atomics.waitAsync specifically for the Deno environment.
// In Deno, the V8 message loop is drained at the start of event loop iterations,
// meaning standard V8 wakeups might not trigger immediate processing of waitAsync.
// This monkey patch injects a setInterval "tick" to ensure the event loop stays active
// and wakes up to process the atomic notification.
//
// waitAsync, along with GC, WeakRef/FinalizationRegistry callbacks and WebAssembly async compilation, are things
// that happen when the V8 message loop is drained. V8 usually expects the message loop to be more or less continuously
// drained, so that the message loop is the event loop, but Deno instead drains the message loop at the beginning of every
// event loop iteration. As such, V8 doesn't have any way to wake up Deno's event loop, and the waitAsync timeout will
// only fire when the event loop is woken up in some other way.
//
// When a Deno worker imports a module with top-level await (e.g. a DB connection),
// Deno's event loop does not tick during that await, so timers like setTimeout
// never fire and the module hangs indefinitely, causing self.onmessage to never be reached.

const keepAlive = () => {
  // A 1ms delay allows the CPU to actually enter a low-power state
  // for a fraction of a second, significantly dropping CPU usage
  // compared to setImmediate.
  const timer = setTimeout(keepAlive, 1);

  // Allow deno to exit without waiting for this timer
  Deno.unrefTimer(timer);
};

// Kick off the loop
keepAlive();
