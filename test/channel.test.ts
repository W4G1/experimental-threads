import { assertEquals } from "@std/assert";
import { Channel, Shared, shutdown, spawn } from "experimental-threads";

const ch = new Shared(new Channel<number>(1024));
const syncCh = new Shared(new Channel<string>(256));

Deno.test("channel streams values from worker to main", async () => {
  try {
    const producer = eval(spawn(async () => {
      for (let i = 1; i <= 5; i++) await ch.value.send(i * 10);
      ch.value.close();
    }));

    const seen: number[] = [];
    for await (const v of ch.value) seen.push(v);
    await producer;

    assertEquals(seen, [10, 20, 30, 40, 50]);
  } finally {
    shutdown();
  }
});

Deno.test("worker receives with blocking recvSync", async () => {
  try {
    const handle = eval(spawn(() => {
      const a = syncCh.value.recvSync();
      const b = syncCh.value.recvSync();
      return `${a},${b}`;
    }));

    await syncCh.value.send("x");
    await syncCh.value.send("y");

    assertEquals(await handle, "x,y");
  } finally {
    shutdown();
  }
});

Deno.test("trySend/tryRecv do not block", () => {
  const c = new Channel<number>(64);
  assertEquals(c.tryRecv(), undefined);
  assertEquals(c.trySend(1), true);
  assertEquals(c.size, 1);
  assertEquals(c.tryRecv(), 1);
});

Deno.test("select resolves the first ready channel", async () => {
  const a = new Channel<number>(64);
  const b = new Channel<number>(64);

  const winner = Channel.select([a, b]);
  await b.send(7);
  assertEquals(await winner, { index: 1, value: 7 });

  a.close();
  b.close();
  assertEquals(await Channel.select([a, b]), undefined);
});
