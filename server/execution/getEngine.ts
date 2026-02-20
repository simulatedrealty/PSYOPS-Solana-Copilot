import { type ExecutionEngine } from "./types";
import { solanaEngine } from "./solanaEngine";
import { baseEngine } from "./baseEngine";

/**
 * Returns the active ExecutionEngine based on EXECUTION_CHAIN env var.
 *   EXECUTION_CHAIN=base    → baseEngine  (Uniswap V3 on Base mainnet, QuoterV2 slippage)
 *   EXECUTION_CHAIN=<other> → solanaEngine (Jupiter paper + devnet memo)
 */
export function getEngine(): ExecutionEngine {
  const chain = process.env.EXECUTION_CHAIN || "solana-devnet";
  return chain === "base" ? baseEngine : solanaEngine;
}
