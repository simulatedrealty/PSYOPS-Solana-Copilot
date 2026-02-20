import { randomUUID } from "crypto";
import { getImpliedPrice, type MarketData } from "./market";
import { computeSignal, updateRollingPrices, type SignalResult } from "./signal";
import { checkRisk, type RiskResult } from "./risk";
import { buildExplanation } from "./explain";
import { sharedState } from "./state";
import { getConfig } from "./config";
import { getEngine } from "../execution/getEngine";
import { appendReceipt, listReceipts } from "../receipts/store";

export interface Receipt {
  id: string;
  ts: number;
  pair: string;
  side: "BUY" | "SELL";
  mode: "paper";
  notional: number;
  fillPrice: number;
  confidence: number;
  reasons: string[];
  riskChecks: {
    cooldownOK: boolean;
    maxNotionalOK: boolean;
    maxDailyLossOK: boolean;
    slippageOK: boolean;
  };
  memoTxid: string;
  status: "SUCCESS" | "FAILED";
}

export function getReceipts(): Receipt[] {
  return listReceipts(500) as unknown as Receipt[];
}

export function getReceiptById(id: string): Receipt | undefined {
  return (listReceipts(500) as unknown as Receipt[]).find((r) => r.id === id);
}

export async function getMarket(pair: string): Promise<MarketData> {
  const cfg = getConfig();
  return getImpliedPrice(pair, cfg.maxNotional);
}

export function getSignal(pair: string): SignalResult {
  const cfg = getConfig();
  return computeSignal(cfg.breakoutThresholdBps);
}

export function proposeTrade(
  pair: string,
  side: "BUY" | "SELL",
  notional: number,
  market: MarketData
): { risk: RiskResult; explanation: string[] } {
  const cfg = getConfig();
  const risk = checkRisk(notional, market.slippageBps, cfg);
  const signal = getSignal(pair);
  const explanation = buildExplanation(market, signal, risk);
  return { risk, explanation };
}

export async function executeTrade(
  pair: string,
  side: "BUY" | "SELL",
  notional: number,
  confidence: number,
  reasons: string[],
  tag?: string
): Promise<Receipt> {
  const engine = getEngine();
  const cfg = getConfig();

  const execResult = await engine.executeTrade({
    pair,
    side,
    notionalUsd: notional,
    maxSlippagePct: cfg.maxSlippageBps / 100,
    reasons,
    mode: tag || "auto",
  });

  // fillPrice: expressed as quote-token per base-token (e.g. USDC per SOL/ETH)
  const usdcAmount = side === "BUY" ? execResult.inAmount : execResult.outAmount;
  const tokenAmount = side === "BUY" ? execResult.outAmount : execResult.inAmount;
  const fillPrice = tokenAmount > 0 ? usdcAmount / tokenAmount : 0;

  const receiptId = randomUUID().slice(0, 8);

  // Update paper portfolio state
  if (side === "BUY") {
    sharedState.paperUSDC -= notional;
    sharedState.paperPosition += tokenAmount;
  } else {
    sharedState.paperPosition -= tokenAmount;
    sharedState.paperUSDC += notional;
  }

  const currentValue = sharedState.paperPosition * fillPrice + sharedState.paperUSDC;
  sharedState.paperPnL = currentValue - 1000;
  sharedState.lastTradeTs = Date.now();
  sharedState.lastTxHash = execResult.txHash || null;
  sharedState.lastExplorerUrl = execResult.explorerUrl || null;

  if (sharedState.paperPnL < 0) {
    sharedState.dailyLoss = Math.abs(sharedState.paperPnL);
  }

  sharedState.tradeHistory.push({
    ts: new Date().toISOString(),
    side,
    price: fillPrice,
  });

  // Risk check for receipt recording (slippage from engine result)
  const risk = checkRisk(notional, execResult.slippageBps ?? 0, cfg);

  const receipt: Receipt = {
    id: receiptId,
    ts: execResult.ts,
    pair,
    side,
    mode: "paper",
    notional,
    fillPrice,
    confidence,
    reasons,
    riskChecks: risk.checks,
    memoTxid: execResult.txHash || "N/A",
    status: execResult.ok ? "SUCCESS" : "FAILED",
  };

  appendReceipt(receipt);

  return receipt;
}
