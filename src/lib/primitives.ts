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

const SITE_COUNTS = new Map<string, number>();

export function getCallSiteId() {
  const site = getCallSite(import.meta.url);
  // Inside a worker, the spawning module runs as a copy under .workers/.
  // The copy's header tag maps call sites back to the original file so IDs
  // match the ones registered by the main thread.
  const src = (globalThis as any).__worker_source__;
  const base = src && site.url === src.workerUrl
    ? `${src.url}:${site.line - src.lineOffset}:${site.col}`
    : `${site.url}:${site.line}:${site.col}`;
  // Occurrence index keeps Globals created at the same site (helpers, loops)
  // distinct, while module re-evaluation still yields matching IDs.
  const count = SITE_COUNTS.get(base) ?? 0;
  SITE_COUNTS.set(base, count + 1);
  return `${base}#${count}`;
}

type Constructor<T> = new (
  buffer: SharedArrayBuffer,
  isHydrating?: boolean,
) => T;
const REGISTRY = new Map<string, Constructor<SharedStruct>>();

export function register(name: string, cls: Constructor<SharedStruct>) {
  REGISTRY.set(name, cls);
}

export function hydrate(
  obj: unknown,
  seen = new Map<object, unknown>(),
): unknown {
  if (!obj || typeof obj !== "object") return obj;
  if (seen.has(obj)) return seen.get(obj);

  if (Array.isArray(obj)) {
    seen.set(obj, obj);
    for (let i = 0; i < obj.length; i++) obj[i] = hydrate(obj[i], seen);
    return obj;
  }

  const o = obj as Record<string, unknown>;

  // Global is not a SharedStruct: restore its prototype without running the
  // constructor (which would derive a fresh call-site ID).
  if (o["__cls"] === "Global" && "_inner" in o) {
    const g = Object.create(Global.prototype) as Record<string, unknown>;
    seen.set(obj, g);
    g["id"] = o["id"];
    g["_inner"] = hydrate(o["_inner"], seen);
    return g;
  }

  if (
    typeof o["__cls"] === "string" && REGISTRY.has(o["__cls"]) && o["state"]
  ) {
    const Cls = REGISTRY.get(o["__cls"] as string)!;
    const instance = new Cls(
      (o["state"] as { buffer: SharedArrayBuffer }).buffer,
      true,
    );
    seen.set(obj, instance);
    for (const k in o) {
      if (k !== "__cls" && k !== "state") {
        (instance as unknown as Record<string, unknown>)[k] = hydrate(
          o[k],
          seen,
        );
      }
    }
    return instance;
  }

  seen.set(obj, obj);
  for (const k in o) o[k] = hydrate(o[k], seen);
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
const asInternals = (s: SharedStruct): StructInternals =>
  s as unknown as StructInternals;

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
  readonly __cls = "Global";
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
    const inner = this._inner instanceof SharedArrayBuffer
      ? null
      : asInternals(this._inner);
    const stateBuffer = inner?.buffer ?? (this._inner as SharedArrayBuffer);

    if (IS_MAIN_THREAD) {
      // Occurrence-indexed IDs are unique per construction, so register
      // unconditionally.
      GLOBAL_MEMORY.set(stateKey, stateBuffer);
      if (inner?._data instanceof SharedArrayBuffer) {
        GLOBAL_MEMORY.set(dataKey, inner._data);
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
        if (
          Atomics.compareExchange(
            this.state,
            Semaphore.IDX,
            current,
            current - amount,
          ) === current
        ) {
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
    /** Set for guards from `Mutex.lock()`; required by `Condvar.wait()`. */
    readonly mutex?: Mutex<any>,
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
        Atomics.compareExchange(
          this.state,
          Mutex.IDX,
          Mutex.UNLOCKED,
          Mutex.LOCKED,
        ) === Mutex.UNLOCKED
      ) {
        return new MutexGuard(this._data, () => this._release(), this);
      }
      const res = Atomics.waitAsync(this.state, Mutex.IDX, Mutex.LOCKED);
      if (res.async) await res.value;
    }
  }

  private _release() {
    if (
      Atomics.compareExchange(
        this.state,
        Mutex.IDX,
        Mutex.LOCKED,
        Mutex.UNLOCKED,
      ) !== Mutex.LOCKED
    ) {
      throw new Error("Mutex is not locked");
    }
    Atomics.notify(this.state, Mutex.IDX, 1);
  }

  static {
    register("Mutex", this);
  }
}

const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();
const EMPTY: unique symbol = Symbol("empty");

