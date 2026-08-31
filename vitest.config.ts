import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    // The suite must never touch the network. Anything that tries is a bug.
    testTimeout: 5_000,
  },
});
