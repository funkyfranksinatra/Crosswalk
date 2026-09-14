import type { Metadata } from "next";
import "./globals.css";
import { Sidebar } from "@/components/sidebar";
import { getSettings } from "@/lib/settings";
import { llmConfig } from "@/lib/llm/client";

export const metadata: Metadata = {
  title: "Crosswalk — Competitor Product Cross Reference Engine",
  description: "Cross-reference competitor purchases to your catalog and build a competitive bid.",
};

export const dynamic = "force-dynamic";

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const settings = await getSettings();
  const llm = llmConfig();
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full flex">
        <Sidebar companyName={settings.companyName} llm={{ available: llm.available, model: llm.model }} />
        <main className="flex-1 min-w-0 min-h-screen">
          <div className="mx-auto max-w-[1440px] px-8 py-7">{children}</div>
        </main>
      </body>
    </html>
  );
}
