/** Equivalence levels of a cross — dependency-free so the database constraints can import them. */
export const EQUIVALENCE = ["EXACT", "FUNCTIONAL", "CLOSEST_ALTERNATIVE", "PREMIUM_ALTERNATIVE", "PARTIAL_SUBSTITUTE", "NONE"] as const;
export type Equivalence = (typeof EQUIVALENCE)[number];
