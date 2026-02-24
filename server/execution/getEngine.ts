import { type ExecutionEngine } from "./types";
import { solanaEngine } from "./solanaEngine";
import { baseEngine } from "./baseEngine";

/**
 * Returns the active ExecutionEngine for the given chain.
 *   chain="base"   → baseEngine  (Uniswap V3 on Base mainnet, QuoterV2 slippage)
 *   chain=<other>  → solanaEngine (Jupiter paper + devnet memo)
 *
 * Defaults to EXECUTION_CHAIN env var so the autonomous loop continues to work
 * without passing an explicit chain arg.
 */
export function getEngine(
  chain: string = process.env.EXECUTION_CHAIN || "solana-devnet"
): ExecutionEngine {
  return chain === "base" ? baseEngine : solanaEngine;
}
