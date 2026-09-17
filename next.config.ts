import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Prisma driver adapters and pg are server-only; keep them out of the bundler.
  devIndicators: false,
  serverExternalPackages: ["@prisma/client", "@prisma/adapter-pg", "@prisma/adapter-neon", "@neondatabase/serverless", "pg", "ws", "exceljs", "pdfkit", "pg-boss", "nodemailer"],
  poweredByHeader: false,
  async headers() {
    return [{
      source: "/(.*)",
      headers: [
        { key: "X-Content-Type-Options", value: "nosniff" },
        { key: "X-Frame-Options", value: "DENY" },
        { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        // Pricing, cost and contract data must never be cached by a shared proxy.
        { key: "Cache-Control", value: "private, no-store" },
      ],
    }];
  },
};

export default nextConfig;
