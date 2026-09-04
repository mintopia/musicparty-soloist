// Tiny helpers shared across proxy.ts/auth.ts/relay.ts/web.ts/config.ts with no
// dependencies of their own, so importing them never risks a module cycle.

import { timingSafeEqual } from "node:crypto";

// Constant-time string compare (length-checked first: timingSafeEqual throws on
// mismatched lengths).
export function safeStrEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

// A promise resolvable from outside, swappable for a fresh one — used to park/wake
// reconnect loops (await .promise; someone else calls .resolve()).
export function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}
