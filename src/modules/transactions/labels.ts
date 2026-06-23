/**
 * Spanish UI labels for transaction-level enums.
 *
 * Keeping the mapping in a single source of truth means the dashboard pill,
 * the reviewer action buttons, and any future surface agree on the same
 * wording — operators never see two different translations of the same state.
 */

export type { ReviewState } from "./index";
import type { ReviewState } from "./index";

export const REVIEW_STATE_LABELS: Record<ReviewState, string> = {
  new: "Nueva",
  seen: "Vista",
  internally_validated: "Validada internamente",
  needs_review: "Pendiente de revisión",
  ignored: "Ignorada",
};

export function reviewStateLabel(state: ReviewState): string {
  return REVIEW_STATE_LABELS[state];
}
