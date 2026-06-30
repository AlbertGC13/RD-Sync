import type { BhdPersonalTransaction } from "./types";

export const BHD_PERSONAL_BANK_CODE = "bhd" as const;
export const BHD_PERSONAL_PORTAL_VARIANT = "personal" as const;

/** PrimeNG p-datatable: Fecha | Nº confirmación | Descripción | Comprobante | Débitos | Créditos | Balance */
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
