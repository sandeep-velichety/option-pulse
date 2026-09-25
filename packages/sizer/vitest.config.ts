import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
  },
  resolve: {
    // Strip .js extensions so Vitest can find .ts source files
    // (required for NodeNext module resolution in tests)
    alias: [{ find: /^(\.{1,2}\/.+)\.js$/, replacement: "$1" }],
  },
});
