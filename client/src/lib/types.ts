export interface RiskChecks {
  cooldownOK: boolean;
  maxNotionalOK: boolean;
  maxDailyLossOK: boolean;
  slippageOK: boolean;
}

export interface Receipt {
  id: string;
  ts: number;
  pair: string;
  side: "BUY" | "SELL";
  mode: "paper" | "live";
  notional: number;
  fillPrice: number;
  confidence: number;
  reasons: string[];
  riskChecks: RiskChecks;
  memoTxid: string;
  status: "SUCCESS" | "FAILED";
}

export interface TradingState {
  running: boolean;
  paperMode: boolean;
  walletAddress: string;
  walletBalance: number | null;
  activeChains: string[];
  solanaWallet: string;
  baseWallet: string;
  pair: string;
  impliedPrice: number | null;
  rollingHigh: number | null;
  rollingLow: number | null;
  signal: "BUY" | "SELL" | "HOLD" | null;
  strength: number | null;
  confidence: number | null;
  reasons: string[];
  riskAllowed: boolean;
  riskChecks: RiskChecks;
  paperPosition: number;
  paperUSDC: number;
  paperPnL: number;
  lastAction: { ts: string; side: string; price: number } | null;
  receipts: Receipt[];
}

export interface TradingConfig {
  pair: string;
  maxNotional: number;
  maxSlippageBps: number;
  cooldownSec: number;
  maxDailyLoss: number;
  breakoutThresholdBps: number;
}
