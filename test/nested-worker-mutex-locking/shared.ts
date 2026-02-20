import { Global, Mutex } from "experimental-threads";

export const sharedMutex = new Global(new Mutex(new SharedArrayBuffer(4)));
