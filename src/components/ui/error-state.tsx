import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

interface ErrorStateProps {
  title: string;
  description: string;
  retry?: ReactNode;
  className?: string;
}

export function ErrorState({ title, description, retry, className }: ErrorStateProps) {
  return (
    <section
      role="alert"
      className={cn(
        "flex flex-col items-start gap-3 rounded-lg border border-destructive/40 bg-destructive/5 p-6",
        className,
      )}
    >
      <div>
        <h2 className="text-lg font-semibold text-foreground">{title}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{description}</p>
      </div>
      {retry ? <div>{retry}</div> : null}
    </section>
  );
}
