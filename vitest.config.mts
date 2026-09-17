import { defineConfig } from "vitest/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    setupFiles: ["tests/setup.ts"],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    // Database-backed suites share one Prisma client and fixtures; run files one at a time.
    fileParallelism: false,
    env: { LOG_SILENT: "true", JOBS_WORKER: "off", NOTIFY_DRY_RUN: "true" },
  },
  resolve: { alias: { "@": path.resolve(here, "src") } },
});
