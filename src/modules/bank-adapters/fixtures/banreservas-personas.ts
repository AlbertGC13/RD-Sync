import type { BanreservasPersonasTransaction } from "./types";

export const BANRESERVAS_PERSONAS_BANK_CODE = "banreservas" as const;
export const BANRESERVAS_PERSONAS_PORTAL_VARIANT = "personas" as const;

/** div.rivera_row: date | description | reference | debit | credit | balance */
export const banreservasPersonasTransactions: readonly BanreservasPersonasTransaction[] = [
  {
    date: "29/06/2026",
    description: "TRANSFERENCIA RECIBIDA",
    reference: "# Nro. transacción : 408900123456 | Número de referencia : 408900123",
    debit: "",
    credit: "44,000.00",
    balance: "53,639.79",
  },
  {
    date: "28/06/2026",
    description: "TRANSFERENCIA A COMERCIO DEMO",
    reference: "# Nro. transacción : 408900234567 | Número de referencia : 408900234",
    debit: "-5,000.00",
    credit: "",
    balance: "9,639.79",
  },
] as const;
