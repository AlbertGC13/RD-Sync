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
 * Retry is wired to the PR4 Run Now endpoint. Disable and Renew remain
 * honest stubs until session management lands.
 */
export function RunActionAffordances({ runId, status }: RunActionAffordancesProps) {
  function handleDeferredClick(feature: "disable" | "renew") {
    void (async () => {
      const result = await notImplemented({ feature });
      if (!result.ok) {
        toast.error(result.message);
        return;
      }
      toast.success(`Run ${runId} ${feature}`);
    })();
  }

  function handleRetryClick() {
    void (async () => {
      const response = await fetch(buildRunNowEndpoint(globalThis.location?.search), {
        method: "POST",
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        toast.error(body.error ?? "Unable to schedule run");
        return;
      }

      toast.success("Queued a new Banco Popular ingestion run. Refresh to see it in history.");
    })();
  }

  return (
    <TooltipProvider delayDuration={150}>
      <div
        className="flex flex-wrap gap-2 border-t border-border pt-3"
        role="group"
        aria-label="Run actions"
      >
        <ActionButton
          label="Retry run"
          tooltip="Schedule a new ingestion run now"
          onClick={handleRetryClick}
          aria-label="Schedule a new ingestion run now"
          data-action="retry"
        />
        <ActionButton
          label="Disable connection"
          tooltip="Available after session management is wired"
          onClick={() => handleDeferredClick("disable")}
          disabled
          aria-disabled="true"
          data-action="disable"
        />
        <ActionButton
          label="Renew session"
          tooltip="Available after session management is wired"
          onClick={() => handleDeferredClick("renew")}
          disabled
          aria-disabled="true"
          data-action="renew"
        />
        <span className="ml-auto text-xs text-muted-foreground" aria-live="polite">
          Current status: {status.replace(/_/g, " ")}
        </span>
      </div>
    </TooltipProvider>
  );
}

export function buildRunNowEndpoint(search: string | undefined): string {
  const searchParams = new URLSearchParams(search ?? "");
  return searchParams.get("previewRole") === "admin"
    ? "/api/scrape-runs/run-now?previewRole=admin"
    : "/api/scrape-runs/run-now";
}

interface ActionButtonProps {
  label: string;
  tooltip: string;
  onClick: () => void;
  disabled?: boolean;
  "aria-disabled"?: "true";
  "aria-label"?: string;
  "data-action": string;
}

function ActionButton({ label, tooltip, onClick, disabled, ...rest }: ActionButtonProps) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled}
          onClick={onClick}
          className={disabled ? "opacity-60" : undefined}
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
