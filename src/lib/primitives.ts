import { getCallSite } from "./utils.ts";

export interface SharedArrayBufferOptions {
  maxByteLength?: number;
}

const IS_MAIN_THREAD = !("WorkerGlobalScope" in globalThis);

export const GLOBAL_MEMORY = new Map<string, SharedArrayBuffer>();
const PENDING_HYDRATION = new Map<string, () => void>();

export function hydrateGlobalMemory(map: Record<string, SharedArrayBuffer>) {
  for (const [key, buffer] of Object.entries(map)) {
    GLOBAL_MEMORY.set(key, buffer);
    PENDING_HYDRATION.get(key.split("::")[0]!)?.();
  }
}

export function getCallSiteId() {
  const site = getCallSite(import.meta.url);
  return `${site.url}:${site.line}:${site.col}`;
}

type Constructor<T> = new (buffer: SharedArrayBuffer, isHydrating?: boolean) => T;
const REGISTRY = new Map<string, Constructor<SharedStruct>>();

export function register(name: string, cls: Constructor<SharedStruct>) {
  REGISTRY.set(name, cls);
}

export function hydrate(obj: unknown): unknown {
  if (!obj || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map(hydrate);

  const o = obj as Record<string, unknown>;
  if (typeof o["__cls"] === "string" && REGISTRY.has(o["__cls"]) && o["state"]) {
    const Cls = REGISTRY.get(o["__cls"] as string)!;
    const instance = new Cls((o["state"] as { buffer: SharedArrayBuffer }).buffer, true);
    for (const k in o) {
      if (k !== "__cls" && k !== "state") (instance as unknown as Record<string, unknown>)[k] = hydrate(o[k]);
    }
    return instance;
  }

  for (const k in o) o[k] = hydrate(o[k]);
  return o;
}

// Module-private accessor for SharedStruct internals.
// Avoids scattered @ts-expect-error casts when Global<T> needs to read/write
// protected and private fields of SharedStruct subclasses.
interface StructInternals {
  readonly buffer: SharedArrayBuffer;
  _data: SharedArrayBuffer | undefined;
  _replaceBuffer(buffer: SharedArrayBuffer): void;
}
const asInternals = (s: SharedStruct): StructInternals => s as unknown as StructInternals;

export abstract class SharedStruct {
  protected state: Int32Array;

  constructor(
    readonly __cls: string,
    bufferOrSize: SharedArrayBuffer | number | SharedArrayBufferOptions,
    minSizeInt32: number,
  ) {
    const buffer = bufferOrSize instanceof SharedArrayBuffer
      ? bufferOrSize
      : typeof bufferOrSize === "number"
      ? new SharedArrayBuffer(Math.max(bufferOrSize, minSizeInt32 * 4))
      : new SharedArrayBuffer(minSizeInt32 * 4, bufferOrSize);

    this.state = new Int32Array(buffer);
  }

  protected get buffer(): SharedArrayBuffer {
    return this.state.buffer as SharedArrayBuffer;
  }

  protected _replaceBuffer(newBuffer: SharedArrayBuffer) {
    this.state = new Int32Array(newBuffer);
  }
}

/**
 * Creates a location-dependent reference to a shared memory resource.
 *
 * Uses the call site (file path + line + column) as a stable identity key.
 * When instantiated in a Worker, it bypasses allocation and instead hydrates
 * from the `SharedArrayBuffer` registered by the parent thread at the same location,
 * guaranteeing referential equality across V8 isolates.
 */
export class Global<T extends SharedStruct | SharedArrayBuffer> {
  private _inner: T;
  private readonly id: string;

  constructor(value: T) {
    this.id = getCallSiteId();
    this._inner = value;
    this._tryHydrate();
  }

  get value(): T {
    return this._inner;
  }

  private _tryHydrate() {
    const stateKey = `${this.id}::state`;
    const dataKey = `${this.id}::data`;
    const inner = this._inner instanceof SharedArrayBuffer ? null : asInternals(this._inner);
    const stateBuffer = inner?.buffer ?? (this._inner as SharedArrayBuffer);

    if (IS_MAIN_THREAD) {
      const existing = GLOBAL_MEMORY.get(stateKey);
      if (existing) this._applyStateBuffer(existing);
      else GLOBAL_MEMORY.set(stateKey, stateBuffer);

      if (inner?._data instanceof SharedArrayBuffer) {
        const existingData = GLOBAL_MEMORY.get(dataKey);
        if (existingData) inner._data = existingData;
        else GLOBAL_MEMORY.set(dataKey, inner._data);
      }
    } else {
      let ready = true;

      const buf = GLOBAL_MEMORY.get(stateKey);
      if (buf) this._applyStateBuffer(buf);
      else ready = false;

      if (inner?._data instanceof SharedArrayBuffer) {
        const data = GLOBAL_MEMORY.get(dataKey);
        if (data) inner._data = data;
        else ready = false;
      }

      if (ready) {
        PENDING_HYDRATION.delete(this.id);
      } else {
        PENDING_HYDRATION.set(this.id, () => this._tryHydrate());
      }
    }
  }

  private _applyStateBuffer(buffer: SharedArrayBuffer) {
    if (this._inner instanceof SharedArrayBuffer) {
      this._inner = buffer as T;
    } else {
      asInternals(this._inner)._replaceBuffer(buffer);
    }
  }
}

export class Semaphore extends SharedStruct {
  private static readonly IDX = 0;

  constructor(arg: number | SharedArrayBuffer = 0, isHydrating = false) {
    const isStateBuffer = isHydrating && arg instanceof SharedArrayBuffer;
    super("Semaphore", isStateBuffer ? arg : 4, 1);
    if (!isStateBuffer && typeof arg === "number") {
      this.state[Semaphore.IDX] = arg;
    }
  }

  async acquire(amount = 1) {
    while (true) {
      const current = Atomics.load(this.state, Semaphore.IDX);
      if (current >= amount) {
        if (Atomics.compareExchange(this.state, Semaphore.IDX, current, current - amount) === current) {
          return { [Symbol.dispose]: () => this.release(amount) };
        }
      } else {
        const res = Atomics.waitAsync(this.state, Semaphore.IDX, current);
        if (res.async) await res.value;
      }
    }
  }

  release(amount = 1) {
    Atomics.add(this.state, Semaphore.IDX, amount);
    Atomics.notify(this.state, Semaphore.IDX, Infinity);
  }

  static {
    register("Semaphore", Semaphore);
  }
}

export class MutexGuard<T> {
  private _released = false;

  constructor(
    private readonly _value: T,
    private readonly _unlockFn: () => void,
  ) {}

  get value(): T {
    return this._value;
  }

  unlock() {
    if (this._released) return;
    this._released = true;
    this._unlockFn();
  }

  [Symbol.dispose]() {
    this.unlock();
  }
}

export class Mutex<
  T extends SharedArrayBuffer | SharedStruct = SharedArrayBuffer,
> extends SharedStruct {
  private static readonly IDX = 0;
  private static readonly UNLOCKED = 0;
  private static readonly LOCKED = 1;

  private _data: T;

  constructor(arg?: T | SharedArrayBuffer, isHydrating = false) {
    const isStateBuffer = isHydrating && arg instanceof SharedArrayBuffer;
    super("Mutex", isStateBuffer ? arg : 4, 1);
    this._data = isStateBuffer ? (undefined as unknown as T) : (arg as T);
  }

  async lock(): Promise<MutexGuard<T>> {
    while (true) {
      if (
        Atomics.compareExchange(this.state, Mutex.IDX, Mutex.UNLOCKED, Mutex.LOCKED) === Mutex.UNLOCKED
      ) {
        return new MutexGuard(this._data, () => this._release());
      }
      const res = Atomics.waitAsync(this.state, Mutex.IDX, Mutex.LOCKED);
      if (res.async) await res.value;
    }
  }

  private _release() {
    if (Atomics.compareExchange(this.state, Mutex.IDX, Mutex.LOCKED, Mutex.UNLOCKED) !== Mutex.LOCKED) {
      throw new Error("Mutex is not locked");
    }
    Atomics.notify(this.state, Mutex.IDX, 1);
  }

  static {
    register("Mutex", this);
  }
}
