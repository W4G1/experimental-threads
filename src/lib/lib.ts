import ts from "typescript";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join, resolve } from "node:path";
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
    props: any,
    topLevelVars: string[],
    fnStr: string,
    url: string,
    baseCacheKey: string,
  ): Promise<any>;
}

const FILE_CACHE = new Map<string, ts.SourceFile>();
const SCOPE_ANALYSIS_CACHE = new Map<
  string,
  { locals: string[]; topLevels: string[] }
>();
const PATCHED_SOURCE_CACHE = new Map<string, string>();
const PATH_CACHE = new Map<string, string>();

interface PoolEntry {
  worker: Worker;
  busy: boolean;
  timer?: number;
  filePath: string;
}

const WORKER_POOL = new Map<string, PoolEntry[]>();
let TOTAL_ACTIVE_WORKERS = 0;

const PRIMITIVES_URL = new URL("./primitives.ts", import.meta.url).href;
const UTILS_URL = new URL("./utils.ts", import.meta.url).href;

const WORKER_SPLIT_MARKER = "/* __INJECTED_WORKER_BOOTSTRAP__ */";

const WORKER_BODY = `${WORKER_SPLIT_MARKER}
import { hydrate, hydrateGlobalMemory } from "${PRIMITIVES_URL}";
import { getTransferables } from "${UTILS_URL}";
self.onmessage = async ({ data }) => {
  if (data.globalMemory) {
    hydrateGlobalMemory(data.globalMemory);
  }
  const hydratedProps = hydrate(data.props);
  try {
    const result = await (%FN%)(hydratedProps)();
    const transfer = getTransferables(result);
    postMessage({ type: 'success', result }, transfer);
  } catch (error) {
    postMessage({ type: 'error', error });
  }
}`;

export function spawn<T>(fn: () => T): WorkerScript<T> {
  const site = getCallSite(import.meta.url);
  const baseCacheKey = `${site.url}:${site.line}:${site.col}`;

  if (!SCOPE_ANALYSIS_CACHE.has(baseCacheKey)) {
    analyzeScope(site, baseCacheKey);
  }

  const { locals, topLevels } = SCOPE_ANALYSIS_CACHE.get(baseCacheKey)!;
  const allVars = [...locals, ...topLevels];

  return `globalThis.__worker_wrapper__({${allVars.join(",")}}, ${
    JSON.stringify(topLevels)
  }, ${
    JSON.stringify(fn.toString())
  }, "${site.url}", "${baseCacheKey}")` as any;
}

globalThis.__worker_wrapper__ = async (
  props,
  topLevelCandidates,
  fnStr,
  url,
  baseCacheKey,
) => {
  // Filter Props
  for (const name of topLevelCandidates) {
    if (name in props) {
      const val = props[name];

      if (val instanceof Global) {
        delete props[name];
        continue;
      }

      if (!isStructuredClonable(val)) {
        delete props[name];
      }
    }
  }

  const finalVars = Object.keys(props).sort();
  const signatureKey = `${baseCacheKey}::${finalVars.join(",")}`;

  let pool = WORKER_POOL.get(signatureKey);
  if (!pool) {
    pool = [];
    WORKER_POOL.set(signatureKey, pool);
  }

  let entry = pool.find((e) => !e.busy);

  if (!entry) {
    let filePath = PATH_CACHE.get(signatureKey);

    if (!filePath) {
      let rawCode = readFileSync(fileURLToPath(url), "utf-8");

      const splitIdx = rawCode.indexOf(WORKER_SPLIT_MARKER);
      if (splitIdx > -1) {
        rawCode = rawCode.substring(0, splitIdx);
      }

      let patchedCode = PATCHED_SOURCE_CACHE.get(url);
      if (!patchedCode) {
        patchedCode = patchImports(rawCode, url);
        PATCHED_SOURCE_CACHE.set(url, patchedCode);
      }

      const wrapper = `(({${finalVars.join(",")}}) => ${fnStr})`;
      const finalWorkerCode = patchedCode +
        WORKER_BODY.replace("%FN%", wrapper);

      const hash = createHash("md5").update(signatureKey).digest("hex");
      const workerDir = resolve(process.cwd(), ".workers");

      if (!existsSync(workerDir)) {
        mkdirSync(workerDir, { recursive: true });
      }

      filePath = join(workerDir, `${hash}.ts`);
      writeFileSync(filePath, finalWorkerCode);
      PATH_CACHE.set(signatureKey, filePath);
    }

    TOTAL_ACTIVE_WORKERS++;
    if (TOTAL_ACTIVE_WORKERS > WORKER_WARNING_THRESHOLD) {
      console.warn(`High worker count: ${TOTAL_ACTIVE_WORKERS}`);
    }

    const fileUrl = pathToFileURL(filePath).href;

    entry = {
      worker: new Worker(fileUrl, { type: "module" }),
      busy: false,
      filePath,
    };
    pool.push(entry);
  } else {
    if (entry.timer) {
      clearTimeout(entry.timer);
      delete entry.timer;
    }
  }

  entry.busy = true;

  return new Promise((resolve, reject) => {
    const w = entry.worker;

    const onMsg = (e: MessageEvent) => {
      cleanup();
      const { type, result, error } = e.data;
      if (type === "error") reject(error);
      else resolve(result);
    };

    const onError = (e: ErrorEvent) => {
      cleanup();
      reject(e.error);
    };

    const cleanup = () => {
      w.removeEventListener("message", onMsg);
      w.removeEventListener("error", onError);
      entry!.busy = false;
      entry!.timer = setTimeout(() => {
        w.terminate();
        TOTAL_ACTIVE_WORKERS--;
        const idx = pool!.indexOf(entry!);
        if (idx > -1) pool!.splice(idx, 1);
      }, WORKER_IDLE_TIMEOUT_MS);
    };

    w.addEventListener("message", onMsg);
    w.addEventListener("error", onError);

    const globalMemory = Object.fromEntries(GLOBAL_MEMORY.entries());
    const transferList = getTransferables(props);

    w.postMessage({ props, globalMemory }, transferList);
  });
};

