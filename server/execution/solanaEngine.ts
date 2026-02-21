import { type ExecutionEngine, type ExecuteArgs, type ExecutionReceipt } from "./types";
import { getImpliedPrice } from "../engine/market";
import { agentSendMemo, initAgentKit } from "../engine/agentKit";

export const solanaEngine: ExecutionEngine = {
  getWallet(): string {
    return initAgentKit().wallet_address.toBase58();
  },

  async executeTrade(args: ExecuteArgs): Promise<ExecutionReceipt> {
    const { pair, side, notionalUsd, reasons, mode } = args;
    const [base, quote] = pair.split("-");

    const market = await getImpliedPrice(pair, notionalUsd);
    const fillPrice = market.impliedPrice;

    // BUY: spend USDC (quote), receive SOL (base)
    // SELL: spend SOL (base), receive USDC (quote)
    const inToken = side === "BUY" ? quote : base;
    const outToken = side === "BUY" ? base : quote;
    const inAmount = side === "BUY" ? notionalUsd : notionalUsd / fillPrice;
    const outAmount = side === "BUY" ? notionalUsd / fillPrice : notionalUsd;

    const memoText = `AA|${pair}|${side}|N=${notionalUsd}|price=${fillPrice.toFixed(4)}`;
    const txHash = await agentSendMemo(memoText);
    const validTx = txHash && txHash !== "N/A" ? txHash : undefined;

    return {
      ok: true,
      chain: "solana-devnet",
      venue: "jupiter",
      pair,
      side,
      notionalUsd,
      txHash: validTx,
      explorerUrl: validTx
        ? `https://explorer.solana.com/tx/${validTx}?cluster=devnet`
        : undefined,
      inToken,
      outToken,
      inAmount,
      outAmount,
      slippageBps: market.slippageBps,
      reasons,
      mode,
      ts: Date.now(),
    };
  },
};
