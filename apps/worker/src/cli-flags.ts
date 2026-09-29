/**
 * Shared CLI flag parsing for the worker's read-only tools (calibrate-sweep,
 * judge-replay, judge-report, calibrate-died). Every parser here used to
 * carry its own copy-pasted `--flag=value` reader, which silently returned
 * undefined for the equally common `--flag value` (space) form: a mistyped
 * or space-form flag fell back to the default with no warning. This module
 * fixes both problems in one place.
 */
import { WorkerConfigError } from "./config.js";

/**
 * Reads a value flag in either `--flag=value` or `--flag value` (space)
 * form. Space form consumes the next token only when it exists and does not
 * itself start with "-". Returns undefined when the flag is absent.
 */
export function readFlag(argv: readonly string[], flag: string): string | undefined {
  const eqPrefix = `--${flag}=`;
  const eqMatch = argv.find((arg) => arg.startsWith(eqPrefix));
  if (eqMatch !== undefined) return eqMatch.slice(eqPrefix.length);

  const bareIndex = argv.indexOf(`--${flag}`);
  if (bareIndex === -1) return undefined;
  const next = argv[bareIndex + 1];
  return next !== undefined && !next.startsWith("-") ? next : undefined;
}

/**
 * Throws WorkerConfigError on any `--token` not in valueFlags nor
 * booleanFlags, and on any bare positional not consumed as a value-flag
 * argument. Makes a mistyped or value-less flag a loud failure instead of a
 * silent default. Walks argv left to right: a `--name=...` token requires
 * name in valueFlags; a bare `--name` in booleanFlags consumes nothing; a
 * bare `--name` in valueFlags consumes the next token as its value, but only
 * when that token exists and does not itself start with "-" (matching
 * readFlag's space-form rule so the two agree on what was consumed).
 */
export function assertKnownFlags(
  argv: readonly string[],
  valueFlags: readonly string[],
  booleanFlags: readonly string[]
): void {
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (!token.startsWith("--")) {
      throw new WorkerConfigError(token, "unexpected positional argument");
    }

    const eqIndex = token.indexOf("=");
    if (eqIndex !== -1) {
      const name = token.slice(2, eqIndex);
      if (!valueFlags.includes(name)) {
        throw new WorkerConfigError(`--${name}`, "unknown flag");
      }
      continue;
    }

    const name = token.slice(2);
    if (booleanFlags.includes(name)) {
      continue;
    }
    if (valueFlags.includes(name)) {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("-")) {
        i += 1;
      }
      continue;
    }
    throw new WorkerConfigError(`--${name}`, "unknown flag");
  }
}