function analyzeScope(
  site: { url: string; line: number; col: number },
  cacheKey: string,
) {
  const path = fileURLToPath(site.url);
  let file = FILE_CACHE.get(path);

  if (!file) {
    const code = readFileSync(path, "utf-8");
    file = ts.createSourceFile("x.ts", code, 99, true);
    FILE_CACHE.set(path, file);
  }

  const pos = file.getPositionOfLineAndCharacter(site.line - 1, site.col - 1);
  let fnNode: ts.FunctionLikeDeclaration | undefined;

  const findFn = (n: ts.Node) => {
    if (
      n.pos <= pos && n.end >= pos && ts.isCallExpression(n) &&
      n.expression.getText() === "spawn"
    ) {
      fnNode = n.arguments[0] as ts.FunctionLikeDeclaration;
    } else ts.forEachChild(n, findFn);
  };
  findFn(file);

  const locals = new Set<string>();
  const topLevels = new Set<string>();

  if (fnNode) {
    const isInternal = (n: ts.Node) => {
      let p = n;
      while (p) {
        if (p === fnNode) return true;
        p = p.parent;
      }
      return false;
    };

    const visit = (n: ts.Node) => {
      if (ts.isIdentifier(n) && isValidUsage(n)) {
        let curr: ts.Node | undefined = n.parent;

        while (curr) {
          if (defines(curr, n.text)) {
            if (!isInternal(curr)) {
              if (curr.kind === ts.SyntaxKind.SourceFile) {
                topLevels.add(n.text);
              } else {
                locals.add(n.text);
              }
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

function isValidUsage(n: ts.Node) {
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

function defines(n: any, name: string): boolean {
  // Function parameters (including destructuring)
  if (ts.isFunctionLike(n)) {
    return n.parameters.some((p) => bindingHasName(p.name, name));
  }

  // Variable declarations in blocks
  if ((ts.isBlock(n) || n.kind === ts.SyntaxKind.SourceFile) && n.statements) {
    return n.statements.some((s: any) => {
      if (ts.isVariableStatement(s)) {
        return s.declarationList.declarations.some((d: any) =>
          bindingHasName(d.name, name)
        );
      }
      if (
        (ts.isFunctionDeclaration(s) || ts.isClassDeclaration(s)) &&
        s.name?.text === name
      ) return true;
      if (ts.isImportDeclaration(s) && s.importClause) {
        const clause = s.importClause;
        if (clause.name?.text === name) return true;
        if (clause.namedBindings) {
          if (ts.isNamedImports(clause.namedBindings)) {
            return clause.namedBindings.elements.some((e) =>
              e.name.text === name
            );
          }
          if (ts.isNamespaceImport(clause.namedBindings)) {
            return clause.namedBindings.name.text === name;
          }
        }
      }
      return false;
    });
  }

  // For loop variables
  if (
    ts.isForStatement(n) && n.initializer &&
    ts.isVariableDeclarationList(n.initializer)
  ) {
    return n.initializer.declarations.some((d: any) =>
      bindingHasName(d.name, name)
    );
  }

  // Catch clause variables
  if (ts.isCatchClause(n) && n.variableDeclaration) {
    return bindingHasName(n.variableDeclaration.name, name);
  }

  return false;
}

function bindingHasName(node: ts.BindingName, name: string): boolean {
  if (ts.isIdentifier(node)) {
    return node.text === name;
  }

  // Handle ObjectBindingPattern ({ a, b: c })
  if (ts.isObjectBindingPattern(node)) {
    return node.elements.some((el) => bindingHasName(el.name, name));
  }

  // Handle ArrayBindingPattern ([a, b])
  if (ts.isArrayBindingPattern(node)) {
    return node.elements.some((el) => {
      // Skip holes in array destructuring: const [, b] = arr
      // ts.isBindingElement ensures 'el' has a 'name' property
      if (!ts.isBindingElement(el)) return false;
      return bindingHasName(el.name, name);
    });
  }

  return false;
}

function patchImports(code: string, base: string) {
  const r = (p: string) => /^\.\.?\//.test(p) ? new URL(p, base).href : p;
  const t: ts.TransformerFactory<ts.SourceFile> = (c) => (n) => {
    const v: ts.Visitor = (node) => {
      if (
        ts.isStringLiteral(node) &&
        (ts.isImportDeclaration(node.parent) ||
          ts.isExportDeclaration(node.parent))
      ) {
        return c.factory.createStringLiteral(r(node.text));
      }
      return ts.visitEachChild(node, v, c);
    };
    return ts.visitNode(n, v) as ts.SourceFile;
  };
  return ts.transpileModule(code, {
    compilerOptions: { target: ts.ScriptTarget.ESNext },
    transformers: { before: [t] },
  }).outputText;
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
