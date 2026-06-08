"use client";

import { toast } from "sonner";

import { Button } from "../ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../ui/tooltip";
import { notImplemented } from "../../app/(private)/transactions/_actions/not-implemented";
import type { ScrapeRunStatus } from "../../worker/queues";

interface RunActionAffordancesProps {
  runId: string;
  status: ScrapeRunStatus;
}

/**
 * FR-012 run action affordances for admin scrape runs.
 *
 * Per the design contract, these are honest stubs in this change:
 * - All three actions (Retry, Disable, Renew) are visible to admins.
 * - Each is disabled with a Radix Tooltip explaining the deferral.
 * - On click, each calls `notImplemented` with a specific feature tag and
 *   the Sonner toast confirms the deferral to the admin.
 * - No state changes; the run row's status badge and counts do not move.
 *
 * The real implementation lands with Hito 2 (real bank connection), at
 * which point the `disabled` flags and the toast handler are removed.
 */
export function RunActionAffordances({ runId, status }: RunActionAffordancesProps) {
  function handleClick(feature: "retry" | "disable" | "renew") {
    void (async () => {
      const result = await notImplemented({ feature });
      if (!result.ok) {
        toast.error(result.message);
        return;
      }
      toast.success(`Run ${runId} ${feature}`);
    })();
  }

  return (
    <TooltipProvider delayDuration={150}>
      <div
        className="flex flex-wrap gap-2 border-t border-border pt-3"
        role="group"
        aria-label="Run actions (forthcoming)"
      >
        <ActionButton
          label="Retry run"
          tooltip="Available in Hito 2"
          onClick={() => handleClick("retry")}
          data-action="retry"
        />
        <ActionButton
          label="Disable connection"
          tooltip="Available in Hito 2"
          onClick={() => handleClick("disable")}
          data-action="disable"
        />
        <ActionButton
          label="Renew session"
          tooltip="Available in Hito 2"
          onClick={() => handleClick("renew")}
          data-action="renew"
        />
        <span className="ml-auto text-xs text-muted-foreground" aria-live="polite">
          Current status: {status.replace(/_/g, " ")}
        </span>
      </div>
    </TooltipProvider>
  );
}

interface ActionButtonProps {
  label: string;
  tooltip: string;
  onClick: () => void;
  "data-action": string;
}

function ActionButton({ label, tooltip, onClick, ...rest }: ActionButtonProps) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled
          aria-disabled="true"
          onClick={onClick}
          className="opacity-60"
          {...rest}
        >
          {label}
        </Button>
      </TooltipTrigger>
      <TooltipContent>
        <p>{tooltip}</p>
      </TooltipContent>
    </Tooltip>
  );
}
