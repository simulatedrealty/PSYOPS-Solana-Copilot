import { getSignal, getReceiptById, getReceipts } from "../engine/tradingEngine";
import { getMarketForChain } from "../engine/market";
import { getConfig } from "../engine/config";
import { checkRisk } from "../engine/risk";
import { handleTrade } from "../execution/handler";
import { sharedState } from "../engine/state";
import { getEngine } from "../execution/getEngine";

export function manifest() {
  return {
    name: "psyops-trading-skill",
    version: "0.3.0",
    description: "LLM-driven multi-chain trading copilot (Solana devnet + Base). All actions are chain/pair-aware. Defaults to sharedState.activeChain/activePair if not provided.",
    actions: {
      get_market: {
        "chain (optional)": '"solana-devnet" | "base" — defaults to active chain',
        "pair (optional)": "trading pair label, e.g. SOL-USDC",
        "baseToken (optional)": "base token mint/address",
        "quoteToken (optional)": "quote token mint/address",
      },
      get_signal: {
        "pair (optional)": "defaults to active pair",
      },
      propose_trade: {
        "pair (optional)": "trading pair",
        side: '"BUY" | "SELL"',
        "notional (optional)": "USDC notional, defaults to config maxNotional",
        "chain (optional)": '"solana-devnet" | "base"',
        "baseToken (optional)": "base token address",
        "quoteToken (optional)": "quote token address",
      },
      execute_trade: {
        "pair (optional)": "trading pair",
        side: '"BUY" | "SELL"',
        "notional (optional)": "USDC notional",
        "chain (optional)": '"solana-devnet" | "base" — defaults to active chain',
        "baseToken (optional)": "base token address (any ERC20 on Base)",
        "quoteToken (optional)": "quote token address",
      },
      get_receipt: { "id (optional)": "receipt id — omit to list all" },
      set_chain: {
        chain: '"solana-devnet" | "base"',
        "pair (optional)": "trading pair label",
        "baseToken (optional)": "base token address",
        "quoteToken (optional)": "quote token address",
        description: "Updates sharedState.activeChain/activePair/activeTokens and resets rolling prices",
      },
    },
  };
}

/** Resolve chain/pair/tokens from args, falling back to sharedState. */
function resolveChainContext(args: Record<string, any>) {
  const chain: "solana-devnet" | "base" =
    args.chain === "base" ? "base" :
    args.chain === "solana-devnet" ? "solana-devnet" :
    sharedState.activeChain;

  const pair: string = args.pair || sharedState.activePair;

  const SOL_MINT  = "So11111111111111111111111111111111111111112";
  const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

  const tokens = {
    base:  args.baseToken  || (chain === "solana-devnet" ? sharedState.activeTokens.base  : (process.env.BASE_PRIMARY_TOKEN || "")),
    quote: args.quoteToken || (chain === "solana-devnet" ? sharedState.activeTokens.quote : (process.env.BASE_USDC          || "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913")),
  };

  // Fall back to Solana defaults if still empty
  if (!tokens.base  && chain === "solana-devnet") tokens.base  = SOL_MINT;
  if (!tokens.quote && chain === "solana-devnet") tokens.quote = USDC_MINT;

  return { chain, pair, tokens };
}

export async function invoke(action: string, args: Record<string, any>): Promise<any> {
  switch (action) {
    case "get_market": {
      const { chain, pair, tokens } = resolveChainContext(args);
      const cfg = getConfig();
      const notional = args.notional || cfg.maxNotional;
      return getMarketForChain(chain, pair, tokens, notional);
    }

    case "get_signal": {
      const pair = args.pair || sharedState.activePair;
      return getSignal(pair);
    }

    case "propose_trade": {
      const { chain, pair, tokens } = resolveChainContext(args);
      const side = args.side as "BUY" | "SELL";
      const notional = args.notional || getConfig().maxNotional;
      const cfg = getConfig();
      const market = await getMarketForChain(chain, pair, tokens, notional);
      const risk = checkRisk(notional, market.slippageBps, cfg);
      return { chain, pair, market, risk };
    }

    case "execute_trade": {
      const { chain, pair, tokens } = resolveChainContext(args);
      const side = args.side as "BUY" | "SELL";
      const notional = args.notional || getConfig().maxNotional;
      const result = await handleTrade({
        chain,
        pair,
        side,
        notionalUsd: notional,
        reasons: ["skill invoke"],
        mode: "skill",
        source: "skill",
        tokens,
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

      const SOL_MINT  = "So11111111111111111111111111111111111111112";
      const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

      if (chain === "solana-devnet") {
        sharedState.activeTokens = {
          base:  args.baseToken  || SOL_MINT,
          quote: args.quoteToken || USDC_MINT,
        };
        sharedState.activePair = args.pair || "SOL-USDC";
      } else {
        sharedState.activeTokens = {
          base:  args.baseToken  || process.env.BASE_PRIMARY_TOKEN || "",
          quote: args.quoteToken || process.env.BASE_USDC          || "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        };
        sharedState.activePair = args.pair || "BASE-USDC";
      }

      sharedState.activeChain    = chain as "solana-devnet" | "base";
      sharedState.rollingPrices  = [];
      sharedState.lastSignal     = null;
      sharedState.lastStrength   = null;
      sharedState.lastConfidence = null;
      sharedState.lastReasons    = [];
      sharedState.lastImpliedPrice = null;

      const wallet = getEngine(chain).getWallet();
      const configured =
        chain === "solana-devnet" ||
        !!(process.env.BASE_PRIVATE_KEY && process.env.BASE_PRIMARY_TOKEN);

      return {
        chain: sharedState.activeChain,
        pair: sharedState.activePair,
        tokens: sharedState.activeTokens,
        wallet,
        configured,
      };
    }

    default:
      throw new Error(`Unknown action: ${action}`);
  }
}
