/** The commercial engine's deterministic checks (scripts/check-enterprise.ts), as Vitest tests. */
import { describe } from "vitest";
describe("commercial engine (pure)", async () => { await import("../../scripts/check-enterprise"); });
