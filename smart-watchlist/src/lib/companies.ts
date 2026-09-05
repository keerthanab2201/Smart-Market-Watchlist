const DIRECTORY: Record<string, string> = {
  AAPL: "Apple", NVDA: "NVIDIA", TSLA: "Tesla", MSFT: "Microsoft",
  AMZN: "Amazon", META: "Meta Platforms", GOOGL: "Alphabet", AMD: "AMD",
  NFLX: "Netflix", COIN: "Coinbase", PLTR: "Palantir", GME: "GameStop",
  AMC: "AMC Entertainment", RELIANCE: "Reliance Industries", TCS: "Tata Consultancy",
  INFY: "Infosys", HDFCBANK: "HDFC Bank", SBIN: "State Bank of India",
  NIFTYBEES: "Nippon Nifty Bees ETF", AVGO: "Broadcom", TSM: "TSMC",
  JPM: "JPMorgan Chase", V: "Visa", WMT: "Walmart", DIS: "Disney",
  PYPL: "PayPal", SQ: "Block", SHOP: "Shopify", UBER: "Uber",
  ABNB: "Airbnb", MRNA: "Moderna", PFE: "Pfizer", KO: "Coca-Cola",
  TATAMOTORS: "Tata Motors", TITAN: "Titan Company", AXISBANK: "Axis Bank",
  ICICIBANK: "ICICI Bank", SBINSE: "State Bank of India", MARUTI: "Maruti Suzuki",
  DEMO: "Demo Company (simulated)",
};

const EXCHANGE: Record<string, string> = {
  AAPL: "NASDAQ", NVDA: "NASDAQ", TSLA: "NASDAQ", MSFT: "NASDAQ",
  AMZN: "NASDAQ", META: "NASDAQ", GOOGL: "NASDAQ", AMD: "NASDAQ",
  NFLX: "NASDAQ", COIN: "NASDAQ", PLTR: "NASDAQ", GME: "NYSE",
  AMC: "NYSE", AVGO: "NASDAQ", TSM: "NYSE", JPM: "NYSE",
  V: "NYSE", WMT: "NYSE", DIS: "NYSE", PYPL: "NASDAQ",
  SQ: "NYSE", SHOP: "NYSE", UBER: "NYSE", ABNB: "NASDAQ",
  MRNA: "NASDAQ", PFE: "NYSE", KO: "NYSE",
  RELIANCE: "NSE", TCS: "NSE", INFY: "NSE", HDFCBANK: "NSE",
  SBIN: "NSE", SBINSE: "NSE", NIFTYBEES: "NSE", TATAMOTORS: "NSE",
  TITAN: "NSE", AXISBANK: "NSE", ICICIBANK: "NSE", MARUTI: "NSE",
  DEMO: "SIM",
};

export function exchangeFor(symbol: string): string | null {
  return EXCHANGE[symbol.toUpperCase()] ?? null;
}

export function companyName(symbol: string): string | null {
  return DIRECTORY[symbol.toUpperCase()] ?? null;
}

const INR_SYMBOLS = new Set([
  "RELIANCE", "TCS", "INFY", "HDFCBANK", "SBIN", "SBINSE", "NIFTYBEES",
  "TATAMOTORS", "TITAN", "AXISBANK", "ICICIBANK", "MARUTI",
]);

export type Currency = "USD" | "INR";

export function currencyFor(symbol: string): Currency {
  return INR_SYMBOLS.has(symbol.toUpperCase()) ? "INR" : "USD";
}

export function searchSymbols(q: string, limit = 6): { symbol: string; name: string | null; exchange: string | null }[] {
  const needle = q.trim().toUpperCase();
  if (!needle) return [];
  const starts: string[] = [];
  const contains: string[] = [];
  for (const sym of Object.keys(DIRECTORY)) {
    if (sym.startsWith(needle)) starts.push(sym);
    else if (sym.includes(needle) || (DIRECTORY[sym].toUpperCase().includes(needle) && needle.length >= 2)) contains.push(sym);
  }
  return [...starts, ...contains].slice(0, limit).map((symbol) => ({ symbol, name: DIRECTORY[symbol], exchange: exchangeFor(symbol) }));
}
