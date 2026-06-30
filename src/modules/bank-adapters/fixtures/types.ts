/** Raw transaction row types for bank portal fixtures (PR5B parsers consume these). */

export interface BhdPersonalTransaction {
  date: string; // DD/MM/YYYY
  confirmationNumber: string;
  description: string;
  receipt: string;
  debit: string; // "RD$ 679.51" or ""
  credit: string; // "RD$ 1,450.00" or ""
  balance: string; // "RD$ 7,167.94"
}

export interface BanreservasPersonasTransaction {
  date: string; // DD/MM/YYYY
  description: string;
  reference: string; // pipe-separated IDs
  debit: string; // "-5,000.00" or ""
  credit: string; // "44,000.00" or ""
  balance: string; // "9,639.79"
}

export interface BanreservasEmpresasTransaction {
  date: string; // DD/MM/YY (2-digit year)
  transactionNumber: string;
  description: string;
  debit: string; // "193.15" — no currency prefix
  credit: string; // "0.00" — no currency prefix
  balance: string; // "DOP 4,472.55"
}
