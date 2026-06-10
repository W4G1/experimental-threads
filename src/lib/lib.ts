import ts from "typescript";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { extname, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import process from "node:process";
import { Global, GLOBAL_MEMORY } from "./primitives.ts";
import { getCallSite, isStructuredClonable } from "./utils.ts";

export { Global, Mutex, type MutexGuard, Semaphore } from "./primitives.ts";

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
  ): Promise<unknown>;
}

interface PoolEntry {
  worker: Worker;
  busy: boolean;
  timer?: number;
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
  try {
    const result = await (${wrapper})(hydratedProps as any)();
    let transfer: Transferable[] = [];
    try { transfer = getTransferables(result); } catch (_) {}
    postMessage({ type: 'success', result }, transfer);
  } catch (error) {
    try {
      postMessage({ type: 'error', error });
    } catch {
      postMessage({ type: 'error', error: String(error) });
    }
  }
};
globalThis.__worker_ready__ = true;
postMessage({ type: 'ready' });`;

export function spawn<T>(fn: () => T): WorkerScript<T> {
  const site = getCallSite(import.meta.url);
  const baseCacheKey = `${site.url}:${site.line}:${site.col}`;

  if (!SCOPE_ANALYSIS_CACHE.has(baseCacheKey)) analyzeScope(site, baseCacheKey);

  const { locals, topLevels } = SCOPE_ANALYSIS_CACHE.get(baseCacheKey)!;
  const allVars = [...locals, ...topLevels];

  return `globalThis.__worker_wrapper__({${allVars.join(",")}}, ${
    JSON.stringify(topLevels)
  }, ${
    JSON.stringify(fn.toString())
  }, "${site.url}", "${baseCacheKey}")` as WorkerScript<T>;
}

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
    )() as (p: Record<string, unknown>) => () => unknown;
    return Promise.resolve().then(() => wrapper(props)());
  }

  for (const name of topLevelCandidates) {
    if (name in props) {
      const val = props[name];
      if (val instanceof Global || !isStructuredClonable(val)) {
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

      // Maps the copy's call sites back to the original module, so Global
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

  return new Promise((resolve, reject) => {
    const w = entry.worker;
    let cleaned = false;

    const sendMessage = () => {
      const globalMemory = Object.fromEntries(GLOBAL_MEMORY.entries());
      try {
        // Captured props are cloned, never transferred: transferring would
        // detach buffers still owned by the calling thread.
        w.postMessage({ props, globalMemory });
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
      const { type, result, error } = e.data as {
        type: string;
        result: unknown;
        error: unknown;
      };
      if (type === "ready") {
        entry.initialized = true;
        sendMessage();
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

    w.addEventListener("message", onMsg);
    w.addEventListener("error", onError);

    if (entry.initialized) sendMessage();
  });
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
    if (
      n.pos <= pos && n.end >= pos && ts.isCallExpression(n) &&
      n.expression.getText() === "spawn"
    ) {
      fnNode = n.arguments[0] as ts.FunctionLikeDeclaration;
    } else {
      ts.forEachChild(n, findFn);
    }
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
// preserves every line and column, which Global call-site IDs depend on.
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
