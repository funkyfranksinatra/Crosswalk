import { Empty } from "@/components/ui";

/**
 * Rendered by the root layout instead of any page while nobody is signed in. Pages and API
 * routes still authorise on their own; this keeps server-rendered pages (accounts,
 * contracts, catalog…) from ever running for an anonymous visitor.
 */
export function SignInScreen({ sso }: { sso: boolean }) {
  return (
    <Empty title="Sign in to use Crosswalk">
      {sso ? "Your SSO session was not recognised. Sign in through your organisation's portal and try again." : "Choose a user under Development sign-in in the sidebar. Customer pricing, contracts, cost and margin are only shown to signed-in roles."}
    </Empty>
  );
}
