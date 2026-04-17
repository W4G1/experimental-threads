import ts from "typescript";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { extname, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import process from "node:process";
import { Global, GLOBAL_MEMORY } from "./primitives.ts";
import {
  getCallSite,
  getTransferables,
  isStructuredClonable,
} from "./utils.ts";

export { Global, Mutex, type MutexGuard, Semaphore } from "./primitives.ts";

export const isMainThread = !("WorkerGlobalScope" in globalThis);
declare const marker: unique symbol;
export type WorkerScript<T> = string & { readonly [marker]: T };

const WORKER_IDLE_TIMEOUT_MS = 1000 * 30;
const WORKER_WARNING_THRESHOLD = navigator.hardwareConcurrency * 4;

declare global {
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
  filePath: string;
  initialized: boolean;
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

globalThis.__worker_wrapper__ = async (
  props,
  topLevelCandidates,
  fnStr,
  url,
  baseCacheKey,
) => {
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

      let rawCode = readFileSync(fileURLToPath(url), "utf-8");
      const splitIdx = rawCode.indexOf(WORKER_SPLIT_MARKER);
      if (splitIdx > -1) rawCode = rawCode.substring(0, splitIdx);
      // Strip existing header to avoid doubling it in nested workers
      if (rawCode.startsWith(noCheckHeader)) rawCode = rawCode.substring(noCheckHeader.length);

      let patchedCode = PATCHED_SOURCE_CACHE.get(url);
      if (!patchedCode) {
        patchedCode = patchImports(rawCode, url);
        PATCHED_SOURCE_CACHE.set(url, patchedCode);
      }

      const wrapper = `(({${finalVars.join(",")}}) => ${fnStr})`;
      const hash = createHash("md5").update(signatureKey).digest("hex");
      const workerDir = resolve(process.cwd(), ".workers");

      if (!existsSync(workerDir)) mkdirSync(workerDir, { recursive: true });

      const fileExt = extname(fileURLToPath(url)) || ".js";
      filePath = join(workerDir, `${hash}${fileExt}`);
      writeFileSync(filePath, noCheckHeader + patchedCode + workerBody(wrapper));
      PATH_CACHE.set(signatureKey, filePath);
    }

    if (++TOTAL_ACTIVE_WORKERS > WORKER_WARNING_THRESHOLD) {
      console.warn(`High worker count: ${TOTAL_ACTIVE_WORKERS}`);
    }

    entry = {
      worker: new Worker(pathToFileURL(filePath).href, { type: "module" }),
      busy: true,
      filePath,
      initialized: false,
    };
    pool.push(entry);
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
      const transferList = getTransferables(props);
      try {
        w.postMessage({ props, globalMemory }, transferList);
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
      entry.busy = false;
      entry.timer = setTimeout(() => {
        w.terminate();
        TOTAL_ACTIVE_WORKERS--;
        const idx = pool!.indexOf(entry);
        if (idx > -1) pool!.splice(idx, 1);
      }, WORKER_IDLE_TIMEOUT_MS);
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
      if (type === "error") reject(error);
      else resolve(result);
    };

    const onError = (e: ErrorEvent) => {
      cleanup();
      reject(e.error);
    };

    w.addEventListener("message", onMsg);
    w.addEventListener("error", onError);

    if (entry.initialized) sendMessage();
  });
};

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
  return true;
}

function defines(n: ts.Node, name: string): boolean {
  if (ts.isFunctionLike(n)) {
    return n.parameters.some((p) => bindingHasName(p.name, name));
  }

  if (ts.isBlock(n) || ts.isSourceFile(n)) {
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
    ts.isForStatement(n) && n.initializer &&
    ts.isVariableDeclarationList(n.initializer)
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

function patchImports(code: string, base: string) {
  const resolve = (p: string) => /^\.\.?\//.test(p) ? new URL(p, base).href : p;

  const sourceFile = ts.createSourceFile(
    fileURLToPath(base),
    code,
    ts.ScriptTarget.ESNext,
    true,
  );

  const transformer: ts.TransformerFactory<ts.SourceFile> = (ctx) => (node) => {
    const visitor: ts.Visitor = (n) => {
      if (
        ts.isStringLiteral(n) && n.parent &&
        (ts.isImportDeclaration(n.parent) || ts.isExportDeclaration(n.parent))
      ) {
        return ctx.factory.createStringLiteral(resolve(n.text));
      }
      return ts.visitEachChild(n, visitor, ctx);
    };
    return ts.visitNode(node, visitor) as ts.SourceFile;
  };

  const result = ts.transform(sourceFile, [transformer]);
  return ts.createPrinter({ newLine: ts.NewLineKind.LineFeed }).printNode(
    ts.EmitHint.SourceFile,
    result.transformed[0]!,
    sourceFile,
  );
}

export function shutdown() {
  for (const pool of WORKER_POOL.values()) {
    for (const entry of pool) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.worker.terminate();
    }
  }
  WORKER_POOL.clear();
  TOTAL_ACTIVE_WORKERS = 0;
}
