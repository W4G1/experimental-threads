<div align="center">

  <h1>experimental-threads</h1>

  <p>
    <strong>JIT-compiled multithreading using lexical scope analysis and shared memory rehydration.</strong>
  </p>

  [![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
  [![Status](https://img.shields.io/badge/status-experimental-orange.svg)]()
  [![TypeScript](https://img.shields.io/badge/language-TypeScript-3178C6.svg)]()

</div>

<br />

**experimental-threads** is a highly experimental concurrency library for server-side JavaScript that bridges the gap between the single-threaded Event Loop and true parallelism. It introduces a novel runtime architecture that combines **Abstract Syntax Tree (AST) analysis**, **source-code injection**, and **deterministic memory hydration** to emulate the ergonomics of Go routines or Rust threads.

Unlike traditional Web Workers which require separate entry files and manual message passing, this library allows for the execution of **lexical closures** in isolated threads. It automatically handles the serialization of captured variables and ensures referential integrity of shared memory resources (`SharedArrayBuffer`) across execution contexts.

## Installation

```bash
npm install experimental-threads
```

## Usage

```typescript
import { spawn } from "experimental-threads";
import { v4: uuiv4 } from "uuid";

const data = { hello: 'world' };

// We must use eval() to capture the local scope of 'data'
const result = await eval(spawn(() => {
  // 'data' is available inside the Worker
  console.log(data.hello); // "world"

  // Magic. No dynamic import necessary inside the closure
  return uuiv4();
}));

console.log(result); // 'cca68b4c-7416-4b44-ba94-9cf6ca90bf59'
```

## Why must `spawn()` be wrapped in `eval()`?

The usage of `eval()` is a deliberate architectural choice to enable **Runtime Scope Bridging**.

Standard JavaScript functions cannot reflectively access the local variables of their caller. While our AST analysis allows the library to identify *identifiers* (variable names) within your closure, it cannot access their *values*.

1. `spawn()` analyzes the source and finds that you used the variable `data`.
2. `spawn()` returns a generated code string that acts as a bridge.
3. `eval()` executes this string in the **current local scope**, allowing the library to resolve the runtime value of `data` and transfer it to the thread.

This eliminates the need for manual dependency injection, and preserves the ergonomics of standard JavaScript closures.

## Architecture

### Runtime Scope Analysis & AST Traversal

Standard JavaScript closures cannot be serialized to Workers because they are bound to the parent execution context. **experimental-threads** bypasses this limitation by performing **Just-In-Time (JIT) Static Analysis** on the calling code.

When `spawn(fn)` is invoked:

1. **Call Site Resolution:** The library inspects the V8 stack trace to identify the exact file, line, and column of the invocation.
2. **AST Generation:** It reads the source file from the disk and feeds it into the **TypeScript Compiler API** to generate a synthetic AST.
3. **Symbol Resolution:** It traverses the AST to locate the specific arrow function expression passed to `spawn`.
4. **Identifier Resolution:** It walks the scope chain of the function body, distinguishing between *bound identifiers* (parameters, local variables) and *free variables* (captured from the outer scope).
5. **Transpilation:** It generates a standalone worker entry script that imports necessary modules and injects the captured free variables as structured-cloned properties.

### Deterministic Memory Hydration (`Global<T>`)

In a multi-process or multi-isolate architecture (like Web Workers), module singletons are not shared. They are instantiated once per thread. This breaks the identity of shared locks or buffers.

This library introduces **Location-Dependent Reference Integrity**.

* **Identity Generation:** Every `Global` instance is assigned a deterministic ID based on its definition site.
* **Memory Registry:** The main thread maintains a global memory registry, mapping these IDs to their underlying `SharedArrayBuffer` pointers.
* **Hydration:** When a Worker boots and imports a module containing a `Global`, the constructor intercepts the instantiation. Instead of allocating new memory, it queries the registry transmitted during the handshake phase and **hydrates** the instance with the existing buffer from the main/parent thread.

This guarantees that `const lock = new Global(new Mutex())` refers to the exact same memory address in every thread, enabling atomic synchronization.

## Synchronization Primitives

### `Mutex`

A mutual exclusion primitive preventing race conditions. Uses a futex-like mechanism with `Atomics.wait` and `Atomics.notify`. Supports the `using` keyword (Explicit Resource Management) for RAII-style scope-based unlocking.

### `Semaphore`

A signaling mechanism to control access to a common resource by multiple processes. Supports the `using` keyword (Explicit Resource Management).

---

## License

MIT
