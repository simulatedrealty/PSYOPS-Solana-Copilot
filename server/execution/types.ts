export type Side = "BUY" | "SELL";

export interface ExecuteArgs {
  pair: string;
  side: Side;
  notionalUsd: number;
  maxSlippagePct?: number;
  reasons: string[];
  mode: string;
  // Per-request token overrides — used by Base engine for arbitrary ERC20 pairs.
  // If omitted, baseEngine falls back to BASE_PRIMARY_TOKEN / BASE_USDC env vars.
  tokenIn?: string;
  tokenOut?: string;
}

export interface ExecutionReceipt {
  ok: boolean;
  chain: string;
  venue: string;
  pair: string;
  side: Side;
  notionalUsd: number;
  txHash?: string;
  explorerUrl?: string;
  inToken: string;
  outToken: string;
  inAmount: number;
  outAmount: number;
  slippageBps?: number;
  reasons: string[];
  mode: string;
  ts: number;
  notes?: string;
}

export interface ExecutionEngine {
  executeTrade(args: ExecuteArgs): Promise<ExecutionReceipt>;
  getWallet(): string;
}

export interface TradeRequest {
  chain: "solana-devnet" | "base";
  pair: string;
  side: Side;
  notionalUsd: number;
  maxSlippagePct?: number;
  reasons: string[];
  mode: string;
  source: "ui" | "skill" | "acp";
  wallet?: string;
  // Per-request token addresses — allows any ERC20 pair on Base without env var changes.
  // ACP jobs set this per-request without mutating sharedState.activeTokens.
  tokens?: { base: string; quote: string };
}
