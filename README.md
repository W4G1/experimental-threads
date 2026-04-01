<div align="center">

# experimental-threads

[![Status](https://img.shields.io/badge/status-experimental-orange.svg)]()
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/Language-TypeScript-blue.svg)]()
[![Node.js](https://img.shields.io/badge/Node.js-6DA55F?logo=node.js&logoColor=white)]()
[![Deno](https://img.shields.io/badge/Deno-000?logo=deno&logoColor=fff)]()
[![Bun](https://img.shields.io/badge/Bun-000?logo=bun&logoColor=fff)]()

</div>

`experimental-threads` is a concurrency library for server-side JavaScript and TypeScript (Node.js, Deno, Bun). It runs **inline closures in Web Workers** — no separate entry files, no manual message passing. Variables from the enclosing scope are captured automatically via static AST analysis and transferred into the worker context.

The API is structurally similar to thread spawning in systems languages like Rust or Go.

## Installation

```bash
npm install experimental-threads
```

## Usage

### Spawning a thread

`spawn` captures the closure's free variables and returns a script string. Wrapping it in `eval()` bridges the local scope at the call site, serializes the captured variables, and runs the closure in a worker.

```typescript
import { spawn } from "experimental-threads";
import * as bcrypt from "bcrypt";

const userRequest = { username: "admin", password: "correct_horse_battery_staple" };
const saltRounds = 12;

// 'userRequest' and 'saltRounds' are captured from the enclosing scope,
// cloned, and transferred to the worker automatically.
const hash = await eval(spawn(async () => {
  return await bcrypt.hash(userRequest.password, saltRounds);
}));

console.log(hash); // "$2b$12$..."
```

> **Note:** The `eval()` wrapper is required — it is what bridges the call site's lexical scope into the generated script string. See [Architecture](#architecture) for details.

### Shared memory and mutexes

Web Workers run in separate V8 isolates, so module-level objects (including locks) are independent in each worker. `Global<T>` fixes this by pinning a `SharedArrayBuffer`-backed resource to its source location, ensuring all isolates share the same underlying memory.

```typescript
import { Global, Mutex, spawn } from "experimental-threads";

// This Mutex wraps a SharedArrayBuffer. Because it is Global<T>, every
// worker that imports this module gets the same underlying memory buffer.
const sharedLock = new Global(new Mutex(new SharedArrayBuffer(4)));

// Main thread: acquire the lock and write an initial value
{
  using guard = await sharedLock.value.lock();
  new Int32Array(guard.value)[0] = 1;
}

await eval(spawn(async () => {
  using guard = await sharedLock.value.lock();
  const view = new Int32Array(guard.value);

  console.log(view[0]); // 1
  view[0] = 2;

  // Workers can spawn nested sub-threads
  await eval(spawn(async () => {
    using guard = await sharedLock.value.lock();
    new Int32Array(guard.value)[0] = 3;
  }));
}));

{
  using guard = await sharedLock.value.lock();
  console.log(new Int32Array(guard.value)[0]); // 3
}
```

`MutexGuard` implements `Symbol.dispose`, so the `using` keyword releases the lock automatically at scope exit. You can also call `guard.unlock()` explicitly.

### Semaphore

`Semaphore` controls access to a resource with a fixed number of permits.

```typescript
import { Semaphore } from "experimental-threads";

const sem = new Semaphore(3); // 3 concurrent permits

{
  using _permit = await sem.acquire();
  // up to 3 holders at a time
}
// permit released automatically

sem.release(1); // or release manually
```

## API

### `spawn<T>(fn: () => T): WorkerScript<T>`

Statically analyzes the closure, identifies its free variables, and returns a script string encoding the worker bootstrap. Must be called with `eval()` to capture runtime values.

### `shutdown(): void`

Terminates all pooled workers and clears internal caches. Required for clean process exit (e.g., at the end of tests).

### `Global<T extends SharedStruct | SharedArrayBuffer>`

Wraps a `SharedArrayBuffer`-backed value and gives it a stable identity across isolates derived from its source location (file + line + column). Instantiating `Global<T>` at the same call site in any worker will point to the same underlying memory as the main thread.

### `Mutex<T>`

An async mutual exclusion lock backed by `Atomics.waitAsync`.

- `await mutex.lock(): Promise<MutexGuard<T>>` — acquires the lock
- `guard.unlock()` / `guard[Symbol.dispose]()` — releases it
- Supports `using guard = await mutex.lock()` for automatic release

### `Semaphore`

An async counting semaphore backed by `Atomics.waitAsync`.

- `await semaphore.acquire(amount?: number)` — decrements permits, blocks if insufficient; returns a disposable guard
- `semaphore.release(amount?: number)` — restores permits and wakes waiters

## Architecture

### Lexical scope capture

JavaScript has no built-in way to inspect the variables captured by a closure. `experimental-threads` extracts them at the call site:

1. **Call site resolution** — `spawn()` reads the V8 stack trace to find its own call site (file, line, column).
2. **AST analysis** — the source file is parsed with the TypeScript Compiler API. The AST is traversed to locate the `spawn()` call and identify its closure's *free variables* — identifiers referenced inside the function but defined outside it.
3. **Code generation** — a standalone worker entry script is produced from the caller's source, with relative import paths rewritten to absolute `file://` URLs so they resolve from the `.workers/` directory.
4. **Scope bridging** — `spawn()` returns a code snippet of the form `__worker_wrapper__({a, b, c}, ...)`. Evaluating this with `eval()` in the caller's scope captures the runtime values of the free variables. Those values are structured-cloned (with `Transferable` objects zero-copy transferred) and sent to the worker.

### Shared memory hydration

Because each V8 isolate runs module code independently, a `new Mutex()` in a worker creates a fresh, unrelated lock. `Global<T>` solves this with location-based identity:

- On the **main thread**, `new Global(value)` registers the underlying `SharedArrayBuffer` under a key derived from the call site.
- On a **worker**, the same constructor intercepts the allocation. During bootstrap, the main thread sends its full memory registry to the worker. The `Global<T>` constructor looks up its key and hydrates from the parent's buffer rather than allocating a new one.

This guarantees that `sharedLock.value` in a worker is backed by the same `SharedArrayBuffer` as in the main thread.

### Worker pooling

Workers are pooled by a signature derived from the call site and the set of captured variable names. An idle worker is reused for subsequent identical calls. Workers that remain idle for 30 seconds are terminated. A warning is logged if the total active worker count exceeds 4× hardware concurrency.

## Limitations

- **`eval` is required.** The scope-bridging mechanism depends on evaluating the generated script in the caller's lexical scope. This restricts usage to trusted, server-side code. Never pass user-provided input through `spawn` or `eval`.

## License

MIT — see [LICENSE](LICENSE).
