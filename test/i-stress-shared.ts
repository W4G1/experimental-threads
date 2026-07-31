import { Mutex, Shared } from "experimental-threads";

export const counter = new Shared(new Mutex(new SharedArrayBuffer(4)));
