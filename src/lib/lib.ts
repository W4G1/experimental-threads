import ts from "typescript";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { extname, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import process from "node:process";
import { GLOBAL_MEMORY, Shared } from "./primitives.ts";
import { getCallSite, isStructuredClonable } from "./utils.ts";

export {
  Barrier,
  Channel,
  Condvar,
  Mutex,
  type MutexGuard,
  Once,
  OnceCell,
  RwLock,
  Semaphore,
  Shared,
  WaitGroup,
} from "./primitives.ts";

export const isMainThread = !("WorkerGlobalScope" in globalThis);
declare const marker: unique symbol;
export type WorkerScript<T> = string & { readonly [marker]: T };

const WORKER_IDLE_TIMEOUT_MS = 1000 * 30;
const WORKER_WARNING_THRESHOLD = navigator.hardwareConcurrency * 4;

declare global {
  // deno-lint-ignore no-shadow-restricted-names
  function eval<T>(script: WorkerScript<T>): T;
  function __worker_wrapper__(
    props: Record<string, unknown>,
    topLevelVars: string[],
    fnStr: string,
    url: string,
    baseCacheKey: string,
  ): JoinHandle<unknown>;
  function __par_wrapper__(
    token: number,
    props: Record<string, unknown>,
    topLevelVars: string[],
    fnStr: string,
    url: string,
    baseCacheKey: string,
  ): Promise<unknown[]>;
}

interface PoolEntry {
  worker: Worker;
  busy: boolean;
  // ReturnType keeps this portable: Deno says number, Node says Timeout.
  timer?: ReturnType<typeof setTimeout>;
  initialized: boolean;
  dead?: boolean;
}

const FILE_CACHE = new Map<string, ts.SourceFile>();
const SCOPE_ANALYSIS_CACHE = new Map<
  string,
  { locals: string[]; topLevels: string[] }
>();
const PATCHED_SOURCE_CACHE = new Map<string, string>();
const PATH_CACHE = new Map<string, string>();
const WORKER_POOL = new Map<string, PoolEntry[]>();
let TOTAL_ACTIVE_WORKERS = 0;

const PRIMITIVES_URL = new URL("./primitives.ts", import.meta.url).href;
const UTILS_URL = new URL("./utils.ts", import.meta.url).href;
const WORKER_SPLIT_MARKER = "/* __INJECTED_WORKER_BOOTSTRAP__ */";

const workerBody = (wrapper: string) =>
  `${WORKER_SPLIT_MARKER}
import { hydrate, hydrateGlobalMemory } from "${PRIMITIVES_URL}";
import { getTransferables } from "${UTILS_URL}";
const nativeClose = self.close?.bind(self);
self.close = () => {
  try { postMessage({ type: 'closed' }); } catch (_) { /* parent gone */ }
  nativeClose?.();
};
self.onmessage = async ({ data }) => {
  if (data.globalMemory) hydrateGlobalMemory(data.globalMemory);
  const hydratedProps = hydrate(data.props);
  const ctrl = new AbortController();
  const cancelFlag = data.cancelFlag ? new Int32Array(data.cancelFlag) : null;
  let settled = false;
  if (cancelFlag) {
    if (Atomics.load(cancelFlag, 0) !== 0) ctrl.abort();
    else {
      const res = Atomics.waitAsync(cancelFlag, 0, 0);
      if (res.async) {
        res.value.then(() => { if (!settled) ctrl.abort(); });
      } else ctrl.abort();
    }
  }
  try {
    let result: any = await (${wrapper})(hydratedProps as any)(ctrl.signal);
    if (
      result && typeof result === 'object' && typeof result.next === 'function' &&
      (Symbol.asyncIterator in result || Symbol.iterator in result)
    ) {
      // Generators stream: each yield is posted, the return value is the result.
      let step;
      while (!(step = await result.next()).done) {
        let t: Transferable[] = [];
        try { t = getTransferables(step.value); } catch (_) {}
        postMessage({ type: 'yield', value: step.value }, t);
      }
      result = step.value;
    }
    let transfer: Transferable[] = [];
    try { transfer = getTransferables(result); } catch (_) {}
    postMessage({ type: 'success', result }, transfer);
  } catch (error) {
    try {
      postMessage({ type: 'error', error });
    } catch {
      postMessage({ type: 'error', error: String(error) });
    }
  } finally {
    settled = true;
    // Wake the cancellation wait so it does not outlive the task; otherwise
    // every task run on a pooled worker would leave a pending wait behind.
    if (cancelFlag) Atomics.notify(cancelFlag, 0);
  }
};
globalThis.__worker_ready__ = true;
postMessage({ type: 'ready' });`;

export function spawn<T>(
  fn: (signal?: AbortSignal) => T,
): WorkerScript<JoinHandle<T>> {
  const site = getCallSite(import.meta.url);
  const baseCacheKey = `${site.url}:${site.line}:${site.col}`;

  if (!SCOPE_ANALYSIS_CACHE.has(baseCacheKey)) analyzeScope(site, baseCacheKey);

  const { locals, topLevels } = SCOPE_ANALYSIS_CACHE.get(baseCacheKey)!;
  const allVars = [...locals, ...topLevels];

  return `globalThis.__worker_wrapper__({${allVars.join(",")}}, ${
    JSON.stringify(topLevels)
  }, ${
    JSON.stringify(fn.toString())
  }, "${site.url}", "${baseCacheKey}")` as WorkerScript<JoinHandle<T>>;
}

type Yielded<T> = T extends AsyncGenerator<infer Y, any, any> ? Y
  : T extends Generator<infer Y, any, any> ? Y
  : never;
type Joined<T> = T extends AsyncGenerator<any, infer R, any> ? Awaited<R>
  : T extends Generator<any, infer R, any> ? R
  : Awaited<T>;

interface JoinHandleHooks {
  cancel?: () => void;
  abort?: (reason?: unknown) => void;
  inline?: boolean;
}

/**
 * The thenable returned by `eval(spawn(fn))`. Awaiting it joins the thread.
 *
 * - `cancel()` fires the `AbortSignal` passed to the closure (cooperative).
 * - `abort()` hard-terminates the worker; the handle rejects.
 * - Generator closures stream: `for await (const v of handle)` consumes
 *   yields, and awaiting the handle gives the generator's return value.
 */
export class JoinHandle<T> implements PromiseLike<Joined<T>> {
  private readonly _yields: unknown[] = [];
  private _wake: (() => void)[] = [];
  private _settled = false;

  constructor(
    private readonly _promise: Promise<unknown>,
    private readonly _hooks: JoinHandleHooks = {},
  ) {}

  /** @internal */
  _push(value: unknown) {
    this._yields.push(value);
    this._notify();
  }

  /** @internal */
  _settle() {
    this._settled = true;
    this._notify();
  }

  private _notify() {
    const wake = this._wake;
    this._wake = [];
    for (const w of wake) w();
  }

  /** Cooperative cancellation: fires the closure's `AbortSignal`. */
  cancel() {
    this._hooks.cancel?.();
  }

  /** Hard-terminates the worker; the handle rejects. */
  abort(reason?: unknown) {
    this._hooks.abort?.(reason);
  }

  then<R1 = Joined<T>, R2 = never>(
    onfulfilled?: ((value: Joined<T>) => R1 | PromiseLike<R1>) | null,
    onrejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null,
  ): Promise<R1 | R2> {
    return this._promise.then(
      onfulfilled as ((value: unknown) => R1 | PromiseLike<R1>) | null,
      onrejected,
    );
  }

  catch<R = never>(
    onrejected?: ((reason: unknown) => R | PromiseLike<R>) | null,
  ): Promise<Joined<T> | R> {
    return this.then(null, onrejected) as Promise<Joined<T> | R>;
  }

  finally(onfinally?: (() => void) | null): Promise<Joined<T>> {
    return (this._promise as Promise<Joined<T>>).finally(onfinally);
  }

  async *[Symbol.asyncIterator](): AsyncIterator<Yielded<T>> {
    if (this._hooks.inline) {
      // spawn() at a worker's top level ran inline; delegate to its result.
      const result = (await this._promise) as any;
      if (result && typeof result.next === "function") yield* result;
      return;
    }
    while (true) {
      if (this._yields.length > 0) {
        yield this._yields.shift() as Yielded<T>;
        continue;
      }
      if (this._settled) {
        await this._promise; // surfaces the task's error, if any
        return;
      }
      await new Promise<void>((resolve) => this._wake.push(resolve));
    }
  }
}

const SCOPE_STACK: ThreadScope[] = [];

function trackInScope<T>(handle: JoinHandle<T>): JoinHandle<T> {
  SCOPE_STACK[SCOPE_STACK.length - 1]?._track(handle);
  return handle;
}

/**
 * Structured concurrency scope (Rust's `thread::scope`). Every thread
 * spawned while the scope is open is joined when it is disposed:
 *
 * ```ts
 * {
 *   await using _s = scope();
 *   eval(spawn(() => work()));
 * } // joins here; the first failure rethrows
 * ```
 */
export class ThreadScope {
  private readonly _handles: JoinHandle<any>[] = [];

  /** @internal */
  _track(handle: JoinHandle<any>) {
    this._handles.push(handle);
  }

  /** Waits for every tracked thread; rethrows the first failure. */
  async join(): Promise<void> {
    const idx = SCOPE_STACK.indexOf(this);
    if (idx > -1) SCOPE_STACK.splice(idx, 1);
    const results = await Promise.allSettled(this._handles);
    const failed = results.find((r) => r.status === "rejected");
    if (failed) throw (failed as PromiseRejectedResult).reason;
  }

  async [Symbol.asyncDispose]() {
    await this.join();
  }
}

export function scope(): ThreadScope {
  const s = new ThreadScope();
  SCOPE_STACK.push(s);
  return s;
}

const PAR_ARGS = new Map<number, readonly unknown[]>();
let PAR_TOKEN = 0;

/**
 * Rayon-style parallel map: chunks `items` across up to
 * `navigator.hardwareConcurrency` pooled workers and preserves order.
 * Like `spawn`, the result must be passed to `eval()` at the call site.
 */
export function par<T, R>(
  items: readonly T[],
  fn: (item: T, index: number, signal?: AbortSignal) => R,
): WorkerScript<Promise<Awaited<R>[]>> {
  const site = getCallSite(import.meta.url);
  const baseCacheKey = `${site.url}:${site.line}:${site.col}`;

  if (!SCOPE_ANALYSIS_CACHE.has(baseCacheKey)) analyzeScope(site, baseCacheKey);

  const { locals, topLevels } = SCOPE_ANALYSIS_CACHE.get(baseCacheKey)!;
  const allVars = [...locals, ...topLevels];
  PAR_ARGS.set(++PAR_TOKEN, items);

  return `globalThis.__par_wrapper__(${PAR_TOKEN}, {${allVars.join(",")}}, ${
    JSON.stringify(topLevels)
  }, ${
    JSON.stringify(fn.toString())
  }, "${site.url}", "${baseCacheKey}")` as WorkerScript<Promise<Awaited<R>[]>>;
}

globalThis.__par_wrapper__ = (
  token,
  props,
  topLevelVars,
  fnStr,
  url,
  baseCacheKey,
) => {
  const items = PAR_ARGS.get(token) ?? [];
  PAR_ARGS.delete(token);
  if (items.length === 0) return Promise.resolve([]);

  const workers = Math.min(navigator.hardwareConcurrency || 4, items.length);
  const chunkSize = Math.ceil(items.length / workers);
  // Each chunk runs the user fn sequentially; parallelism comes from chunks.
  const chunkFn =
    `async (__signal) => { const __f = (${fnStr}); const __out = []; ` +
    `for (let __i = 0; __i < __chunk.length; __i++) ` +
    `__out.push(await __f(__chunk[__i], __start + __i, __signal)); ` +
    `return __out; }`;

  const parts: PromiseLike<unknown>[] = [];
  for (let start = 0; start < items.length; start += chunkSize) {
    parts.push(globalThis.__worker_wrapper__(
      {
        ...props,
        __chunk: items.slice(start, start + chunkSize),
        __start: start,
      },
      topLevelVars,
      chunkFn,
      url,
      baseCacheKey,
    ));
  }
  return Promise.all(parts).then((r) => (r as unknown[][]).flat());
};

globalThis.__worker_wrapper__ = (
  props,
  topLevelCandidates,
  fnStr,
  url,
  baseCacheKey,
) => {
  if (!isMainThread && !(globalThis as any).__worker_ready__) {
    // A worker re-executes its source module's top level. Spawning there
    // would recurse into new workers forever, so run the closure inline:
    // later top-level code still sees a real result.
    console.warn("spawn() at module top level runs inline inside workers");
    const wrapper = new Function(
      `return (({${Object.keys(props).join(",")}}) => ${fnStr});`,
    )() as (p: Record<string, unknown>) => (signal?: AbortSignal) => unknown;
    const inline = Promise.resolve().then(() =>
      wrapper(props)(new AbortController().signal)
    );
    return trackInScope(new JoinHandle<unknown>(inline, { inline: true }));
  }

  for (const name of topLevelCandidates) {
    if (name in props) {
      const val = props[name];
      if (val instanceof Shared || !isStructuredClonable(val)) {
        delete props[name];
      }
    }
  }

  const finalVars = Object.keys(props).sort();
  const signatureKey = `${baseCacheKey}::${finalVars.join(",")}`;

  let pool = WORKER_POOL.get(signatureKey);
  if (!pool) WORKER_POOL.set(signatureKey, pool = []);

  let entry = pool.find((e) => !e.busy);

  if (!entry) {
    let filePath = PATH_CACHE.get(signatureKey);

    if (!filePath) {
      const noCheckHeader = "// @ts-nocheck: auto-generated worker file\n";
      const sourceTagPrefix = "globalThis.__worker_source__ = ";

      let patchedCode = PATCHED_SOURCE_CACHE.get(url);
      if (!patchedCode) {
        let rawCode = readFileSync(fileURLToPath(url), "utf-8");
        const splitIdx = rawCode.indexOf(WORKER_SPLIT_MARKER);
        if (splitIdx > -1) rawCode = rawCode.substring(0, splitIdx);
        // Strip generated header lines to avoid doubling them in nested workers
        if (rawCode.startsWith(noCheckHeader)) {
          rawCode = rawCode.substring(noCheckHeader.length);
        }
        if (rawCode.startsWith(sourceTagPrefix)) {
          rawCode = rawCode.substring(rawCode.indexOf("\n") + 1);
        }
        patchedCode = patchImports(rawCode, url);
        PATCHED_SOURCE_CACHE.set(url, patchedCode);
      }

      // Maps the copy's call sites back to the original module, so Shared
      // IDs derived inside the worker match the main thread's. The two
      // header lines are the offset; patchImports preserves all other
      // positions.
      const src = (globalThis as any).__worker_source__;
      const sourceUrl = src?.workerUrl === url ? src.url : url;
      const sourceTag = `${sourceTagPrefix}{ workerUrl: import.meta.url, url: ${
        JSON.stringify(sourceUrl)
      }, lineOffset: 2 };\n`;

      const wrapper = `(({${finalVars.join(",")}}) => ${fnStr})`;
      const hash = createHash("md5").update(signatureKey).digest("hex");
      const workerDir = resolve(process.cwd(), ".workers");

      if (!existsSync(workerDir)) mkdirSync(workerDir, { recursive: true });

      const fileExt = extname(fileURLToPath(url)) || ".js";
      filePath = join(workerDir, `${hash}${fileExt}`);
      writeFileSync(
        filePath,
        noCheckHeader + sourceTag + patchedCode + workerBody(wrapper),
      );
      PATH_CACHE.set(signatureKey, filePath);
    }

    if (++TOTAL_ACTIVE_WORKERS > WORKER_WARNING_THRESHOLD) {
      console.warn(`High worker count: ${TOTAL_ACTIVE_WORKERS}`);
    }

    const created: PoolEntry = {
      worker: new Worker(pathToFileURL(filePath).href, { type: "module" }),
      busy: true,
      initialized: false,
    };
    // Workers can die outside a task (uncaught errors, self.close()). These
    // listeners outlive individual tasks so a dead worker is always evicted
    // instead of being handed the next task.
    created.worker.addEventListener("error", (e) => {
      e.preventDefault();
      evict(pool!, created);
    });
    created.worker.addEventListener("message", (e) => {
      if ((e as MessageEvent).data?.type === "closed") evict(pool!, created);
    });
    pool.push(created);
    entry = created;
  } else {
    if (entry.timer) {
      clearTimeout(entry.timer);
      delete entry.timer;
    }
    entry.busy = true;
  }

  const cancelFlag = new Int32Array(new SharedArrayBuffer(4));
  // Assigned after the Promise executor below, which closes over it.
  // deno-lint-ignore prefer-const
  let handle: JoinHandle<unknown> | undefined;
  let pendingSettle = false;
  const settle = () => {
    if (handle) handle._settle();
    else pendingSettle = true;
  };
  let hardAbort: (reason?: unknown) => void = () => {};

  const promise = new Promise((res, rej) => {
    const resolve = (v: unknown) => {
      res(v);
      settle();
    };
    const reject = (e: unknown) => {
      rej(e);
      settle();
    };
    const w = entry.worker;
    let cleaned = false;

    const sendMessage = () => {
      const globalMemory = Object.fromEntries(GLOBAL_MEMORY.entries());
      try {
        // Captured props are cloned, never transferred: transferring would
        // detach buffers still owned by the calling thread.
        w.postMessage({ props, globalMemory, cancelFlag: cancelFlag.buffer });
      } catch (err) {
        cleanup();
        reject(err);
      }
    };

    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      w.removeEventListener("message", onMsg);
      w.removeEventListener("error", onError);
      if (entry.dead) return;
      entry.busy = false;
      entry.timer = setTimeout(
        () => evict(pool!, entry),
        WORKER_IDLE_TIMEOUT_MS,
      );
    };

    const onMsg = (e: MessageEvent) => {
      const { type, result, error, value } = e.data as {
        type: string;
        result: unknown;
        error: unknown;
        value: unknown;
      };
      if (type === "ready") {
        entry.initialized = true;
        sendMessage();
        return;
      }
      if (type === "yield") {
        handle?._push(value);
        return;
      }
      cleanup();
      if (type === "closed") {
        reject(new Error("Worker closed before completing the task"));
      } else if (type === "error") reject(error);
      else resolve(result);
    };

    const onError = (e: ErrorEvent) => {
      cleanup();
      reject(e.error ?? new Error(e.message));
    };

    hardAbort = (reason) => {
      if (cleaned) return;
      evict(pool!, entry);
      cleanup();
      reject(reason ?? new Error("Thread aborted"));
    };

    w.addEventListener("message", onMsg);
    w.addEventListener("error", onError);

    if (entry.initialized) sendMessage();
  });

  handle = new JoinHandle<unknown>(promise, {
    cancel: () => {
      Atomics.store(cancelFlag, 0, 1);
      Atomics.notify(cancelFlag, 0);
    },
    abort: (reason) => hardAbort(reason),
  });
  if (pendingSettle) handle._settle();
  return trackInScope(handle);
};

