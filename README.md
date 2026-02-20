<div align="center">

# experimental-threads

[![Status](https://img.shields.io/badge/status-experimental-orange.svg)]()
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/Language-TypeScript-blue.svg)]()
[![Node.js](https://img.shields.io/badge/Node.js-6DA55F?logo=node.js&logoColor=white)](#)
[![Deno](https://img.shields.io/badge/Deno-000?logo=deno&logoColor=fff)](#)
[![Bun](https://img.shields.io/badge/Bun-000?logo=bun&logoColor=fff)](#)
[![GitHub Repo stars](https://img.shields.io/github/stars/W4G1/experimental-threads?logo=github&label=Star&labelColor=rgb(26%2C%2030%2C%2035)&color=rgb(13%2C%2017%2C%2023))](https://github.com/W4G1/experimental-threads)

</div>

<br/>

`experimental-threads` is a highly experimental concurrency library for JavaScript and TypeScript (Node.js, Deno, Bun). It enables the execution of inline closures within isolated Web Workers by combining static AST analysis, lexical scope capture, and shared memory hydration.

By abstracting away standard Web Worker message passing and the need for separate entry files, this library provides an API structurally similar to thread spawning in systems languages like Rust or Go.

## Features

* **Lexical Scope Capture:** Automatically identifies, serializes, and transfers variables captured by an inline closure to the worker context.
* **Zero-Copy Transfers:** Automatically transfers ownership of `Transferable` types (e.g., `ArrayBuffer`, `MessagePort`) rather than copying them.
* **Isolate State Synchronization:** The `Global<T>` primitive ensures `SharedArrayBuffer` references maintain referential equality across separate V8 isolates.
* **Thread-Safe Synchronization Primitives:** Includes `Mutex` and `Semaphore` implementations backed by `Atomics.wait` and `Atomics.notify`. Supports Explicit Resource Management (`using` declarations) for RAII-style lock acquisition and release.
* **Worker Pooling:** Automatically manages active worker lifecycles, pooling, and idle timeouts.

## Installation

```bash
npm install experimental-threads
```

## Usage

### Spawning Threads

The `spawn` function takes a closure and executes it in a separate thread. Variables from the surrounding lexical scope are automatically captured and passed to the worker.

*Note: The `eval` wrapper is strictly required to capture the local environment. See the Architecture section below for details.*

```typescript
import { spawn } from "experimental-threads";
import * as bcrypt from "bcrypt";

const userRequest = { username: "admin", password: "correct_horse_battery_staple" };
const saltRounds = 12;

const result = await eval(spawn(async () => {
  // 'userRequest' and 'saltRounds' are captured from the parent scope and cloned into the worker
  console.log(userRequest);

  const hash = await bcrypt.hash(userRequest.password, saltRounds);

  return hash;
}));

console.log(result); // "$2b$12$..."
```

### Shared Memory and Mutexes

Because Web Workers operate in isolated contexts, module-level variables are instantiated once per worker. The `Global<T>` wrapper resolves this by synchronizing `SharedArrayBuffer` memory across boundaries.

```typescript
import { Global, Mutex, spawn } from "experimental-threads";

// Define a globally synchronized Mutex wrapping a SharedArrayBuffer
const sharedLock = new Global(new Mutex(new SharedArrayBuffer(4)));

{
  using guard = await sharedLock.value.lock();
  const data = new Int32Array(guard.value);
  data[0] = 1;
}

// Spawn a worker
await eval(spawn(async () => {
  // Block (wait) until the lock is available
  using guard = await sharedLock.value.lock();
  const data = new Int32Array(guard.value);

  data[0] = 2;

  // Unlock manually because we don't exit this thread yet
  guard.unlock();

  // Threads can spawn nested sub-threads as well
  await eval(spawn(async () => {
    using guard = await sharedLock.value.lock();
    const data = new Int32Array(guard.value);

    data[0] = 3;
  }));
}));

{
  using guard = await sharedLock.value.lock();
  const data = new Int32Array(guard.value);
  console.log(data[0]); // Outputs: 3
}
```

## Architecture

### Lexical Scope Resolution

JavaScript does not provide a built-in way to reflectively inspect the variables captured by a closure. To serialize a closure and send it to a Web Worker, `experimental-threads` must extract both the variable names and their runtime values using a multi-step process:

1. **Static Analysis:** `spawn(fn)` resolves its own call site via the V8 stack trace. It reads the source file from disk and parses it into an Abstract Syntax Tree (AST) using the TypeScript Compiler API.
2. **Identifier Resolution:** The AST is traversed to locate the closure and identify its *free variables* (variables referenced inside the function but defined outside of it).
3. **Code Generation:** The library generates a standalone worker entry script, rewriting relative import paths to ensure they resolve correctly from the generated `.workers` directory.
4. **Scope Bridging:** `spawn()` returns a generated code snippet. Evaluating this snippet with `eval()` in the caller's scope captures the runtime values of the free variables, allowing the library to serialize them and initialize the worker.

### Shared Memory Hydration

Because Web Workers run in separate V8 isolates, a module-level `const lock = new Mutex()` creates a completely new, independent lock in every worker. 

The `Global<T>` wrapper solves this by guaranteeing that a shared resource points to the exact same memory address across all isolates:
* When a `Global<T>` is instantiated, it generates a deterministic ID based on its exact call site (file path, line number, and column).
* The main thread maps this ID to the underlying `SharedArrayBuffer`.
* When a worker initializes and executes the same module code, the `Global<T>` constructor intercepts the allocation. It queries a memory map transmitted during the worker's bootstrap phase and hydrates its internal state with the parent thread's memory buffer.

## API Reference

### Core

* **`spawn<T>(fn: () => T): WorkerScript<T>`**
  Analyzes the provided closure and returns a script string. Must be executed via `eval()`.
* **`shutdown(): void`**
  Terminates all active workers and clears memory caches. Required for graceful process termination.

### Synchronization

* **`Global<T>`**
  A wrapper for `SharedArrayBuffer` or `SharedStruct` types. Ensures the underlying memory block maintains referential equality across isolated worker contexts.
* **`Mutex<T>`**
  An asynchronous mutual exclusion lock. 
  * `await mutex.lock()` returns a `MutexGuard<T>`.
  * Implements `[Symbol.dispose]` for RAII-style unlocking.
* **`Semaphore`**
  An asynchronous signaling primitive for controlling access to a shared resource.
  * `await semaphore.acquire(amount)`
  * `semaphore.release(amount)`

## Limitations

* **`eval` Requirement:** The API mandates the use of `eval()` to bridge the lexical scope. This restricts the library's use to backend environments where the source code is known and trusted. It must never be used to evaluate user-provided input.

## License

MIT License. See [LICENSE](LICENSE) for details.