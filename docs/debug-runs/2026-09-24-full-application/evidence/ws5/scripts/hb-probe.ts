import "dotenv/config";
import { prisma } from "../../../../../../src/lib/db";
import { getBoss, stopBoss, JOBS_SCHEMA } from "../../../../../../src/lib/jobs/boss";
async function main() {
  const boss = await getBoss();
  const [{ id }] = await prisma.$queryRawUnsafe<{ id: string }[]>(`INSERT INTO ${JOBS_SCHEMA}.job (name, data, state, retry_limit, retry_delay, expire_seconds, started_on, heartbeat_on, heartbeat_seconds) VALUES ('retention.sweep', '{}'::jsonb, 'active', 1, 1, 3600, now() - interval '10 minutes', now() - interval '300 seconds', 60) RETURNING id`);
  console.log("inserted", id);
  const r = await boss.supervise();
  console.log("supervise →", r);
  console.log(await prisma.$queryRawUnsafe(`SELECT state::text, retry_count, output FROM ${JOBS_SCHEMA}.job WHERE id = $1::uuid`, id));
  await prisma.$executeRawUnsafe(`UPDATE ${JOBS_SCHEMA}.queue SET monitor_claim_on = NULL, monitor_on = NULL WHERE name = 'retention.sweep'`); // the crash sweep is claimed at most once per monitorIntervalSeconds (60 s)
  const r2 = await boss.supervise((await boss.getQueues(["retention.sweep"])) as never);
  console.log("supervise(names) →", r2);
  console.log(await prisma.$queryRawUnsafe(`SELECT state::text, retry_count, output FROM ${JOBS_SCHEMA}.job WHERE id = $1::uuid`, id));
  await prisma.$executeRawUnsafe(`DELETE FROM ${JOBS_SCHEMA}.job WHERE id = $1::uuid`, id);
  await stopBoss(); await prisma.$disconnect();
}
main();
