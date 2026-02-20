import { type ExecutionEngine } from "./types";
import { solanaEngine } from "./solanaEngine";
import { baseEngine } from "./baseEngine";

/**
 * Returns the active ExecutionEngine based on EXECUTION_CHAIN env var.
 *   EXECUTION_CHAIN=base    → baseEngine  (Uniswap v3 on Base mainnet via viem)
 *   EXECUTION_CHAIN=<other> → solanaEngine (Jupiter paper trade + devnet memo)
 */
export function getEngine(): ExecutionEngine {
  const chain = process.env.EXECUTION_CHAIN || "solana-devnet";
  if (chain === "base") return baseEngine;
  return solanaEngine;
}
