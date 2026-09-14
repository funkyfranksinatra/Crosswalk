import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Prisma driver adapters and pg are server-only; keep them out of the bundler.
  devIndicators: false,
  serverExternalPackages: ["@prisma/client", "@prisma/adapter-pg", "@prisma/adapter-neon", "@neondatabase/serverless", "pg", "ws", "exceljs"],
};

export default nextConfig;
