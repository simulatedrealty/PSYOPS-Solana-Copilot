import { createPublicClient, http, formatUnits, parseUnits, getAddress, type Address } from "viem";
import { base as baseChain } from "viem/chains";
import type { ActiveTokens } from "./state";

const JUPITER_QUOTE_URL = "https://api.jup.ag/swap/v1/quote";

// Solana mint map — used by the legacy getImpliedPrice() entry point
const MINT_MAP: Record<string, string> = {
  SOL:  "So11111111111111111111111111111111111111112",
  USDC: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
};

// ── Base defaults (public, non-secret) ───────────────────────────────────────
const BASE_USDC_DEFAULT        = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const BASE_SWAP_ROUTER_DEFAULT = "0x2626664c2603336E57B271c5C0b26F421741e481";
const BASE_RPC_DEFAULT         = "https://mainnet.base.org";

export interface MarketData {
  impliedPrice: number;
  slippageBps: number;
  impact: number;
  routeSummary: string;
}

// ── Solana ────────────────────────────────────────────────────────────────────

/**
 * getImpliedPrice — legacy entry point; resolves pair label via MINT_MAP.
 * Kept for backward compat with tradingEngine.ts and skill fallback paths.
 */
export async function getImpliedPrice(pair: string, notional: number): Promise<MarketData> {
  const [baseSymbol, quoteSymbol] = pair.split("-");
  const inputMint  = MINT_MAP[quoteSymbol] || MINT_MAP["USDC"];
  const outputMint = MINT_MAP[baseSymbol]  || MINT_MAP["SOL"];
  return jupiterQuote(inputMint, outputMint, notional);
}

/** Core Jupiter v1 quote — accepts explicit mint addresses. */
async function jupiterQuote(
  inputMint: string,
  outputMint: string,
  notional: number
): Promise<MarketData> {
  const amount = Math.round(notional * 1_000_000); // USDC = 6 decimals

  try {
    const params = new URLSearchParams({
      inputMint,
      outputMint,
      amount: amount.toString(),
      slippageBps: "50",
    });

    const headers: Record<string, string> = {};
    if (process.env.JUPITER_API_KEY) {
      headers["x-api-key"] = process.env.JUPITER_API_KEY;
    }

    const resp = await fetch(`${JUPITER_QUOTE_URL}?${params}`, { headers });
    if (!resp.ok) throw new Error(`Jupiter API returned ${resp.status}`);

    const data = await resp.json();
    const inAmountNum  = parseInt(data.inAmount)  / 1_000_000;     // USDC (6 dec)
    const outAmountNum = parseInt(data.outAmount) / 1_000_000_000; // SOL default (9 dec)

    const impliedPrice = inAmountNum / outAmountNum;
    const slippageBps  = data.slippageBps ?? 0;
    const impact       = data.priceImpactPct ? parseFloat(data.priceImpactPct) : 0;
    const routeInfo    = data.routePlan
      ? data.routePlan.map((r: any) => r.swapInfo?.label || "unknown").join(" -> ")
      : "direct";

    return {
      impliedPrice,
      slippageBps: typeof slippageBps === "number" ? slippageBps : parseInt(slippageBps) || 0,
      impact,
      routeSummary: routeInfo,
    };
  } catch (err: any) {
    console.error("[market] Jupiter quote error:", err.message);
    return { impliedPrice: 0, slippageBps: 0, impact: 0, routeSummary: "error" };
  }
}

// ── Base ──────────────────────────────────────────────────────────────────────

const QUOTER_V2 = getAddress("0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a") as Address;

const QUOTER_V2_ABI = [
  {
    inputs: [
      {
        components: [
          { name: "tokenIn",           type: "address" },
          { name: "tokenOut",          type: "address" },
          { name: "amountIn",          type: "uint256" },
          { name: "fee",               type: "uint24"  },
          { name: "sqrtPriceLimitX96", type: "uint160" },
        ],
        name: "params",
        type: "tuple",
      },
    ],
    name: "quoteExactInputSingle",
    outputs: [
      { name: "amountOut",               type: "uint256" },
      { name: "sqrtPriceX96After",       type: "uint160" },
      { name: "initializedTicksCrossed", type: "uint32"  },
      { name: "gasEstimate",             type: "uint256" },
    ],
    stateMutability: "nonpayable",
    type: "function",
  },
] as const;

