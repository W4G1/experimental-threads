import { getCallSite } from "./utils.ts";

export interface SharedArrayBufferOptions {
  maxByteLength?: number;
}

export const GLOBAL_MEMORY = new Map<string, SharedArrayBuffer>();
const PENDING_HYDRATION = new Map<string, Global<any>>();
const WORKER_MEMORY_CACHE = new Map<string, SharedArrayBuffer>();

export function hydrateGlobalMemory(
  map: Map<string, SharedArrayBuffer> | Record<string, SharedArrayBuffer>,
) {
  const entries = map instanceof Map ? map.entries() : Object.entries(map);
  for (const [key, buffer] of entries) {
    WORKER_MEMORY_CACHE.set(key, buffer);
    GLOBAL_MEMORY.set(key, buffer);

    const [baseId] = key.split("::");
    if (PENDING_HYDRATION.has(baseId!)) {
      const lock = PENDING_HYDRATION.get(baseId!)!;
      // Cast to any to access private method
      (lock as any)._tryHydrate();
    }
  }
}

export function getCallSiteId() {
  const site = getCallSite(import.meta.url);
  return `${site.url}:${site.line}:${site.col}`;
}

type Constructor<T> = new (
  buffer: SharedArrayBuffer,
  isHydrating?: boolean,
) => T;
const REGISTRY = new Map<string, Constructor<any>>();

export function register(name: string, cls: Constructor<any>) {
  REGISTRY.set(name, cls);
}

