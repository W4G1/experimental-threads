# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Development
deno task dev          # Run with file watch mode

# Testing
deno task test         # Run all tests (requires --expose-gc internally)
deno test -A --v8-flags="--expose-gc" test/<dir>/test.ts          # Run a specific test file
deno test -A --v8-flags="--expose-gc" test/<dir>/test.ts -f "name" # Run a single test by name

# Build
deno task build        # Compile src/ → dist/ and generate package.json

# Linting & formatting
deno lint
deno fmt               # Auto-format
deno fmt --check       # Check without modifying
```

## Architecture

`experimental-threads` is a concurrency library for Node.js, Deno, and Bun that lets you run **inline closures** in Web Workers without separate entry files. It uses static AST analysis to capture lexical scope and serialize it into a self-contained worker script.

### Core flow

1. **`spawn(fn)`** (`src/lib/lib.ts`) — the main API. It:
   - Resolves the call site via stack trace parsing (`getCallSite()` in `src/lib/utils.ts`)
   - Reads the caller's source file and parses it with the TypeScript compiler API
   - Walks the AST to find free variables in `fn` (`analyzeScope()`)
   - Rewrites relative imports for the worker context (`patchImports()`)
   - Returns a `WorkerScript<T>` string (a branded string type) that encodes the worker bootstrap code

2. **Worker pool** — workers are pooled by a signature derived from the captured variable set. Idle workers are terminated after 30 seconds. A warning fires if active workers exceed 4× hardware concurrency.

3. **Shared memory / `Global<T>`** (`src/lib/primitives.ts`) — wraps a `SharedArrayBuffer` identified by a location-based ID (`file:line:col`). The main thread registers buffers in a `GLOBAL_MEMORY` map; workers receive a hydration map so they reconstruct the same buffer references across V8 isolates.

4. **Synchronization primitives** (`src/lib/primitives.ts`) — `Mutex<T>` and `Semaphore` are built on `Atomics.wait`/`Atomics.notify`. `MutexGuard<T>` implements `Symbol.dispose` for RAII-style unlocking (`using guard = await mutex.lock()`).

### Platform layers

- **`src/deno/`** — entry point for Deno; polyfills `Atomics.waitAsync` to keep the event loop alive
- **`src/node/`** — entry point for Node.js/Bun; wraps `node:worker_threads` in a Web Worker–compatible API and polyfills `WorkerGlobalScope`
- Both re-export everything from `src/lib/lib.ts` after loading their polyfill

### Build

`scripts/build.ts` uses the TypeScript compiler API with a custom transformer that rewrites `.ts` import extensions to `.js`. It compiles `src/**/*.ts` to `dist/` targeting ES2020/ESNext modules and generates a `package.json` with platform-specific exports for Node, Deno, and Bun.

### Tests

Tests live in `test/` as subdirectories, each with a `test.ts` using `Deno.test()`. They always call `shutdown()` in a `finally` block to drain the worker pool. The `--expose-gc` V8 flag is required to allow explicit GC triggering in tests.

### TypeScript strictness

The project uses `strict: true` plus `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `noImplicitReturns`, and `noImplicitOverride`. Lint rules `no-explicit-any` and `no-unused-vars` are disabled.
