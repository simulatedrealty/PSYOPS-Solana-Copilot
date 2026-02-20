import { initAgentKit, getAgentPublicKey } from "./agentKit";

initAgentKit();

export function getKeypair() {
  return initAgentKit().wallet;
}

export function getPubkey(): string {
  return getAgentPublicKey();
}

export function getConnection() {
  return initAgentKit().connection;
}

export interface TradeAction {
  ts: string;
  side: "BUY" | "SELL";
  price: number;
}

export interface SharedState {
  rollingPrices: number[];
  running: boolean;
  paperMode: boolean;
  paperPosition: number;
  paperUSDC: number;
  paperPnL: number;
  tradeHistory: TradeAction[];
  lastTradeTs: number;
  dailyLoss: number;
  dailyLossResetTs: number;
  lastSignal: "BUY" | "SELL" | "HOLD" | null;
  lastStrength: number | null;
  lastConfidence: number | null;
  lastReasons: string[];
  lastImpliedPrice: number | null;
  lastRiskAllowed: boolean;
  lastRiskChecks: {
    cooldownOK: boolean;
    maxNotionalOK: boolean;
    maxDailyLossOK: boolean;
    slippageOK: boolean;
  };
  lastTxHash: string | null;
  lastExplorerUrl: string | null;
}

export const sharedState: SharedState = {
  rollingPrices: [],
  running: false,
  paperMode: true,
  paperPosition: 0,
  paperUSDC: 1000,
  paperPnL: 0,
  tradeHistory: [],
  lastTradeTs: 0,
  dailyLoss: 0,
  dailyLossResetTs: Date.now(),
  lastSignal: null,
  lastStrength: null,
  lastConfidence: null,
  lastReasons: [],
  lastImpliedPrice: null,
  lastRiskAllowed: true,
  lastRiskChecks: {
    cooldownOK: true,
    maxNotionalOK: true,
    maxDailyLossOK: true,
    slippageOK: true,
  },
  lastTxHash: null,
  lastExplorerUrl: null,
};
