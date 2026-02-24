export type Side = "BUY" | "SELL";

export interface ExecuteArgs {
  pair: string;
  side: Side;
  notionalUsd: number;
  maxSlippagePct?: number;
  reasons: string[];
  mode: string;
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
  wallet?: string; // reserved for phase 2 wallet-connect / ACP — ignored in phase 1
}
