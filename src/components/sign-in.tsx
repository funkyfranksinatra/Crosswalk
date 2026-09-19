import { Empty } from "@/components/ui";

/**
 * Rendered by the root layout instead of any page while nobody is signed in. Pages and API
 * routes still authorise on their own; this keeps server-rendered pages (accounts,
 * contracts, catalog…) from ever running for an anonymous visitor.
 */
export function SignInScreen({ sso }: { sso: "none" | "oidc" | "proxy" }) {
  if (sso === "oidc") {
    return (
      <Empty title="Sign in to use Crosswalk">
        <div className="space-y-3">
          <div>Crosswalk uses your organisation&apos;s single sign-on. Customer pricing, contracts, cost and margin are only shown to signed-in roles.</div>
          <a href="/api/auth/oidc/start" className="btn-primary inline-flex">Sign in with SSO</a>
        </div>
      </Empty>
    );
  }
  return (
    <Empty title="Sign in to use Crosswalk">
      {sso === "proxy" ? "Your SSO session was not recognised. Sign in through your organisation's portal and try again." : "Choose a user under Development sign-in in the sidebar. Customer pricing, contracts, cost and margin are only shown to signed-in roles."}
    </Empty>
  );
}
