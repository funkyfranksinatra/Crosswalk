/** Notification kinds — kept dependency-free so the database constraints can import them. */
export const KINDS = ["RUN_COMPLETE", "RUN_FAILED", "APPROVAL_REQUESTED", "APPROVAL_DECIDED", "PROPOSAL_APPROVED", "CROSS_PROPOSED", "FEED_FAILED", "ALERT", "JOB_FAILED", "BREAK_GLASS"] as const;
export type Kind = (typeof KINDS)[number];
