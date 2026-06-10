import { Mutex } from "experimental-threads";

export const rawMutex = new Mutex(new SharedArrayBuffer(4));

export const getRaw = (m: Mutex) =>
  new Int32Array((m as any)._data as SharedArrayBuffer)[0];
export const setRaw = (m: Mutex, v: number) =>
  new Int32Array((m as any)._data as SharedArrayBuffer)[0] = v;
