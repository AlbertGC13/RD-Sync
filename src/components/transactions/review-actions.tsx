"use client";

import { toast } from "sonner";

import { Button } from "../ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../ui/tooltip";
import { notImplemented } from "../../app/(private)/transactions/_actions/not-implemented";
import { REVIEW_STATE_LABELS, type ReviewState } from "../../modules/transactions/labels";

interface ReviewActionsProps {
  transactionId: string;
  currentState: ReviewState;
}

const REVIEW_STATES: ReviewState[] = [
  "new",
  "seen",
  "internally_validated",
  "ignored",
  "needs_review",
];

/**
 * Reviewer affordances for FR-011.
 *
 * Per the design and spec, these are honest stubs in this change:
 * - Visible only when `reviewerMode` is true (page-level prop).
 * - Disabled with a Radix Tooltip explaining the deferral.
 * - On click, calls `notImplemented("review")` which fires a Sonner toast.
 * - Never fakes success: the state does not change.
 *
 * The change that wires PATCH /api/transactions/[id]/review (Hito 2 follow-up)
 * will replace this component with a real mutation and remove the disabled
 * wrapper.
 */
export function ReviewActions({ transactionId, currentState }: ReviewActionsProps) {
  function handleClick(target: ReviewState) {
    void (async () => {
      const result = await notImplemented({ feature: "review" });
      if (!result.ok) {
        toast.error(result.message);
        return;
      }
      toast.success(`Transacción ${transactionId} marcada como ${REVIEW_STATE_LABELS[target]}`);
    })();
  }

  return (
    <TooltipProvider delayDuration={150}>
      <div className="flex flex-wrap gap-2" role="group" aria-label="Acciones de revisión (próximamente)">
        {REVIEW_STATES.map((state) => (
          <Tooltip key={state}>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled
                aria-disabled="true"
                data-state={state}
                data-current={state === currentState}
                onClick={() => handleClick(state)}
                className="opacity-60"
              >
                {REVIEW_STATE_LABELS[state]}
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              <p>Disponible en un próximo cambio</p>
            </TooltipContent>
          </Tooltip>
        ))}
      </div>
    </TooltipProvider>
  );
}
