/**
 * Run a command with secrets from the configured provider in its environment:
 *
 *   npx tsx scripts/with-secrets.ts -- npx prisma migrate deploy
 *
 * Used by the container entrypoint so `prisma migrate deploy` sees a DATABASE_URL held in a
 * secret manager. With SECRETS_PROVIDER=env (the default) it is a plain pass-through.
 * `--check` additionally runs the production secret checks and exits non-zero on a problem.
 */
import "dotenv/config";
import { spawn } from "node:child_process";
import { loadSecrets, assertProductionSecrets } from "../src/lib/secrets";

async function main() {
  const args = process.argv.slice(2);
  const check = args[0] === "--check";
  if (check) args.shift();
  const sep = args.indexOf("--");
  const cmd = sep >= 0 ? args.slice(sep + 1) : args;
  await loadSecrets();
  if (check) assertProductionSecrets();
  if (!cmd.length) return;
  const child = spawn(cmd[0], cmd.slice(1), { stdio: "inherit", env: process.env, shell: process.platform === "win32" });
  // A stop during `prisma migrate deploy` must reach prisma, not orphan it mid-migration.
  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(sig, () => { child.kill(sig); });
  child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
}
main().catch((e) => { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); });
