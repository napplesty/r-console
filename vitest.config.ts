import { defineConfig } from "vitest/config";

// Dedicated test config: the main vite.config.ts carries the Tauri dev
// server setup, which vitest does not need.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
