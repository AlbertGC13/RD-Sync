import type { BanreservasEmpresasTransaction } from "./types";

export const BANRESERVAS_EMPRESAS_BANK_CODE = "banreservas" as const;
export const BANRESERVAS_EMPRESAS_PORTAL_VARIANT = "empresas" as const;

/** DevExpress grid: Fecha | Nro. Transacción | Concepto | Débitos | Créditos | Balance (DD/MM/YY) */
export const banreservasEmpresasTransactions: readonly BanreservasEmpresasTransaction[] = [
  {
    date: "29/06/26",
    transactionNumber: "942632990001",
    description: "DEPOSITO EN EFECTIVO",
    debit: "0.00",
    credit: "25,000.00",
    balance: "DOP 29,472.55",
  },
  {
    date: "28/06/26",
    transactionNumber: "942632990002",
    description: "COBRO IMP DGII 0.15%_TRANS TUB",
    debit: "193.15",
    credit: "0.00",
    balance: "DOP 4,472.55",
  },
] as const;
