/**
 * Minimal structured logger: one JSON object per line on stdout/stderr.
 * bigints are serialized as decimal strings.
 */

export type LogFields = Record<string, unknown>;

export interface Logger {
  info(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
}

function replacer(_key: string, value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      cause: value.cause instanceof Error ? value.cause.message : value.cause
    };
  }
  return value;
}

function line(level: "info" | "error", event: string, fields?: LogFields): string {
  return JSON.stringify(
    { ts: new Date().toISOString(), level, event, ...fields },
    replacer
  );
}

export function createLogger(): Logger {
  return {
    info: (event, fields) => {
      process.stdout.write(`${line("info", event, fields)}\n`);
    },
    error: (event, fields) => {
      process.stderr.write(`${line("error", event, fields)}\n`);
    }
  };
}
