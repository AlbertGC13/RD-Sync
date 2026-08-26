import type { BanreservasEmpresasTransaction } from "../banreservas-empresas";

/** Synthetic DevExpress grid rows with no customer, account, or credential data. */
export const banreservasEmpresasTransactions: readonly BanreservasEmpresasTransaction[] = [
  { date: "29/06/26", transactionNumber: "TXN-EXAMPLE-001", concept: "PAYMENT RECEIVED", debit: "0.00", credit: "1,250.00", balance: "DOP 9,999.99" },
  { date: "28/06/26", transactionNumber: "   ", concept: "SERVICE CHARGE", debit: "9.75", credit: "0.00", balance: "DOP 9,990.24" },
] as const;
