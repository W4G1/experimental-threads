// @ts-nocheck: polyfill file for node

import { isMainThread, parentPort, Worker as NodeWorker } from "node:worker_threads";

globalThis.self = globalThis;

globalThis.ErrorEvent = class ErrorEvent extends Event {
  public message: string;
  public filename: string;
  public lineno: number;
  public colno: number;
  public error: any;

  constructor(type: string, init?: ErrorEventInit) {
    super(type, init);
    this.message = init?.message ?? "";
    this.filename = init?.filename ?? "";
    this.lineno = init?.lineno ?? 0;
    this.colno = init?.colno ?? 0;
    this.error = init?.error ?? null;
  }
};

if (isMainThread) {
  globalThis.Worker = class Worker extends EventTarget {
    public onmessage: ((this: Worker, ev: MessageEvent) => any) | null = null;
    public onerror: ((this: Worker, ev: ErrorEvent) => any) | null = null;

    private readonly _worker: any;
    private readonly _onMessage: (data: any) => void;
    private readonly _onError: (error: Error) => void;
    private readonly _onExit: (code: number) => void;

    constructor(scriptURL: string | URL, options?: WorkerOptions) {
      super();
      this._worker = new NodeWorker(
        scriptURL.toString().startsWith("file://") ? new URL(scriptURL.toString()) : scriptURL.toString(),
        { ...options },
      );

      this._onMessage = (data: any) => {
        const event = new MessageEvent("message", { data });
        this.dispatchEvent(event);
        this.onmessage?.(event);
      };

      this._onError = (error: Error) => {
        const event = new ErrorEvent("error", { error, message: error.message });
        this.dispatchEvent(event);
        this.onerror?.(event);
      };

      this._onExit = (code: number) => {
        if (code !== 0) {
          const err = new Error(`Worker stopped with exit code ${code}`);
          const event = new ErrorEvent("error", { error: err, message: err.message });
          this.dispatchEvent(event);
          this.onerror?.(event);
        }
      };

      this._worker.on("message", this._onMessage);
      this._worker.on("error", this._onError);
      this._worker.on("exit", this._onExit);
    }

    postMessage(message: any, transfer: Transferable[]) {
      this._worker.postMessage(message, transfer);
    }

    terminate() {
      this._worker.off("message", this._onMessage);
      this._worker.off("error", this._onError);
      this._worker.off("exit", this._onExit);
      this._worker.terminate();
    }
  };
}

if (!isMainThread && parentPort) {
  // Symbol.hasInstance makes `self instanceof WorkerGlobalScope` return true
  // without changing the prototype of the Node.js global object.
  class WorkerGlobalScope extends EventTarget {
    static [Symbol.hasInstance](instance: unknown) {
      return instance === globalThis;
    }
  }

  globalThis.WorkerGlobalScope = WorkerGlobalScope;

  globalThis.postMessage = (message: any, transfer?: Transferable[]) => {
    parentPort.postMessage(message, transfer);
  };

  let currentHandler = globalThis.onmessage;
  Object.defineProperty(globalThis, "onmessage", {
    get: () => currentHandler,
    set: (fn) => { currentHandler = fn; },
    configurable: true,
    enumerable: true,
  });

  parentPort.on("message", (data) => {
    if (typeof globalThis.onmessage === "function") {
      globalThis.onmessage(new MessageEvent("message", { data }));
    }
  });
}
