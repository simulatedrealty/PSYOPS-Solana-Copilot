import { getMarket, getSignal, getReceiptById, getReceipts } from "../engine/tradingEngine";
import { getConfig } from "../engine/config";
import { checkRisk } from "../engine/risk";
import { handleTrade } from "../execution/handler";

export function manifest() {
  return {
    name: "psyops-trading-skill",
    version: "0.2.0",
    description: "LLM-driven trading intelligence + on-chain receipts (paper mode). Supports Solana devnet and Base mainnet.",
    actions: {
      get_market: { pair: "string" },
      get_signal: { pair: "string" },
      propose_trade: { pair: "string", side: "string", notional: "number" },
      execute_trade: {
        pair: "string",
        side: "string",
        notional: "number",
        "chain (optional)": "\"solana-devnet\" | \"base\" — default: solana-devnet",
      },
      get_receipt: { id: "string" },
      set_chain: {
        chain: "\"solana-devnet\" | \"base\"",
        description: "Validate chain availability and return wallet address for the chain",
      },
    },
  };
}

export async function invoke(action: string, args: Record<string, any>): Promise<any> {
  switch (action) {
    case "get_market": {
      const pair = args.pair || getConfig().pair;
      return getMarket(pair);
    }
    case "get_signal": {
      const pair = args.pair || getConfig().pair;
      return getSignal(pair);
    }
    case "propose_trade": {
      const pair = args.pair || getConfig().pair;
      const side = args.side as "BUY" | "SELL";
      const notional = args.notional || getConfig().maxNotional;
      const market = await getMarket(pair);
      const cfg = getConfig();
      const risk = checkRisk(notional, market.slippageBps, cfg);
      return { market, risk };
    }
    case "execute_trade": {
      const pair = args.pair || getConfig().pair;
      const side = args.side as "BUY" | "SELL";
      const notional = args.notional || getConfig().maxNotional;
      const chain = args.chain === "base" ? "base" : "solana-devnet";
      const result = await handleTrade({
        chain,
        pair,
        side,
        notionalUsd: notional,
        reasons: ["manual skill invoke"],
        mode: "skill",
        source: "skill",
      });
      if ("error" in result) throw new Error(result.error);
      return result;
    }
    case "get_receipt": {
      if (args.id) return getReceiptById(args.id);
      return getReceipts();
    }
    case "set_chain": {
      const chain = args.chain as string;
      if (chain !== "solana-devnet" && chain !== "base") {
        throw new Error('chain must be "solana-devnet" or "base"');
      }
      const { getEngine } = await import("../execution/getEngine");
      const wallet = getEngine(chain).getWallet();
      const configured =
        chain === "solana-devnet" ||
        !!(
          process.env.BASE_PRIVATE_KEY &&
          process.env.BASE_RPC_URL &&
          process.env.BASE_PRIMARY_TOKEN &&
          process.env.BASE_USDC &&
          process.env.BASE_SWAP_ROUTER
        );
      return { chain, wallet, configured };
    }
    default:
      throw new Error(`Unknown action: ${action}`);
  }
}
