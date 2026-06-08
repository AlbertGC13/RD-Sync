"use server";

/**
 * Server action used by stub affordances across the dashboard.
 *
 * Returns `{ ok: false, reason: "not_implemented" }` with an explicit
 * user-facing message. The client surfaces this as a Sonner toast and
 * MUST NOT change any application state. The component is also visually
 * disabled with a Tooltip explaining the deferral, so the toast is a
 * second line of defence — if a curious admin somehow bypasses the
 * disabled attribute, the action still tells them clearly that nothing
 * happened.
 *
 * Real implementations (PATCH /api/transactions/[id]/review, run
 * retry/disable/renew) will replace each call site; this contract stays
 * the single source of truth for the "not yet implemented" pattern.
 */

export type NotImplementedFeature = "review" | "retry" | "disable" | "renew";

const MESSAGES: Record<NotImplementedFeature, string> = {
  review: "Review actions are available in an upcoming change.",
  retry: "Run retry is available in Hito 2.",
  disable: "Disable connection is available in Hito 2.",
  renew: "Session renewal is available in Hito 2.",
};

export type NotImplementedResult =
  | { ok: true; feature: NotImplementedFeature }
  | { ok: false; reason: "not_implemented"; feature: NotImplementedFeature; message: string };

export async function notImplemented(input: {
  feature: NotImplementedFeature;
}): Promise<NotImplementedResult> {
  // Defensive: the action must never throw, never log secrets, and never
  // mutate state. If a future change accidentally wires a real path here,
  // the test suite will fail loudly because the message includes
  // "not_implemented".
  return {
    ok: false,
    reason: "not_implemented",
    feature: input.feature,
    message: MESSAGES[input.feature],
  };
}