function encodeJson(value: unknown): Uint8Array {
  const json = JSON.stringify(value);
  if (json === undefined) {
    throw new TypeError("value must be JSON-serializable");
  }
  return TEXT_ENCODER.encode(json);
}

// Channel header slots (Int32 indices into `state`).
const CH_LOCK = 0;
const CH_HEAD = 1;
const CH_TAIL = 2;
const CH_USED = 3;
const CH_COUNT = 4;
const CH_CLOSED = 5;
const CH_HEADER_BYTES = 32;

/**
 * A Go-style multi-producer multi-consumer channel backed by a
 * `SharedArrayBuffer` ring buffer, so any isolate holding the same buffer
 * (via `Global<T>` or a captured variable) can send and receive.
 *
 * The constructor argument is the buffer capacity in **bytes**; a full
 * buffer blocks senders, which is the backpressure mechanism. `recv()`
 * resolves `undefined` once the channel is closed and drained, and
 * `for await (const v of channel)` iterates until then. The `*Sync`
 * variants block the calling thread with `Atomics.wait` and are intended
 * for worker threads.
 */
// Payloads are JSON, so typed arrays, BigInt, and cycles are unsupported.
// Swap encodeJson for node:v8 serialize if binary values are ever needed.
export class Channel<T> extends SharedStruct {
  constructor(arg: number | SharedArrayBuffer = 65536, isHydrating = false) {
    const isStateBuffer = isHydrating && arg instanceof SharedArrayBuffer;
    super(
      "Channel",
      isStateBuffer ? arg : CH_HEADER_BYTES + (arg as number),
      CH_HEADER_BYTES / 4,
    );
  }

  get closed(): boolean {
    return Atomics.load(this.state, CH_CLOSED) === 1;
  }

  /** Number of buffered messages. */
  get size(): number {
    return Atomics.load(this.state, CH_COUNT);
  }

  private get _capacity(): number {
    return this.buffer.byteLength - CH_HEADER_BYTES;
  }

  // A spinlock is enough here: the hold time is a short memcpy.
  private _lockState() {
    while (Atomics.compareExchange(this.state, CH_LOCK, 0, 1) !== 0) {
      // spin
    }
  }

  private _unlockState() {
    Atomics.store(this.state, CH_LOCK, 0);
  }

  private _preparePayload(value: T): Uint8Array {
    const payload = encodeJson(value);
    if (4 + payload.length > this._capacity) {
      throw new RangeError("value larger than channel buffer");
    }
    return payload;
  }

  private _trySendRaw(payload: Uint8Array): boolean {
    const size = this._capacity;
    const need = 4 + payload.length;
    this._lockState();
    if (size - Atomics.load(this.state, CH_USED) < need) {
      this._unlockState();
      return false;
    }
    const data = new Uint8Array(this.buffer, CH_HEADER_BYTES);
    const tail = Atomics.load(this.state, CH_TAIL);
    // Byte-wise modular writes: records wrap freely, no special-casing.
    for (let i = 0; i < 4; i++) {
      data[(tail + i) % size] = (payload.length >>> (i * 8)) & 0xff;
    }
    for (let i = 0; i < payload.length; i++) {
      data[(tail + 4 + i) % size] = payload[i]!;
    }
    Atomics.store(this.state, CH_TAIL, (tail + need) % size);
    Atomics.add(this.state, CH_USED, need);
    Atomics.add(this.state, CH_COUNT, 1);
    this._unlockState();
    Atomics.notify(this.state, CH_COUNT, Infinity);
    return true;
  }