const ERC20_DECIMALS_ABI = [
  {
    inputs: [],
    name: "decimals",
    outputs: [{ name: "", type: "uint8" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

/**
 * getBaseImpliedPrice — on-chain price via QuoterV2 on Base mainnet.
 * Simulates quoteExactInputSingle(quote → base) to derive implied price.
 * slippageBps is fixed at 50 (0.5%) — a conservative estimate consistent with
 * baseEngine's execution max slippage. True on-chain slippage is enforced at
 * execution time by baseEngine.
 */
async function getBaseImpliedPrice(
  tokens: ActiveTokens,
  notional: number
): Promise<MarketData> {
  const rpcUrl = process.env.BASE_RPC_URL || BASE_RPC_DEFAULT;

  try {
    const publicClient = createPublicClient({ chain: baseChain, transport: http(rpcUrl) });
    const poolFee = parseInt(process.env.BASE_POOL_FEE || "3000", 10);

    if (!tokens.base) {
      console.warn("[market] No base token address provided for Base chain");
      return { impliedPrice: 0, slippageBps: 0, impact: 0, routeSummary: "no base token address" };
    }

    const quoteAddr = getAddress(tokens.quote || BASE_USDC_DEFAULT) as Address;
    const baseAddr  = getAddress(tokens.base) as Address;

    // Read on-chain decimals (handles WBTC/8, USDT/6, any non-18 token)
    const [quoteDecimals, baseDecimals] = await Promise.all([
      publicClient.readContract({ address: quoteAddr, abi: ERC20_DECIMALS_ABI, functionName: "decimals" }),
      publicClient.readContract({ address: baseAddr,  abi: ERC20_DECIMALS_ABI, functionName: "decimals" }),
    ]);

    const inAmountRaw = parseUnits(
      notional.toFixed(Number(quoteDecimals)),
      Number(quoteDecimals)
    );

    // Simulate quote → base swap
    const { result } = await publicClient.simulateContract({
      address: QUOTER_V2,
      abi: QUOTER_V2_ABI,
      functionName: "quoteExactInputSingle",
      args: [{
        tokenIn:           quoteAddr,
        tokenOut:          baseAddr,
        amountIn:          inAmountRaw,
        fee:               poolFee,
        sqrtPriceLimitX96: BigInt(0),
      }],
    });

    const outAmountRaw: bigint = result[0] as bigint;
    const outAmountHuman = parseFloat(formatUnits(outAmountRaw, Number(baseDecimals)));

    if (outAmountHuman <= 0) {
      return { impliedPrice: 0, slippageBps: 0, impact: 0, routeSummary: "zero output" };
    }

    const impliedPrice = notional / outAmountHuman; // USDC per base token

    return {
      impliedPrice,
      slippageBps: 50, // conservative fixed estimate; execution enforces real on-chain limit
      impact: 0,
      routeSummary: `uniswap-v3 fee=${poolFee}`,
    };
  } catch (err: any) {
    console.error("[market] Base QuoterV2 error:", err.message);
    return { impliedPrice: 0, slippageBps: 0, impact: 0, routeSummary: "error" };
  }
}

// ── Dispatcher ────────────────────────────────────────────────────────────────

/**
 * getMarketForChain — unified market data entry point.
 *
 *   chain="solana-devnet" → Jupiter v1 with explicit mint addresses from tokens
 *   chain="base"          → on-chain QuoterV2 via BASE_RPC_URL
 *
 * All engine entry points (loop, manual UI, skill, future ACP) use this.
 * ACP jobs pass chain/tokens per-request without mutating sharedState.
 */
export async function getMarketForChain(
  chain: "solana-devnet" | "base",
  _pair: string,
  tokens: ActiveTokens,
  notional: number
): Promise<MarketData> {
  if (chain === "base") {
    return getBaseImpliedPrice(tokens, notional);
  }
  // Solana: use explicit mints from activeTokens (not MINT_MAP pair-label lookup)
  return jupiterQuote(tokens.quote, tokens.base, notional);
}
