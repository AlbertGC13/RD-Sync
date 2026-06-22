export interface BankMeta {
  id: string;
  name: string;
  color: string;
  logoSrc: string;
}

export const BANKS: Record<string, BankMeta> = {
  popular: {
    id: "popular",
    name: "Banco Popular",
    color: "#00C1D5",
    logoSrc: "/banks/popular.svg",
  },
  bhd: {
    id: "bhd",
    name: "BHD",
    color: "#54AD4D",
    logoSrc: "/banks/bhd.svg",
  },
  banreservas: {
    id: "banreservas",
    name: "Banreservas",
    color: "#264E72",
    logoSrc: "/banks/banreservas.svg",
  },
};

export function getBankMeta(bankId: string): BankMeta {
  return (
    BANKS[bankId] ?? {
      id: bankId,
      name: bankId,
      color: "#525252",
      logoSrc: "/banks/default.svg",
    }
  );
}