  private _tryRecvRaw(): T | typeof EMPTY {
    this._lockState();
    if (Atomics.load(this.state, CH_COUNT) === 0) {
      this._unlockState();
      return EMPTY;
    }
    const size = this._capacity;
    const data = new Uint8Array(this.buffer, CH_HEADER_BYTES);
    const head = Atomics.load(this.state, CH_HEAD);
    let len = 0;
    for (let i = 0; i < 4; i++) len |= data[(head + i) % size]! << (i * 8);
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) bytes[i] = data[(head + 4 + i) % size]!;
    Atomics.store(this.state, CH_HEAD, (head + 4 + len) % size);
    Atomics.sub(this.state, CH_USED, 4 + len);
    Atomics.sub(this.state, CH_COUNT, 1);
    this._unlockState();
    Atomics.notify(this.state, CH_USED, Infinity);
    return JSON.parse(TEXT_DECODER.decode(bytes));
  }

  /** Sends a value, waiting for buffer space (backpressure). */
  async send(value: T): Promise<void> {
    const payload = this._preparePayload(value);
    while (true) {
      if (this.closed) throw new Error("send on closed channel");
      if (this._trySendRaw(payload)) return;
      // The 500ms timeout covers the notify-before-wait race on close.
      const used = Atomics.load(this.state, CH_USED);
      const res = Atomics.waitAsync(this.state, CH_USED, used, 500);
      if (res.async) await res.value;
    }
  }

  /** Blocking send; intended for worker threads. */
  sendSync(value: T): void {
    const payload = this._preparePayload(value);
    while (true) {
      if (this.closed) throw new Error("send on closed channel");
      if (this._trySendRaw(payload)) return;
      Atomics.wait(this.state, CH_USED, Atomics.load(this.state, CH_USED), 500);
    }
  }

  /** Receives the next value; `undefined` once closed and drained. */
  async recv(): Promise<T | undefined> {
    while (true) {
      const value = this._tryRecvRaw();
      if (value !== EMPTY) return value as T;
      if (this.closed) {
        const drain = this._tryRecvRaw();
        return drain === EMPTY ? undefined : drain as T;
      }
      const res = Atomics.waitAsync(this.state, CH_COUNT, 0, 500);
      if (res.async) await res.value;
    }
  }

  /** Blocking receive; intended for worker threads. */
  recvSync(): T | undefined {
    while (true) {
      const value = this._tryRecvRaw();
      if (value !== EMPTY) return value as T;
      if (this.closed) {
        const drain = this._tryRecvRaw();
        return drain === EMPTY ? undefined : drain as T;
      }
      Atomics.wait(this.state, CH_COUNT, 0, 500);
    }
  }

  /** Sends without waiting; `false` when the buffer is full. */
  trySend(value: T): boolean {
    if (this.closed) throw new Error("send on closed channel");
    return this._trySendRaw(this._preparePayload(value));
  }

  /** Receives without waiting; `undefined` when the buffer is empty. */
  tryRecv(): T | undefined {
    const value = this._tryRecvRaw();
    return value === EMPTY ? undefined : value as T;
  }

  close() {
    Atomics.store(this.state, CH_CLOSED, 1);
    Atomics.notify(this.state, CH_COUNT, Infinity);
    Atomics.notify(this.state, CH_USED, Infinity);
  }

  /** Iterates messages until the channel is closed and drained. */
  async *[Symbol.asyncIterator](): AsyncIterableIterator<T> {
    while (true) {
      const value = await this.recv();
      if (value === undefined) return;
      yield value;
    }
  }

  /**
   * Go-style select over multiple channels: resolves with the first
   * available message, or `undefined` when every channel is closed.
   */
  static async select<C extends readonly Channel<any>[]>(
    channels: C,
  ): Promise<
    | { index: number; value: C[number] extends Channel<infer U> ? U : never }
    | undefined
  > {
    while (true) {
      let allClosed = true;
      for (let i = 0; i < channels.length; i++) {
        const value = channels[i]!._tryRecvRaw();
        if (value !== EMPTY) return { index: i, value: value as any };
        if (!channels[i]!.closed) allClosed = false;
      }
      if (allClosed) return undefined;
      await Promise.race(channels.map((ch) => {
        const res = Atomics.waitAsync(ch.state, CH_COUNT, 0, 250);
        return res.async ? res.value : Promise.resolve(res.value);
      }));
    }
  }

  static {
    register("Channel", Channel);
  }
}

/** Go-style WaitGroup: `add()` work, `done()` it, `wait()` for zero. */
export class WaitGroup extends SharedStruct {
  private static readonly IDX = 0;

  constructor(arg: number | SharedArrayBuffer = 0, isHydrating = false) {
    const isStateBuffer = isHydrating && arg instanceof SharedArrayBuffer;
    super("WaitGroup", isStateBuffer ? arg : 4, 1);
    if (!isStateBuffer && typeof arg === "number" && arg !== 0) {
      this.state[WaitGroup.IDX] = arg;
    }
  }

  add(n = 1) {
    if (Atomics.add(this.state, WaitGroup.IDX, n) + n <= 0) {
      Atomics.notify(this.state, WaitGroup.IDX, Infinity);
    }
  }

  done() {
    this.add(-1);
  }

  async wait() {
    while (true) {
      const count = Atomics.load(this.state, WaitGroup.IDX);
      if (count <= 0) return;
      const res = Atomics.waitAsync(this.state, WaitGroup.IDX, count);
      if (res.async) await res.value;
    }
  }

