/**
 * GPO roster profiles. Premier, Vizient and HealthTrust each deliver rosters differently
 * (portal exports, SFTP drops, member APIs) and none publishes a stable public schema, so a
 * profile is a starting mapping the company corrects to the columns it actually receives —
 * never a hard-coded assumption. The canonical membership record is the same for all three.
 */
import type { FieldMap, MappingSpec } from "../core/mapping";

export const MEMBERSHIP_SPEC: MappingSpec = { entity: "GpoMembership", fields: [
  { name: "externalMembershipId", type: "string", description: "The GPO's own member / membership id" },
  { name: "accountNumber", type: "string", description: "Our account number for the member (the strongest match key)" },
  { name: "accountExternalId", type: "string", description: "CRM account id when the roster carries it" },
  { name: "memberName", type: "string", required: true, description: "Member facility name (used for matching suggestions)" },
  { name: "addressLine1", type: "string", description: "Street" },
  { name: "city", type: "string", description: "City" },
  { name: "region", type: "string", description: "State / province" },
  { name: "postalCode", type: "string", description: "Postal code" },
  { name: "country", type: "string", description: "Country", example: "US" },
  { name: "tier", type: "string", description: "Membership / pricing tier" },
  { name: "effectiveFrom", type: "date", required: true, description: "Membership start" },
  { name: "effectiveTo", type: "date", description: "Membership end / expiration" },
  { name: "lastVerifiedAt", type: "date", description: "When the GPO last verified the member" },
  { name: "parentMemberName", type: "string", description: "Parent / IDN name, when the roster carries hierarchy" },
] };

export type GpoProfile = { key: "premier" | "vizient" | "healthtrust"; gpoName: string; gpoCode: string; fileMapping: FieldMap; notes: string };

export const GPO_PROFILES: Record<GpoProfile["key"], GpoProfile> = {
  premier: {
    key: "premier", gpoName: "Premier", gpoCode: "PREMIER",
    fileMapping: { externalMembershipId: { source: "Premier Entity Code" }, memberName: { source: "Facility Name" }, accountNumber: { source: "Supplier Customer Number" }, addressLine1: { source: "Address" }, city: { source: "City" }, region: { source: "State" }, postalCode: { source: "Zip" }, tier: { source: "Tier" }, effectiveFrom: { source: "Effective Date", transform: "date" }, effectiveTo: { source: "Expiration Date", transform: "date" }, parentMemberName: { source: "Parent Entity Name" } },
    notes: "Premier member rosters are usually a supplier-portal export per contract; the 'Supplier Customer Number' is your account number when you have loaded it with Premier, otherwise match on name/address.",
  },
  vizient: {
    key: "vizient", gpoName: "Vizient", gpoCode: "VIZIENT",
    fileMapping: { externalMembershipId: { source: "Vizient Member ID" }, memberName: { source: "Member Name" }, accountNumber: { source: "Supplier Account Number" }, addressLine1: { source: "Address 1" }, city: { source: "City" }, region: { source: "State" }, postalCode: { source: "Postal Code" }, tier: { source: "Tier Level" }, effectiveFrom: { source: "Tier Effective Date", transform: "date" }, effectiveTo: { source: "Tier End Date", transform: "date" }, parentMemberName: { source: "Parent Member Name" } },
    notes: "Vizient tier eligibility files are per agreement; the tier column names the price tier the member has committed to.",
  },
  healthtrust: {
    key: "healthtrust", gpoName: "HealthTrust", gpoCode: "HPG",
    fileMapping: { externalMembershipId: { source: "COID" }, memberName: { source: "Facility" }, accountNumber: { source: "Vendor Account Number" }, addressLine1: { source: "Address" }, city: { source: "City" }, region: { source: "ST" }, postalCode: { source: "ZIP" }, tier: { source: "Tier" }, effectiveFrom: { source: "Start Date", transform: "date" }, effectiveTo: { source: "End Date", transform: "date" }, parentMemberName: { source: "Division" } },
    notes: "HealthTrust rosters identify facilities by COID; divisions map to parent accounts.",
  },
};
