import { Skeleton } from "../../../components/ui/skeleton";

export default function TransactionsLoading() {
  return (
    <div className="grid gap-6">
      <div className="flex items-start justify-between">
        <Skeleton className="motion-safe:animate-pulse h-9 w-56 rounded-md" />
        <Skeleton className="motion-safe:animate-pulse h-7 w-40 rounded-full" />
      </div>
      <Skeleton className="motion-safe:animate-pulse h-11 w-full rounded-xl" />
      <div className="grid gap-4">
        {Array.from({ length: 3 }).map((_, groupIdx) => (
          <div key={groupIdx}>
            <div className="flex items-center gap-3 px-4 py-2">
              <Skeleton className="motion-safe:animate-pulse h-3.5 w-28 rounded" />
              <div className="flex-1 h-px bg-border" />
              <Skeleton className="motion-safe:animate-pulse h-3.5 w-20 rounded" />
            </div>
            <div className="mx-4 rounded-xl border border-border/60 bg-card divide-y divide-border/40 overflow-hidden">
              {Array.from({ length: 3 }).map((_, rowIdx) => (
                <div key={rowIdx} className="flex items-center gap-3.5 px-4 py-3.5">
                  <Skeleton className="motion-safe:animate-pulse h-10 w-10 rounded-[10px] flex-shrink-0" />
                  <div className="flex-1 min-w-0 grid gap-1.5">
                    <Skeleton className="motion-safe:animate-pulse h-4 w-3/5 rounded" />
                    <Skeleton className="motion-safe:animate-pulse h-3 w-2/5 rounded" />
                  </div>
                  <div className="flex-shrink-0 text-right grid gap-1">
                    <Skeleton className="motion-safe:animate-pulse h-4 w-24 rounded ml-auto" />
                    <Skeleton className="motion-safe:animate-pulse h-3 w-10 rounded ml-auto" />
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
