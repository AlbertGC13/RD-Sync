import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

interface CardProps extends React.HTMLAttributes<HTMLDivElement> {
  variant?: "default" | "elevated" | "outlined";
}

export function Card({ className, variant = "default", ...props }: CardProps) {
  return (
    <div
      className={cn(
        "rounded-xl border bg-card text-card-foreground",
        variant === "default" && "border-border/80 shadow-sm shadow-black/20",
        variant === "elevated" && "border-border/60 shadow-md shadow-black/30",
        variant === "outlined" && "border-border bg-transparent",
        className,
      )}
      {...props}
    />
  );
}

export function CardHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("flex flex-col gap-1.5 px-5 pt-5", className)} {...props} />;
}

export function CardTitle({ className, ...props }: React.HTMLAttributes<HTMLHeadingElement>) {
  return (
    <h3
      className={cn("text-base font-semibold leading-tight tracking-tight text-foreground", className)}
      {...props}
    />
  );
}

export function CardDescription({
  className,
  ...props
}: React.HTMLAttributes<HTMLParagraphElement>) {
  return <p className={cn("text-sm text-muted-foreground", className)} {...props} />;
}

export function CardContent({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("px-5 py-5", className)} {...props} />;
}

export function CardFooter({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "flex items-center justify-between gap-2 border-t border-border/60 px-5 py-3 text-xs text-muted-foreground",
        className,
      )}
      {...props}
    />
  );
}

export function CardDivider({ children }: { children?: ReactNode }) {
  if (!children) return <div className="border-t border-border/60" />;
  return (
    <div className="flex items-center gap-3 border-t border-border/60 px-5 py-2.5 text-xs font-medium uppercase tracking-wider text-muted-foreground">
      {children}
    </div>
  );
}