  static {
    register("WaitGroup", WaitGroup);
  }
}

/**
 * Readers-writer lock: any number of concurrent readers or one writer.
 * State encoding: -1 = writer held, 0 = free, n > 0 = reader count.
 */
// Readers can starve a writer under sustained read load; add a
// writer-pending bit if that ever matters.
export class RwLock<
  T extends SharedArrayBuffer | SharedStruct = SharedArrayBuffer,
> extends SharedStruct {
  private static readonly IDX = 0;

  private _data: T;

  constructor(arg?: T | SharedArrayBuffer, isHydrating = false) {
    const isStateBuffer = isHydrating && arg instanceof SharedArrayBuffer;
    super("RwLock", isStateBuffer ? arg : 4, 1);
    this._data = isStateBuffer ? (undefined as unknown as T) : (arg as T);
  }

  async read(): Promise<MutexGuard<T>> {
    while (true) {
      const readers = Atomics.load(this.state, RwLock.IDX);
      if (readers >= 0) {
        if (
          Atomics.compareExchange(
            this.state,
            RwLock.IDX,
            readers,
            readers + 1,
          ) === readers
        ) {
          return new MutexGuard(this._data, () => this._releaseRead());
        }
        continue;
      }
      const res = Atomics.waitAsync(this.state, RwLock.IDX, readers);
      if (res.async) await res.value;
    }
  }

  async write(): Promise<MutexGuard<T>> {
    while (true) {
      if (Atomics.compareExchange(this.state, RwLock.IDX, 0, -1) === 0) {
        return new MutexGuard(this._data, () => this._releaseWrite());
      }
      const current = Atomics.load(this.state, RwLock.IDX);
      if (current === 0) continue;
      const res = Atomics.waitAsync(this.state, RwLock.IDX, current);
      if (res.async) await res.value;
    }
  }

  private _releaseRead() {
    if (Atomics.sub(this.state, RwLock.IDX, 1) === 1) {
      Atomics.notify(this.state, RwLock.IDX, Infinity);
    }
  }

  private _releaseWrite() {
    Atomics.store(this.state, RwLock.IDX, 0);
    Atomics.notify(this.state, RwLock.IDX, Infinity);
  }

  static {
    register("RwLock", RwLock);
  }
}

/** Rust-style condition variable, used together with `Mutex`. */
export class Condvar extends SharedStruct {
  private static readonly IDX = 0;

  constructor(arg?: SharedArrayBuffer, isHydrating = false) {
    const isStateBuffer = isHydrating && arg instanceof SharedArrayBuffer;
    super("Condvar", isStateBuffer ? arg : 4, 1);
  }

  /**
   * Releases the guard's mutex, waits for a notification, then re-acquires
   * the mutex and returns the new guard. Wakeups may be spurious: re-check
   * the condition in a loop.
   */
  async wait<T>(guard: MutexGuard<T>): Promise<MutexGuard<T>> {
    const mutex = guard.mutex;
    if (!mutex) {
      throw new Error(
        "Condvar.wait requires a guard obtained from Mutex.lock()",
      );
    }
    const epoch = Atomics.load(this.state, Condvar.IDX);
    guard.unlock();
    const res = Atomics.waitAsync(this.state, Condvar.IDX, epoch);
    if (res.async) await res.value;
    return mutex.lock() as Promise<MutexGuard<T>>;
  }

  notifyOne() {
    Atomics.add(this.state, Condvar.IDX, 1);
    Atomics.notify(this.state, Condvar.IDX, 1);
  }

  notifyAll() {
    Atomics.add(this.state, Condvar.IDX, 1);
    Atomics.notify(this.state, Condvar.IDX, Infinity);
  }

  static {
    register("Condvar", Condvar);
  }
}

/** One-time cross-isolate initialization (Go's `sync.Once`). */
export class Once extends SharedStruct {
  private static readonly IDX = 0;
  private static readonly NEW = 0;
  private static readonly RUNNING = 1;
  private static readonly DONE = 2;

  constructor(arg?: SharedArrayBuffer, isHydrating = false) {
    const isStateBuffer = isHydrating && arg instanceof SharedArrayBuffer;
    super("Once", isStateBuffer ? arg : 4, 1);
  }

  get done(): boolean {
    return Atomics.load(this.state, Once.IDX) === Once.DONE;
  }

