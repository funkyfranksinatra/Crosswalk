import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Prisma's driver adapter and better-sqlite3 are native; keep them out of the bundler.
  devIndicators: false,
  serverExternalPackages: ["@prisma/client", "@prisma/adapter-libsql", "@libsql/client", "libsql", "exceljs"],
};

export default nextConfig;
