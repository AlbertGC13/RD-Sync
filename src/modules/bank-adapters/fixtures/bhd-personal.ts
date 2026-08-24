import type { BhdPersonalTransaction } from "../bhd";

/** Sanitized PrimeNG rows: Fecha | Confirmacion | Descripcion | Comprobante | Debitos | Creditos | Balance. */
export const bhdPersonalTransactions: readonly BhdPersonalTransaction[] = [
  {
    date: "27/06/2026",
    confirmationNumber: "2638001",
    description: "DEPOSITO EN EFECTIVO",
    receipt: "0000000000",
    debit: "",
    credit: "RD$ 15,000.00",
    balance: "RD$ 22,167.94",
  },
  {
    date: "27/06/2026",
    confirmationNumber: "2638002",
    description: "Fondo reservado Visa Db: 20260627",
    receipt: "0000000000",
    debit: "RD$ 679.51",
    credit: "",
    balance: "RD$ 7,167.94",
  },
] as const;
