import { type ExecutionEngine } from "./types";
import { solanaEngine } from "./solanaEngine";
import { executeBaseTrade, getBaseWallet } from "./baseMainnetEngine";

/**
 * Returns the active ExecutionEngine based on EXECUTION_CHAIN env var.
 *   EXECUTION_CHAIN=base    → baseMainnetEngine (real Uniswap V3 swap on Base)
 *   EXECUTION_CHAIN=<other> → solanaEngine      (Jupiter paper + devnet memo)
 */
export function getEngine(): ExecutionEngine {
  const chain = process.env.EXECUTION_CHAIN || "solana-devnet";
  if (chain === "base") {
    return {
      getWallet: getBaseWallet,
      executeTrade: (args) =>
        executeBaseTrade({
          pair: args.pair,
          side: args.side,
          notionalUsd: args.notionalUsd,
          maxSlippageBps:
            args.maxSlippagePct != null
              ? Math.round(args.maxSlippagePct * 100)
              : 50,
          reasons: args.reasons,
          mode: args.mode,
        }),
    };
  }
  return solanaEngine;
}
