import { Mutex, Shared } from "experimental-threads";

export const sharedMutex = new Shared(new Mutex(new SharedArrayBuffer(4)));
