// /api/health with the database unreachable (DATABASE_URL points at a closed port): must answer 503 "down", quickly.
import "dotenv/config";
process.env.JOBS_WORKER = "inline";
async function main() {
  const { GET } = await import("../../../../../../src/app/api/health/route");
  const t0 = Date.now();
  const res = await GET();
  const body = await res.json();
  console.log(JSON.stringify({ status: res.status, body, ms: Date.now() - t0 }));
  process.exit(0);
}
main();
