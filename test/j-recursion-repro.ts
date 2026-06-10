// NOT a test — this repro never terminates, so it must not be picked up by
// `deno test`. It demonstrates infinite worker recursion: the worker file
// re-executes this module's top level, which spawns again, forever. Each
// generation suspends at the top-level await before posting 'ready', so no
// task ever completes and `.workers/` fills with one file per generation.
//
// Run manually (the timeout is the only thing that stops it):
//
//   timeout 8 deno run -A test/j-recursion-repro.ts
//
// Expected (buggy) behavior: "result:" never prints, exit code 124.

import { shutdown, spawn } from "experimental-threads";

// Top-level await of a spawn — common pattern in script-style modules.
const r = await eval(spawn(() => 1 + 1));
console.log("result:", r);
shutdown();
