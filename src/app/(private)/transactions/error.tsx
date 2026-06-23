"use client";

import { ErrorState } from "../../../components/ui/error-state";

interface TransactionsErrorProps {
  error: Error & { digest?: string };
  reset: () => void;
}

/**
 * Route-level error boundary for /transactions.
 *
 * Why this component does NOT log `error` to the browser console:
 * - This route is rendered for Dominican banking operators. The raw error
 *   object (and any stack frame / upstream message it carries) is an
 *   internal detail that must never reach the browser console. The same
 *   error is already surfaced server-side via Next.js's own reporting hook,
 *   so the diagnostic trail exists outside the client.
 * - The UI shows a generic, professional Spanish message and a Reintentar
 *   affordance so operators can recover without seeing internals.
 */
export default function TransactionsError({ reset }: TransactionsErrorProps) {
  return (
    <div className="grid gap-6">
      <h1 className="text-2xl font-bold text-foreground">Transacciones recientes</h1>
      <ErrorState
        title="No se pudieron cargar las transacciones"
        description="Ocurrió un error inesperado al obtener los movimientos bancarios. Tus datos están seguros; se trata únicamente de un error de visualización."
        retry={
          <button
            onClick={reset}
            className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-3 py-2 text-sm font-medium text-foreground transition-colors hover:border-primary hover:text-primary"
          >
            Reintentar
          </button>
        }
      />
    </div>
  );
}
