export interface UniswapRiskChecks {
  cooldownOK: boolean;
  maxNotionalOK: boolean;
  maxDailyLossOK: boolean;
  gasPriceOK: boolean;
}

export interface UniswapState {
  running: boolean;
  lastImpliedPrice: number | null;
  lastGasPriceGwei: number | null;
  rollingPrices: number[];
  lastSignal: "BUY" | "SELL" | "HOLD" | null;
  lastStrength: number | null;
  lastConfidence: number | null;
  lastReasons: string[];
  lastRiskAllowed: boolean;
  lastRiskChecks: UniswapRiskChecks;
  paperPosition: number; // ETH
  paperUSDC: number;
  paperPnL: number;
  lastTradeTs: number;
  dailyLoss: number;
  tradeHistory: { ts: string; side: "BUY" | "SELL"; price: number }[];
}

export const uniswapState: UniswapState = {
  running: false,
  lastImpliedPrice: null,
  lastGasPriceGwei: null,
  rollingPrices: [],
  lastSignal: null,
  lastStrength: null,
  lastConfidence: null,
  lastReasons: [],
  lastRiskAllowed: false,
  lastRiskChecks: {
    cooldownOK: true,
    maxNotionalOK: true,
    maxDailyLossOK: true,
    gasPriceOK: true,
  },
  paperPosition: 0,
  paperUSDC: 1000,
  paperPnL: 0,
  lastTradeTs: 0,
  dailyLoss: 0,
  tradeHistory: [],
};
