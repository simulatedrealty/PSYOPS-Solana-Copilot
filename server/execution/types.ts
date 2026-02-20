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
