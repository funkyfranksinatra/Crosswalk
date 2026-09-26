import type { Metadata } from "next";
import "./globals.css";
import { Sidebar } from "@/components/sidebar";
import { PermissionsProvider } from "@/components/permissions";
import { getSettings } from "@/lib/settings";
import { llmConfig } from "@/lib/ai/gateway";
import { getActor } from "@/lib/auth";
import { ssoMode } from "@/lib/auth/oidc";
import { SignInScreen } from "@/components/sign-in";

export const metadata: Metadata = {
  title: "Crosswalk — Competitor Product Cross Reference Engine",
  description: "Cross-reference competitor purchases to your catalog and build a competitive bid.",
};

export const dynamic = "force-dynamic";

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const settings = await getSettings();
  const llm = llmConfig();
  const actor = await getActor();
  const actorInfo = actor ? { id: actor.id, name: actor.name, email: actor.email, roles: actor.roles, permissions: [...actor.permissions], isDev: actor.isDev } : null;
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full flex flex-col md:flex-row">
        <a href="#main" className="skip-link">Skip to content</a>
        <Sidebar companyName={settings.companyName} llm={{ available: llm.available, model: llm.model }} sso={ssoMode()} actor={actorInfo} />
        <main id="main" tabIndex={-1} className="flex-1 min-w-0 min-h-screen outline-none">
          <div className="mx-auto max-w-[1440px] px-4 py-5 md:px-8 md:py-7">
            <PermissionsProvider actor={actorInfo ? { id: actorInfo.id, name: actorInfo.name, roles: actorInfo.roles, permissions: actorInfo.permissions } : null}>
              {actor ? children : <SignInScreen sso={ssoMode()} />}
            </PermissionsProvider>
          </div>
        </main>
      </body>
    </html>
  );
}