export function hydrate(obj: any): any {
  if (!obj || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map(hydrate);

  // Detect SharedStruct
  if (obj.__cls && REGISTRY.has(obj.__cls) && obj.state) {
    const Cls = REGISTRY.get(obj.__cls)!;
    const instance = new Cls(obj.state.buffer, true);

    for (const k in obj) {
      if (k === "__cls" || k === "state") continue;
      instance[k] = hydrate(obj[k]);
    }

    return instance;
  }

  // Standard object hydration
  for (const k in obj) {
    obj[k] = hydrate(obj[k]);
  }
  return obj;
}

export abstract class SharedStruct {
  protected state: Int32Array;

  constructor(
    readonly __cls: string,
    bufferOrSize: SharedArrayBuffer | number | SharedArrayBufferOptions,
    minSizeInt32: number,
  ) {
    let buffer: SharedArrayBuffer;

    if (bufferOrSize instanceof SharedArrayBuffer) {
      buffer = bufferOrSize;
    } else if (typeof bufferOrSize === "number") {
      buffer = new SharedArrayBuffer(Math.max(bufferOrSize, minSizeInt32 * 4));
    } else {
      const size = minSizeInt32 * 4;
      buffer = new SharedArrayBuffer(size, bufferOrSize);
    }

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
 * This class uses the call site (file path + line number) as a unique identity key.
 * When initialized in a Worker, it bypasses new allocation and instead looks up
 * the existing `SharedArrayBuffer` registered by the parent thread for this specific location.
 *
 * This guarantees referential integrity across boundaries:
 * `(Main) Global<T> === (Worker) Global<T>` (logically).
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
    const isMainThread = !("WorkerGlobalScope" in globalThis);
    const stateKey = `${this.id}::state`;
    const dataKey = `${this.id}::data`;

    let internalBuffer: SharedArrayBuffer;
    if (this._inner instanceof SharedArrayBuffer) {
      internalBuffer = this._inner;
    } else {
      // @ts-expect-error private field access
      internalBuffer = this._inner.buffer;
    }

    if (isMainThread) {
      if (GLOBAL_MEMORY.has(stateKey)) {
        this._applyStateBuffer(GLOBAL_MEMORY.get(stateKey)!);
      } else {
        GLOBAL_MEMORY.set(stateKey, internalBuffer);
      }

      const innerAny = this._inner as any;
      if (innerAny._data instanceof SharedArrayBuffer) {
        if (GLOBAL_MEMORY.has(dataKey)) {
          innerAny._data = GLOBAL_MEMORY.get(dataKey)!;
        } else {
          GLOBAL_MEMORY.set(dataKey, innerAny._data);
        }
      }
    } else {
      let fullyReady = true;

      if (WORKER_MEMORY_CACHE.has(stateKey)) {
        this._applyStateBuffer(WORKER_MEMORY_CACHE.get(stateKey)!);
      } else {
        fullyReady = false;
      }

      const innerAny = this._inner as any;
      if (innerAny._data instanceof SharedArrayBuffer) {
        if (WORKER_MEMORY_CACHE.has(dataKey)) {
          innerAny._data = WORKER_MEMORY_CACHE.get(dataKey)!;
        } else {
          fullyReady = false;
        }
      }

      if (!fullyReady) {
        PENDING_HYDRATION.set(this.id, this);
      } else {
        PENDING_HYDRATION.delete(this.id);
      }
    }
  }

  private _applyStateBuffer(buffer: SharedArrayBuffer) {
    if (this._inner instanceof SharedArrayBuffer) {
      this._inner = buffer as any;
    } else {
      // @ts-expect-error private field access
      this._inner._replaceBuffer(buffer);
    }
  }
}

export class Semaphore extends SharedStruct {
  private static readonly IDX_PERMITS = 0;

  constructor(arg: number | SharedArrayBuffer = 0, isHydrating = false) {
    const isStateBuffer = isHydrating && arg instanceof SharedArrayBuffer;
    const superArg = isStateBuffer ? (arg as SharedArrayBuffer) : 4;

    super("Semaphore", superArg, 1);

    if (!isStateBuffer && typeof arg === "number") {
      this.state[Semaphore.IDX_PERMITS] = arg;
    }
  }

  async acquire(amount = 1) {
    while (true) {
      const current = Atomics.load(this.state, Semaphore.IDX_PERMITS);
      if (current >= amount) {
        if (
          Atomics.compareExchange(
            this.state,
            Semaphore.IDX_PERMITS,
            current,
            current - amount,
          ) === current
        ) {
          return { [Symbol.dispose]: () => this.release(amount) };
        }
      } else {
        const res = Atomics.waitAsync(
          this.state,
          Semaphore.IDX_PERMITS,
          current,
        );
        if (res.async) await res.value;
      }
    }
  }

  release(amount = 1) {
    Atomics.add(this.state, Semaphore.IDX_PERMITS, amount);
    Atomics.notify(this.state, Semaphore.IDX_PERMITS, Infinity);
  }

  static {
    register("Semaphore", Semaphore);
  }
}

export class MutexGuard<T> {
  private _value: T;
  private _unlockFn: () => void;
  private _released = false;

  constructor(value: T, unlockFn: () => void) {
    this._value = value;
    this._unlockFn = unlockFn;
  }

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
  private static readonly IDX_LOCK_STATE = 0;
  private static readonly UNLOCKED = 0;
  private static readonly LOCKED = 1;

  private _data: T;

  constructor(arg?: T | SharedArrayBuffer, isHydrating = false) {
    const isStateBuffer = isHydrating && arg instanceof SharedArrayBuffer;
    const superArg = isStateBuffer ? (arg as SharedArrayBuffer) : 4;

    super("Mutex", superArg, 1);

    if (isStateBuffer) {
      this._data = undefined as unknown as T;
    } else {
      this._data = arg as T;
    }
  }

  async lock(): Promise<MutexGuard<T>> {
    while (true) {
      if (
        Atomics.compareExchange(
          this.state,
          Mutex.IDX_LOCK_STATE,
          Mutex.UNLOCKED,
          Mutex.LOCKED,
        ) === Mutex.UNLOCKED
      ) {
        return new MutexGuard(this._data, () => this.release());
      }
      const res = Atomics.waitAsync(
        this.state,
        Mutex.IDX_LOCK_STATE,
        Mutex.LOCKED,
      );
      if (res.async) await res.value;
    }
  }

  private release() {
    if (
      Atomics.compareExchange(
        this.state,
        Mutex.IDX_LOCK_STATE,
        Mutex.LOCKED,
        Mutex.UNLOCKED,
      ) !== Mutex.LOCKED
    ) {
      throw new Error("Mutex is not locked");
    }
    Atomics.notify(this.state, Mutex.IDX_LOCK_STATE, 1);
  }

  static {
    register("Mutex", this);
  }
}
