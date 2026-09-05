export type Logger = ((msg: string, ...args: unknown[]) => void) & {
  info: (msg: string, ...args: unknown[]) => void;
  warn: (msg: string, ...args: unknown[]) => void;
  error: (msg: string, ...args: unknown[]) => void;
};

// info goes to stdout; warn and error go to stderr so container log tooling can
// separate genuine problems from routine noise. Every line carries its level.
export const makeLog = (scope: string): Logger => {
  const emit =
    (sink: (msg: string, ...args: unknown[]) => void, level: string) =>
    (msg: string, ...args: unknown[]): void =>
      sink(`${new Date().toISOString()} soloist.${scope} ${level} ${msg}`, ...args);
  const log = emit(console.log, "info") as Logger;
  log.info = log;
  log.warn = emit(console.error, "warn");
  log.error = emit(console.error, "error");
  return log;
};
