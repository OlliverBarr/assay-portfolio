/**
 * Bun sets `import.meta.main === true` when a module is the process
 * entrypoint; the property is absent (undefined) under Node/vitest. Used by
 * CLI scripts to avoid running `main()` when imported by tests.
 */
interface ImportMeta {
  readonly main?: boolean;
}
