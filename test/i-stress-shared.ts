import { Global, Mutex } from "experimental-threads";

export const counter = new Global(new Mutex(new SharedArrayBuffer(4)));
