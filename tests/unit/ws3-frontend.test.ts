/**
 * WS3 (frontend) — pure helpers behind the UI fixes:
 *  - sidebar section grouping (KN-10): headings render only for groups that kept an item,
 *  - the /docs markdown renderer (KN-05): escapes HTML, keeps the allowlisted link forms,
 *  - the docs route allowlist semantics (KN-05): traversal names never map to a file,
 *  - permission wording for disabled controls (KN-09).
 */
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { groupNav, visibleNav, NAV } from "@/components/sidebar";
import { needs } from "@/components/permissions";
import { renderMarkdown } from "@/app/docs/[doc]/markdown";
import { ROLE_PERMISSIONS } from "@/lib/auth/permissions";

describe("sidebar section headings (KN-10)", () => {
  it("declares the Commercial and Reference sections", () => {
    expect(NAV.find((n) => n.href === "/accounts")?.section).toBe("Commercial");
    expect(NAV.find((n) => n.href === "/catalog")?.section).toBe("Reference");
  });
  it("ADMIN sees every item, grouped as unlabelled / Commercial / Reference", () => {
    const g = groupNav(visibleNav(ROLE_PERMISSIONS.ADMIN, ["ADMIN"]));
    expect(g.map((x) => x.section)).toEqual([null, "Commercial", "Reference"]);
    expect(g[1].items.map((i) => i.label)).toEqual(["Accounts", "Contracts", "Competitor pricing", "Public bids", "Analytics"]);
    expect(g[2].items.map((i) => i.label)).toEqual(["Our catalog", "GUDID library", "Crosswalk", "Settings"]);
  });
  it("drops the Commercial heading when every commercial item is filtered out (CLINICAL_REVIEWER)", () => {
    const g = groupNav(visibleNav(ROLE_PERMISSIONS.CLINICAL_REVIEWER));
    expect(g.map((x) => x.section)).toEqual([null, "Reference"]);
    expect(g[0].items.map((i) => i.label)).toEqual(["Overview"]);
  });
  it("keeps a heading when only some of its items survive (SALES_REP has no analytics)", () => {
    const g = groupNav(visibleNav(ROLE_PERMISSIONS.SALES_REP));
    const commercial = g.find((x) => x.section === "Commercial")!;
    expect(commercial.items.map((i) => i.label)).toEqual(["Accounts", "Contracts", "Competitor pricing", "Public bids"]);
  });
  it("never renders an empty group", () => {
    for (const perms of Object.values(ROLE_PERMISSIONS)) for (const g of groupNav(visibleNav(perms))) expect(g.items.length).toBeGreaterThan(0);
  });
});

describe("docs markdown renderer (KN-05)", () => {
  const html = (md: string) => renderToStaticMarkup(createElement("div", null, ...renderMarkdown(md)));
  it("escapes raw HTML instead of injecting it", () => {
    const out = html("Hello <script>alert(1)</script> **bold**");
    expect(out).not.toContain("<script>");
    expect(out).toContain("&lt;script&gt;");
    expect(out).toContain("<strong>bold</strong>");
  });
  it("renders headings one level down (the page already has its h1), code fences and tables", () => {
    const out = html("# Title\n\n## Section\n\n```bash\nnpm run x\n```\n\n| A | B |\n|---|---|\n| 1 | 2 |\n");
    expect(out).toContain("<h2");
    expect(out).toContain("<h3");
    expect(out).toContain("npm run x");
    expect(out).toContain("<table");
    expect(out).toContain("<td>2</td>");
  });
  it("keeps http(s), same-site and anchor links and drops javascript: targets", () => {
    const out = html("[ok](https://example.com) [rel](/settings) [anchor](#x) [bad](javascript:alert(1))");
    expect(out).toContain('href="https://example.com"');
    expect(out).toContain('href="/settings"');
    expect(out).toContain('href="#x"');
    expect(out).not.toContain("javascript:");
    expect(out).toContain("bad"); // the text survives as plain text
  });
  it("renders ordered and unordered lists and block quotes", () => {
    const out = html("- one\n- two\n\n1. first\n2. second\n\n> note");
    expect(out).toContain("<ul");
    expect(out).toContain("<ol");
    expect(out).toContain("<blockquote");
  });
});

describe("docs route allowlist (KN-05)", () => {
  // The route resolves the URL segment only as a key of a fixed map; these names must never match.
  const DOCS: Record<string, string> = { "INTEGRATIONS.md": "INTEGRATIONS.md", "INTEGRATION_SETUP.md": "INTEGRATION_SETUP.md" };
  const lookup = (seg: string) => (Object.prototype.hasOwnProperty.call(DOCS, seg) ? DOCS[seg] : null);
  it("serves only the two allowlisted documents", () => {
    expect(lookup("INTEGRATIONS.md")).toBe("INTEGRATIONS.md");
    expect(lookup("INTEGRATION_SETUP.md")).toBe("INTEGRATION_SETUP.md");
  });
  it("refuses traversal, prototype and near-miss names", () => {
    for (const bad of ["../.env", "..%2F.env", "%2e%2e/.env", "BUILD_NOTES.md", "integrations.md", "__proto__", "constructor", "toString", "/etc/passwd", "INTEGRATIONS.md/../DATA_ACCESS_POLICY.md"]) expect(lookup(bad)).toBeNull();
  });
});

describe("permission wording (KN-09)", () => {
  it("names the permission in plain words", () => {
    expect(needs("manage_contracts")).toBe("Needs the manage contracts permission");
    expect(needs("verify_competitor_pricing")).toBe("Needs the verify competitor pricing permission");
  });
});
