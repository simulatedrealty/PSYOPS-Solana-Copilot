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

export interface ActiveTokens {
  base: string;  // token being traded (SOL mint or Base ERC20 address)
  quote: string; // quote token (USDC mint or address)
}

export interface SharedState {
  // ── Active chain / pair — rollingPrices must be reset when either changes ──
  activeChain: "solana-devnet" | "base";
  activePair: string;      // display label, e.g. "SOL-USDC" or "VIRTUAL-USDC"
  activeTokens: ActiveTokens;
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

// Solana devnet default mints
const SOL_MINT  = "So11111111111111111111111111111111111111112";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

export const sharedState: SharedState = {
  activeChain: "solana-devnet",
  activePair: "SOL-USDC",
  activeTokens: { base: SOL_MINT, quote: USDC_MINT },
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
