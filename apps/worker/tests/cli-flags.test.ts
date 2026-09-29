import { describe, expect, it } from "vitest";

import { assertKnownFlags, readFlag } from "../src/cli-flags.js";

describe("readFlag", () => {
  it("reads --flag=value form", () => {
    expect(readFlag(["--floor=85"], "floor")).toBe("85");
  });

  it("reads --flag value (space) form", () => {
    expect(readFlag(["--floor", "85"], "floor")).toBe("85");
  });

  it("returns undefined when the flag is absent", () => {
    expect(readFlag(["--other=1"], "floor")).toBeUndefined();
  });

  it("does not consume a following token that starts with -", () => {
    expect(readFlag(["--floor", "--other"], "floor")).toBeUndefined();
  });

  it("returns undefined when the space form has no following token", () => {
    expect(readFlag(["--floor"], "floor")).toBeUndefined();
  });
});

describe("assertKnownFlags", () => {
  it("passes for a known value flag in --flag=value form", () => {
    expect(() => assertKnownFlags(["--floor=85"], ["floor"], [])).not.toThrow();
  });

  it("passes for a known value flag in --flag value (space) form", () => {
    expect(() => assertKnownFlags(["--floor", "85"], ["floor"], [])).not.toThrow();
  });

  it("passes for a known boolean flag", () => {
    expect(() => assertKnownFlags(["--dry-run"], [], ["dry-run"])).not.toThrow();
  });

  it("throws on an unknown flag", () => {
    expect(() => assertKnownFlags(["--flor", "85"], ["floor"], [])).toThrow();
  });

  it("throws on a stray bare positional", () => {
    expect(() => assertKnownFlags(["85"], ["floor"], [])).toThrow();
  });
});
