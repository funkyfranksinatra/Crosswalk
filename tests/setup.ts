/**
 * Vitest setup. Loads .env (or DOTENV_CONFIG_PATH) so the database-backed suites see
 * DATABASE_URL, and exposes Vitest's `test` to the shared harness so scripts/check*.ts
 * register their cases as Vitest tests.
 */
import "dotenv/config";
import { test } from "vitest";
(globalThis as unknown as { __vitest_harness?: { test: typeof test } }).__vitest_harness = { test };
