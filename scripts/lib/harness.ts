/**
 * One `test()` for the pure check suites, whichever way they are run:
 *   - `npx tsx scripts/check.ts`       — the hand-rolled runner (prints a summary, exits 1 on failure)
 *   - `npx vitest`                     — the same cases as Vitest tests (tests/unit/*.test.ts import the scripts)
 * Under Vitest the summary/exit at the bottom of each script is a no-op.
 */
type Fn = () => void | Promise<void>;
type VitestLike = { test: (name: string, fn: Fn) => void };

const vitest: VitestLike | null = process.env.VITEST ? ((globalThis as unknown as { __vitest_harness?: VitestLike }).__vitest_harness ?? null) : null;

let passed = 0;
const failures: string[] = [];

export function test(name: string, fn: Fn) {
  if (vitest) { vitest.test(name, fn); return; }
  try {
    const r = fn();
    if (r && typeof (r as Promise<void>).then === "function") { pending.push((r as Promise<void>).then(() => { passed++; }, (e) => { failures.push(`${name}\n    ${e instanceof Error ? e.message : String(e)}`); })); return; }
    passed++;
  } catch (e) {
    failures.push(`${name}\n    ${e instanceof Error ? e.message : String(e)}`);
  }
}

const pending: Promise<void>[] = [];

/** Print the summary and set the exit code (no-op under Vitest). */
export async function report() {
  if (vitest) return;
  await Promise.all(pending);
  console.log(`${passed} passed, ${failures.length} failed`);
  for (const f of failures) console.log(`  ✗ ${f}`);
  if (failures.length) process.exit(1);
}
