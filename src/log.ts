export const makeLog =
  (scope: string) =>
  (msg: string, ...args: unknown[]): void =>
    console.log(`${new Date().toISOString()} soloist.${scope} ${msg}`, ...args);