function evict(pool: PoolEntry[], entry: PoolEntry) {
  if (entry.dead) return;
  entry.dead = true;
  if (entry.timer) clearTimeout(entry.timer);
  const idx = pool.indexOf(entry);
  if (idx > -1) pool.splice(idx, 1);
  entry.worker.terminate();
  TOTAL_ACTIVE_WORKERS--;
}

function analyzeScope(
  site: { url: string; line: number; col: number },
  cacheKey: string,
) {
  const path = fileURLToPath(site.url);
  let file = FILE_CACHE.get(path);

  if (!file) {
    file = ts.createSourceFile("x.ts", readFileSync(path, "utf-8"), 99, true);
    FILE_CACHE.set(path, file);
  }

  const pos = file.getPositionOfLineAndCharacter(site.line - 1, site.col - 1);
  let fnNode: ts.FunctionLikeDeclaration | undefined;

  const findFn = (n: ts.Node) => {
    if (fnNode) return;
    if (n.pos <= pos && n.end >= pos && ts.isCallExpression(n)) {
      const callee = n.expression.getText();
      if (callee === "spawn") {
        fnNode = n.arguments[0] as ts.FunctionLikeDeclaration;
        return;
      }
      if (callee === "par") {
        fnNode = n.arguments[1] as ts.FunctionLikeDeclaration;
        return;
      }
    }
    ts.forEachChild(n, findFn);
  };
  findFn(file);

  const locals = new Set<string>();
  const topLevels = new Set<string>();

  if (fnNode) {
    const isExternal = (n: ts.Node) => {
      let p: ts.Node | undefined = n;
      while (p) {
        if (p === fnNode) return false;
        p = p.parent;
      }
      return true;
    };

    const visit = (n: ts.Node) => {
      if (ts.isIdentifier(n) && isValidUsage(n)) {
        let curr: ts.Node | undefined = n.parent;
        while (curr) {
          if (defines(curr, n.text)) {
            if (isExternal(curr)) {
              if (ts.isSourceFile(curr)) topLevels.add(n.text);
              else locals.add(n.text);
            }
            break;
          }
          curr = curr.parent;
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(fnNode);
  }

  SCOPE_ANALYSIS_CACHE.set(cacheKey, {
    locals: [...locals],
    topLevels: [...topLevels],
  });
}

function isValidUsage(n: ts.Node): boolean {
  const p = n.parent;
  if (
    (ts.isPropertyAccessExpression(p) || ts.isPropertyAssignment(p)) &&
    p.name === n
  ) return false;
  if (
    (ts.isVariableDeclaration(p) || ts.isParameter(p) ||
      ts.isBindingElement(p)) && p.name === n
  ) return false;
  if (ts.isImportSpecifier(p) && p.propertyName === n) return false;

  // Identifiers inside erased type positions don't exist at runtime.
  // `extends` heritage clauses are the exception: they are value references
  // even though TS classifies them as type nodes.
  for (let a: ts.Node | undefined = p; a; a = a.parent) {
    if (ts.isExpressionWithTypeArguments(a)) {
      return ts.isHeritageClause(a.parent) &&
        a.parent.token === ts.SyntaxKind.ExtendsKeyword;
    }
    if (ts.isTypeNode(a)) return false;
  }
  return true;
}

function defines(n: ts.Node, name: string): boolean {
  if (ts.isFunctionLike(n)) {
    return n.parameters.some((p) => bindingHasName(p.name, name));
  }

  if (
    ts.isBlock(n) || ts.isSourceFile(n) || ts.isCaseClause(n) ||
    ts.isDefaultClause(n)
  ) {
    return n.statements.some((s) => {
      if (ts.isVariableStatement(s)) {
        return s.declarationList.declarations.some((d) =>
          bindingHasName(d.name, name)
        );
      }
      if (
        (ts.isFunctionDeclaration(s) || ts.isClassDeclaration(s)) &&
        s.name?.text === name
      ) return true;
      if (ts.isImportDeclaration(s) && s.importClause) {
        const { name: importedName, namedBindings } = s.importClause;
        if (importedName?.text === name) return true;
        if (namedBindings) {
          if (ts.isNamedImports(namedBindings)) {
            return namedBindings.elements.some((e) => e.name.text === name);
          }
          if (ts.isNamespaceImport(namedBindings)) {
            return namedBindings.name.text === name;
          }
        }
      }
      return false;
    });
  }

  if (
    (ts.isForStatement(n) || ts.isForOfStatement(n) ||
      ts.isForInStatement(n)) &&
    n.initializer && ts.isVariableDeclarationList(n.initializer)
  ) {
    return n.initializer.declarations.some((d) => bindingHasName(d.name, name));
  }

  if (ts.isCatchClause(n) && n.variableDeclaration) {
    return bindingHasName(n.variableDeclaration.name, name);
  }

  return false;
}

function bindingHasName(node: ts.BindingName, name: string): boolean {
  if (ts.isIdentifier(node)) return node.text === name;
  if (ts.isObjectBindingPattern(node)) {
    return node.elements.some((el) => bindingHasName(el.name, name));
  }
  if (ts.isArrayBindingPattern(node)) {
    return node.elements.some((el) =>
      ts.isBindingElement(el) && bindingHasName(el.name, name)
    );
  }
  return false;
}

// Rewrites relative import/export specifiers to absolute URLs by replacing
// the literal spans in the original text. Unlike re-printing the AST, this
// preserves every line and column, which Shared call-site IDs depend on.
function patchImports(code: string, base: string) {
  const file = ts.createSourceFile("x.ts", code, ts.ScriptTarget.ESNext, true);
  const edits: { start: number; end: number; text: string }[] = [];

  const visit = (n: ts.Node) => {
    if (ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) {
      const spec = n.moduleSpecifier;
      if (spec && ts.isStringLiteral(spec) && /^\.\.?\//.test(spec.text)) {
        edits.push({
          start: spec.getStart(file) + 1,
          end: spec.end - 1,
          text: new URL(spec.text, base).href,
        });
      }
    } else {
      ts.forEachChild(n, visit);
    }
  };
  visit(file);

  for (const e of edits.reverse()) {
    code = code.slice(0, e.start) + e.text + code.slice(e.end);
  }
  return code;
}

export function shutdown() {
  for (const pool of WORKER_POOL.values()) {
    for (const entry of [...pool]) evict(pool, entry);
  }
  WORKER_POOL.clear();
  TOTAL_ACTIVE_WORKERS = 0;
}
