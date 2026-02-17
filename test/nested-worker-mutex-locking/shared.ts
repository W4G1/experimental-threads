import { Global, Mutex } from "experimental-threads";

export const sharedMutex = new Global(new Mutex(new SharedArrayBuffer(4)));
export const sharedSignal = new Global(new SharedArrayBuffer(4));

export const getCounter = () =>
  new Int32Array((sharedMutex.value as any)._data)[0];

export const setCounter = (v: number) =>
  new Int32Array((sharedMutex.value as any)._data)[0] = v;

const sig = () => new Int32Array(sharedSignal.value);
export const getSignal = () => Atomics.load(sig(), 0);
export const setSignal = (v: number) => Atomics.store(sig(), 0, v);
