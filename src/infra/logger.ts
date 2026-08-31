import { pino } from "pino";

/** Narrow surface so tests can stub without pulling pino in. */
export interface Logger {
  debug(obj: unknown, msg?: string): void;
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
  child(bindings: Record<string, unknown>): Logger;
}

export function createLogger(level: string, pretty: boolean): Logger {
  return pino({
    level,
    ...(pretty
      ? { transport: { target: "pino-pretty", options: { translateTime: "HH:MM:ss", ignore: "pid,hostname" } } }
      : {}),
  }) as unknown as Logger;
}

/** Collects nothing. For tests and the CLI's quiet mode. */
export function silentLogger(): Logger {
  const noop = () => {};
  const self: Logger = { debug: noop, info: noop, warn: noop, error: noop, child: () => self };
  return self;
}
