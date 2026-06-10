import { Global, Semaphore } from "experimental-threads";

// No worker needed: two Globals created at the same call site (helper / loop)
function makeCounter() {
  return new Global(new Semaphore(0));
}

Deno.test("two Globals from the same helper call site are independent", () => {
  const a = makeCounter();
  const b = makeCounter();

  a.value.release(5);

  const bCount = (b.value as any).state[0];
  if (bCount === 5) {
    throw new Error("BUG CONFIRMED: b aliases a's memory (same call-site id)");
  }
});
