import { clsx } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * Combine class names with conflict resolution.
 *
 * Wraps `clsx` for conditional class composition and `tailwind-merge` to
 * deduplicate conflicting Tailwind utilities (e.g. `p-2 p-4` collapses to
 * `p-4`). This is the standard shadcn/ui helper.
 */
export function cn(...inputs: Array<string | number | boolean | null | undefined>): string {
  return twMerge(clsx(inputs));
}
