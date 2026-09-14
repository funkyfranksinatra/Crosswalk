import path from "node:path";
import { PrismaClient } from "@/generated/prisma/client";
import { PrismaLibSql } from "@prisma/adapter-libsql";

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

function resolveUrl() {
  const url = process.env.DATABASE_URL ?? "file:./prisma/dev.db";
  // Prisma's sqlite adapter wants an absolute-ish path; resolve "file:./x"
  // against the project root so it works no matter the cwd of the process.
  if (url.startsWith("file:") && !path.isAbsolute(url.slice(5))) {
    // Forward slashes work on every platform, including Windows drive paths ("file:C:/…/dev.db").
    // turbopackIgnore: this is a runtime path for the SQLite file, not a module to trace.
    return `file:${path.resolve(/* turbopackIgnore: true */ process.cwd(), url.slice(5)).replace(/\\/g, "/")}`;
  }
  return url;
}

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    // libSQL ships prebuilt binaries for Windows/macOS/Linux as npm packages — no native compile step on demo machines.
    adapter: new PrismaLibSql({ url: resolveUrl() }),
    log: process.env.PRISMA_LOG ? ["query", "warn", "error"] : ["warn", "error"],
  });

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;

export type Db = typeof prisma;
