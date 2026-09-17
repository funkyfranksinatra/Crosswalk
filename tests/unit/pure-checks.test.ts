/** The cross-reference engine's deterministic checks (scripts/check.ts), as Vitest tests. */
import { describe } from "vitest";
describe("cross-reference engine (pure)", async () => { await import("../../scripts/check"); });
