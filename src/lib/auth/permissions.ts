/**
 * Roles and permissions. This matrix is code (tested in scripts/check-enterprise.ts)
 * because it defines *what kind of thing* a role may do. *How far* a role may
 * discount is commercial policy and lives in PricingPolicy.authorityJson.
 */
export const ROLES = [
  "SALES_REP",
  "REGIONAL_MANAGER",
  "CONTRACTING_MANAGER",
  "PRICING_ANALYST",
  "PRICING_DIRECTOR",
  "PRICING_COMMITTEE",
  "PRODUCT_MARKETING",
  "CLINICAL_REVIEWER",
  "FINANCE",
  "ADMIN",
  "EXECUTIVE",
] as const;
export type Role = (typeof ROLES)[number];

export const PERMISSIONS = [
  "view_pricing",
  "edit_proposed_pricing",
  "edit_contract_pricing",
  "view_cost",
  "view_margin",
  "approve_discount",
  "approve_below_floor",
  "manage_crosswalk",
  "publish_crosswalk",
  "review_crosswalk_clinical",
  "manage_contracts",
  "import_competitor_pricing",
  "verify_competitor_pricing",
  "export_proposals",
  "configure_pricing_rules",
  "manage_users",
  "view_analytics",
  "record_outcomes",
  "import_purchases",
  "run_cross_reference",
  "manage_catalog",
  "import_cost_data",
  "configure_settings",
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const ALL: Permission[] = [...PERMISSIONS];

export const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  SALES_REP: ["view_pricing", "edit_proposed_pricing", "import_competitor_pricing", "export_proposals", "record_outcomes", "run_cross_reference"],
  REGIONAL_MANAGER: ["view_pricing", "edit_proposed_pricing", "view_margin", "approve_discount", "import_competitor_pricing", "export_proposals", "record_outcomes", "view_analytics", "run_cross_reference"],
  CONTRACTING_MANAGER: ["view_pricing", "edit_proposed_pricing", "edit_contract_pricing", "view_margin", "manage_contracts", "approve_discount", "export_proposals", "record_outcomes", "import_purchases", "view_analytics", "run_cross_reference", "manage_catalog"],
  PRICING_ANALYST: ["view_pricing", "edit_proposed_pricing", "view_cost", "view_margin", "import_competitor_pricing", "verify_competitor_pricing", "view_analytics", "run_cross_reference", "manage_catalog", "import_cost_data"],
  PRICING_DIRECTOR: ["view_pricing", "edit_proposed_pricing", "edit_contract_pricing", "view_cost", "view_margin", "approve_discount", "approve_below_floor", "manage_contracts", "import_competitor_pricing", "verify_competitor_pricing", "export_proposals", "configure_pricing_rules", "view_analytics", "record_outcomes", "run_cross_reference", "import_cost_data", "configure_settings"],
  PRICING_COMMITTEE: ["view_pricing", "view_cost", "view_margin", "approve_discount", "approve_below_floor", "view_analytics"],
  PRODUCT_MARKETING: ["view_pricing", "manage_crosswalk", "publish_crosswalk", "view_analytics", "run_cross_reference", "manage_catalog"],
  CLINICAL_REVIEWER: ["manage_crosswalk", "review_crosswalk_clinical"],
  FINANCE: ["view_pricing", "view_cost", "view_margin", "view_analytics", "import_purchases", "import_cost_data"],
  ADMIN: ALL,
  EXECUTIVE: ["view_pricing", "view_margin", "view_analytics"],
};

/**
 * Readers of the crosswalk governance data (GET /api/crosses, /api/crosswalk/versions): any of
 * these. CLINICAL_REVIEWER holds no view_pricing, and the rows carry no prices.
 */
export const CROSSWALK_READ: readonly Permission[] = ["view_pricing", "manage_crosswalk", "review_crosswalk_clinical"];

/** Approval authority order — a role can decide anything a lower role could. */
export const AUTHORITY_ORDER: Role[] = ["SALES_REP", "REGIONAL_MANAGER", "CONTRACTING_MANAGER", "PRICING_DIRECTOR", "PRICING_COMMITTEE"];

export function authorityRank(role: string): number {
  const i = AUTHORITY_ORDER.indexOf(role as Role);
  return i < 0 ? -1 : i;
}

export function permissionsFor(roles: string[]): Set<Permission> {
  const out = new Set<Permission>();
  for (const r of roles) for (const p of ROLE_PERMISSIONS[r as Role] ?? []) out.add(p);
  return out;
}

/** Highest approval authority among a set of roles (null if none can approve). */
export function highestAuthority(roles: string[]): Role | null {
  let best: Role | null = null;
  for (const r of roles) {
    const rank = authorityRank(r);
    if (rank > (best ? authorityRank(best) : -1)) best = r as Role;
  }
  return best;
}

/** Can `roles` satisfy a requirement for `required`? Admin can, and any equal-or-higher authority can. */
export function satisfiesAuthority(roles: string[], required: string): boolean {
  if (roles.includes("ADMIN")) return true;
  const have = highestAuthority(roles);
  return have !== null && authorityRank(have) >= authorityRank(required);
}
