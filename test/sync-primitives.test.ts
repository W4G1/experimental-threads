import { assert, assertEquals } from "@std/assert";
import { delay } from "@std/async";
import {
  Barrier,
  Condvar,
  Global,
  Mutex,
  Once,
  OnceCell,
  RwLock,
  shutdown,
  spawn,
  WaitGroup,
} from "experimental-threads";

const wg = new Global(new WaitGroup());
const wgCounter = new Global(new SharedArrayBuffer(4));

Deno.test("WaitGroup waits for spawned workers", async () => {
  try {
    wg.value.add(2);
    const h1 = eval(spawn(() => {
      Atomics.add(new Int32Array(wgCounter.value), 0, 1);
      wg.value.done();
    }));
    const h2 = eval(spawn(() => {
      Atomics.add(new Int32Array(wgCounter.value), 0, 1);
      wg.value.done();
    }));

    await wg.value.wait();
    assertEquals(Atomics.load(new Int32Array(wgCounter.value), 0), 2);
    await h1;
    await h2;
  } finally {
    shutdown();
  }
});

Deno.test("RwLock allows concurrent readers and excludes the writer", async () => {
  const rw = new RwLock(new SharedArrayBuffer(4));
  const r1 = await rw.read();
  const r2 = await rw.read();

  let writerIn = false;
  const writer = rw.write().then((g) => {
    writerIn = true;
    new Int32Array(g.value)[0] = 5;
    g.unlock();
  });

  await delay(20);
  assert(!writerIn, "writer must wait for readers");

  r1.unlock();
  r2.unlock();
  await writer;
  assert(writerIn);

  using g = await rw.read();
  assertEquals(new Int32Array(g.value)[0], 5);
});

Deno.test("Condvar wakes a waiter after the condition changes", async () => {
  const mutex = new Mutex(new SharedArrayBuffer(4));
  const cv = new Condvar();

  let guard = await mutex.lock();

  const setter = (async () => {
    await delay(20);
    const g = await mutex.lock();
    new Int32Array(g.value)[0] = 7;
    g.unlock();
    cv.notifyAll();
  })();

  while (new Int32Array(guard.value)[0] !== 7) {
    guard = await cv.wait(guard);
  }
  guard.unlock();
  await setter;
});

Deno.test("Once runs exactly one initializer across racers", async () => {
  const once = new Once();
  let runs = 0;

  await Promise.all([1, 2, 3].map(() =>
    once.do(async () => {
      await delay(10);
      runs++;
    })
  ));

  assertEquals(runs, 1);
  assert(once.done);
});

Deno.test("OnceCell initializes once and shares the value", async () => {
  const cell = new OnceCell<{ port: number }>();

  const [a, b] = await Promise.all([
    cell.getOrInit(() => ({ port: 8080 })),
    cell.getOrInit(() => ({ port: 9999 })),
  ]);

  assertEquals(a, { port: 8080 });
  assertEquals(b, { port: 8080 });
  assertEquals(cell.get(), { port: 8080 });
});

Deno.test("Barrier releases all parties together, one leader", async () => {
  const barrier = new Barrier(3);

  const results = await Promise.all([0, 1, 2].map(async (i) => {
    await delay(i * 10);
    return await barrier.wait();
  }));

  assertEquals(results.filter(Boolean).length, 1);
});
