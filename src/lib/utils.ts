export function getCallSite(callFile = import.meta.url) {
  const line = new Error().stack!.split("\n").find((l) =>
    l.includes("file:") && !l.includes(callFile) && !l.includes(import.meta.url)
  )!;
  const m = line.match(/(file:\/\/.+?):(\d+):(\d+)/)!;
  return { url: m[1]!, line: +m[2]!, col: +m[3]! };
}

export function getTransferables(obj: unknown): Transferable[] {
  const transferables = new Set<Transferable>();
  const seen = new Set<unknown>();

  function walk(value: unknown) {
    if (!value || typeof value !== "object") return;
    if (seen.has(value)) return;
    seen.add(value);
    if (value instanceof ArrayBuffer) {
      if (!(value instanceof SharedArrayBuffer)) {
        transferables.add(value);
      }
    } else if (
      value instanceof MessagePort ||
      value instanceof ImageBitmap
      // || value instanceof OffscreenCanvas
    ) {
      transferables.add(value as Transferable);
    } else if (ArrayBuffer.isView(value)) {
      if (value.buffer && !(value.buffer instanceof SharedArrayBuffer)) {
        transferables.add(value.buffer);
      }
    } else if (
      value instanceof ReadableStream ||
      value instanceof WritableStream ||
      value instanceof TransformStream
    ) {
      transferables.add(value as Transferable);
    } else {
      for (const key in value) {
        walk((value as Record<string, unknown>)[key]);
      }
    }
  }

  walk(obj);
  return Array.from(transferables);
}

export function isStructuredClonable(val: unknown): boolean {
  if (val === undefined || val === null) return true;
  if (typeof val === "function") return false;
  if (typeof val === "symbol") return false;
  if (typeof val !== "object") return true;
  if (val instanceof SharedArrayBuffer) return true;
  if (val instanceof ArrayBuffer) return true;
  if (ArrayBuffer.isView(val)) return true;
  if (
    val instanceof MessagePort ||
    val instanceof ImageBitmap ||
    // val instanceof OffscreenCanvas ||
    val instanceof ReadableStream ||
    val instanceof WritableStream ||
    val instanceof TransformStream
  ) {
    return true;
  }
  // Check proxy
  try {
    structuredClone(val);
    return true;
  } catch {
    return false;
  }
}
