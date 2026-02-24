import { randomUUID } from "crypto";
import { type TradeRequest } from "./types";
import { getEngine } from "./getEngine";
import { appendReceipt } from "../receipts/store";
import { sharedState } from "../engine/state";
import { getConfig } from "../engine/config";
import { checkRisk } from "../engine/risk";

const BASE_REQUIRED_VARS = [
  "BASE_PRIVATE_KEY",
  "BASE_RPC_URL",
  "BASE_PRIMARY_TOKEN",
  "BASE_USDC",
  "BASE_SWAP_ROUTER",
] as const;

function baseConfigured(): boolean {
  return BASE_REQUIRED_VARS.every((v) => !!process.env[v]);
}

export interface TradeReceipt {
  id: string;
  ts: number;
  pair: string;
  side: "BUY" | "SELL";
  mode: string;
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
  chain: string;
  source: string;
  wallet?: string;
}

export type HandlerResult = { error: string } | TradeReceipt;

/**
 * Unified trade handler — all entry points (UI, skill, future ACP) route through here.
 *
 * - Validates chain config before touching any engine
 * - Calls getEngine(chain).executeTrade()
 * - Updates paper portfolio state
 * - Saves receipt to data/receipts.jsonl (with chain + source fields)
 * - Returns the receipt, or { error } on failure (never throws)
 */
export async function handleTrade(request: TradeRequest): Promise<HandlerResult> {
  if (request.chain === "base" && !baseConfigured()) {
    return {
      error: `Base chain not configured. Required: ${BASE_REQUIRED_VARS.join(", ")}`,
    };
  }

  const engine = getEngine(request.chain);
  const cfg = getConfig();

  // Resolve per-request token overrides (swap-direction-aware)
  // ACP jobs pass these without mutating sharedState.activeTokens.
  const tokenOverrides = request.tokens
    ? {
        tokenIn:  request.side === "BUY" ? request.tokens.quote : request.tokens.base,
        tokenOut: request.side === "BUY" ? request.tokens.base  : request.tokens.quote,
      }
    : {};

  let execResult;
  try {
    execResult = await engine.executeTrade({
      pair: request.pair,
      side: request.side,
      notionalUsd: request.notionalUsd,
      maxSlippagePct: request.maxSlippagePct ?? cfg.maxSlippageBps / 100,
      reasons: request.reasons,
      mode: request.mode,
      ...tokenOverrides,
    });
  } catch (err: any) {
    return { error: err.message };
  }

  // fillPrice: USDC per base token (e.g. USDC per SOL or USDC per ETH)
  const usdcAmount = request.side === "BUY" ? execResult.inAmount : execResult.outAmount;
  const tokenAmount = request.side === "BUY" ? execResult.outAmount : execResult.inAmount;
  const fillPrice = tokenAmount > 0 ? usdcAmount / tokenAmount : 0;

  const receiptId = randomUUID().slice(0, 8);

  // Update paper portfolio state
  if (request.side === "BUY") {
    sharedState.paperUSDC -= request.notionalUsd;
    sharedState.paperPosition += tokenAmount;
  } else {
    sharedState.paperPosition -= tokenAmount;
    sharedState.paperUSDC += request.notionalUsd;
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
    side: request.side,
    price: fillPrice,
  });

  const risk = checkRisk(request.notionalUsd, execResult.slippageBps ?? 0, cfg);

  const receipt: TradeReceipt = {
    id: receiptId,
    ts: execResult.ts,
    pair: request.pair,
    side: request.side,
    mode: sharedState.paperMode ? "paper" : "live",
    notional: request.notionalUsd,
    fillPrice,
    confidence: 0.5,
    reasons: request.reasons,
    riskChecks: risk.checks,
    memoTxid: execResult.txHash || "N/A",
    status: execResult.ok ? "SUCCESS" : "FAILED",
    chain: request.chain,
    source: request.source,
  };
  if (request.wallet) receipt.wallet = request.wallet;

  appendReceipt(receipt);
  return receipt;
}