  /** Runs `fn` in exactly one caller; everyone else waits for completion. */
  async do(fn: () => void | Promise<void>): Promise<void> {
    while (true) {
      const status = Atomics.compareExchange(
        this.state,
        Once.IDX,
        Once.NEW,
        Once.RUNNING,
      );
      if (status === Once.DONE) return;
      if (status === Once.NEW) {
        try {
          await fn();
          Atomics.store(this.state, Once.IDX, Once.DONE);
        } catch (err) {
          // A failed init resets so another caller can retry.
          Atomics.store(this.state, Once.IDX, Once.NEW);
          throw err;
        } finally {
          Atomics.notify(this.state, Once.IDX, Infinity);
        }
        return;
      }
      const res = Atomics.waitAsync(this.state, Once.IDX, Once.RUNNING, 500);
      if (res.async) await res.value;
    }
  }

  static {
    register("Once", Once);
  }
}

const OC_STATUS = 0;
const OC_LEN = 1;
const OC_HEADER_BYTES = 8;

/**
 * A write-once cross-isolate value cell. The winning initializer's value is
 * JSON-serialized into shared memory; every other isolate reads it back.
 * The constructor argument is the value buffer size in bytes.
 */
export class OnceCell<T> extends SharedStruct {
  constructor(arg: number | SharedArrayBuffer = 4096, isHydrating = false) {
    const isStateBuffer = isHydrating && arg instanceof SharedArrayBuffer;
    super(
      "OnceCell",
      isStateBuffer ? arg : OC_HEADER_BYTES + (arg as number),
      OC_HEADER_BYTES / 4,
    );
  }

  get(): T | undefined {
    if (Atomics.load(this.state, OC_STATUS) !== 2) return undefined;
    const len = Atomics.load(this.state, OC_LEN);
    // slice() copies out of shared memory: TextDecoder rejects SAB views.
    const bytes = new Uint8Array(this.buffer, OC_HEADER_BYTES, len).slice();
    return JSON.parse(TEXT_DECODER.decode(bytes));
  }

  async getOrInit(fn: () => T | Promise<T>): Promise<T> {
    while (true) {
      const status = Atomics.compareExchange(this.state, OC_STATUS, 0, 1);
      if (status === 2) return this.get() as T;
      if (status === 0) {
        try {
          const value = await fn();
          const payload = encodeJson(value);
          if (payload.length > this.buffer.byteLength - OC_HEADER_BYTES) {
            throw new RangeError("value larger than OnceCell buffer");
          }
          new Uint8Array(this.buffer, OC_HEADER_BYTES).set(payload);
          Atomics.store(this.state, OC_LEN, payload.length);
          Atomics.store(this.state, OC_STATUS, 2);
          return value;
        } catch (err) {
          Atomics.store(this.state, OC_STATUS, 0);
          throw err;
        } finally {
          Atomics.notify(this.state, OC_STATUS, Infinity);
        }
      }
      const res = Atomics.waitAsync(this.state, OC_STATUS, 1, 500);
      if (res.async) await res.value;
    }
  }

  static {
    register("OnceCell", OnceCell);
  }
}

/** Reusable barrier: `wait()` resolves once `n` parties have arrived. */
export class Barrier extends SharedStruct {
  private static readonly ARRIVED = 0;
  private static readonly GENERATION = 1;
  private static readonly PARTIES = 2;

  constructor(arg: number | SharedArrayBuffer, isHydrating = false) {
    const isStateBuffer = isHydrating && arg instanceof SharedArrayBuffer;
    super("Barrier", isStateBuffer ? arg : 12, 3);
    if (!isStateBuffer && typeof arg === "number") {
      this.state[Barrier.PARTIES] = arg;
    }
  }

  /** Resolves `true` for the party that tripped the barrier (the leader). */
  async wait(): Promise<boolean> {
    const generation = Atomics.load(this.state, Barrier.GENERATION);
    const arrived = Atomics.add(this.state, Barrier.ARRIVED, 1) + 1;
    if (arrived === Atomics.load(this.state, Barrier.PARTIES)) {
      Atomics.store(this.state, Barrier.ARRIVED, 0);
      Atomics.add(this.state, Barrier.GENERATION, 1);
      Atomics.notify(this.state, Barrier.GENERATION, Infinity);
      return true;
    }
    while (Atomics.load(this.state, Barrier.GENERATION) === generation) {
      const res = Atomics.waitAsync(
        this.state,
        Barrier.GENERATION,
        generation,
        500,
      );
      if (res.async) await res.value;
    }
    return false;
  }

  static {
    register("Barrier", Barrier);
  }
}
