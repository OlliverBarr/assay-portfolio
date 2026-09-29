import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: [
      "tests/**/*.test.ts",
      "src/**/*.test.ts",
      "packages/**/*.test.ts",
      "apps/**/*.test.ts"
    ],
    setupFiles: ["tests/setup.ts"],
    passWithNoTests: false
  }
});
