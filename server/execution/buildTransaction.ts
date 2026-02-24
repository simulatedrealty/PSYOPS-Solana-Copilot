/**
 * Unsigned transaction builders for browser-wallet live trading.
 *
 * Server builds the unsigned transaction, browser wallet signs and submits it.
 * Server never receives, stores, or logs private keys.
 *
 * Solana: Jupiter Swap API v6 → base64-encoded unsigned VersionedTransaction
 * Base:   Uniswap V3 via QuoterV2 → array of {to, data, value} steps (approve + swap)
 */
import {
  createPublicClient,
  http,
  parseUnits,
  encodeFunctionData,
  type Address,
} from "viem";
import { base } from "viem/chains";

// ── Constants ─────────────────────────────────────────────────────────────────

const QUOTER_V2 = "0x3d4e44Eb1374240CE5F1B136cf394426C39B0FE9" as const;

const JUPITER_MINTS: Record<string, string> = {
  SOL: "So11111111111111111111111111111111111111112",
  USDC: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
};

// ── ABIs (duplicated from baseEngine.ts — keep in sync) ───────────────────────

const ERC20_ABI = [
  {
    inputs: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }],
    name: "allowance",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }],
    name: "approve",
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [],
    name: "decimals",
    outputs: [{ name: "", type: "uint8" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

const SWAP_ROUTER_ABI = [
  {
    inputs: [
      {
        components: [
          { name: "tokenIn", type: "address" },
          { name: "tokenOut", type: "address" },
          { name: "fee", type: "uint24" },
          { name: "recipient", type: "address" },
          { name: "deadline", type: "uint256" },
          { name: "amountIn", type: "uint256" },
          { name: "amountOutMinimum", type: "uint256" },
          { name: "sqrtPriceLimitX96", type: "uint160" },
        ],
        name: "params",
        type: "tuple",
      },
    ],
    name: "exactInputSingle",
    outputs: [{ name: "amountOut", type: "uint256" }],
    stateMutability: "payable",
    type: "function",
  },
] as const;

const QUOTER_V2_ABI = [
  {
    inputs: [
      {
        components: [
          { name: "tokenIn", type: "address" },
          { name: "tokenOut", type: "address" },
          { name: "amountIn", type: "uint256" },
          { name: "fee", type: "uint24" },
          { name: "sqrtPriceLimitX96", type: "uint160" },
        ],
        name: "params",
        type: "tuple",
      },
    ],
    name: "quoteExactInputSingle",
    outputs: [
      { name: "amountOut", type: "uint256" },
      { name: "sqrtPriceX96After", type: "uint160" },
      { name: "initializedTicksCrossed", type: "uint32" },
      { name: "gasEstimate", type: "uint256" },
    ],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [
      {
        components: [
          { name: "tokenIn", type: "address" },
          { name: "tokenOut", type: "address" },
          { name: "amount", type: "uint256" },
          { name: "fee", type: "uint24" },
          { name: "sqrtPriceLimitX96", type: "uint160" },
        ],
        name: "params",
        type: "tuple",
      },
    ],
    name: "quoteExactOutputSingle",
    outputs: [
      { name: "amountIn", type: "uint256" },
      { name: "sqrtPriceX96After", type: "uint160" },
      { name: "initializedTicksCrossed", type: "uint32" },
      { name: "gasEstimate", type: "uint256" },
    ],
    stateMutability: "nonpayable",
    type: "function",
  },
] as const;

export interface TransactionStep {
  to: string;
  data: string;
  value: string;
  description: string;
}

// ── Solana ────────────────────────────────────────────────────────────────────
// Note: market.ts uses Jupiter v1 (api.jup.ag/swap/v1/quote) for price feeds.
// buildSolanaTransaction uses Jupiter v6 (quote-api.jup.ag/v6) for user-wallet
// unsigned swap transactions. Both APIs coexist — don't conflate them.

export async function buildSolanaTransaction(
  pair: string,
  side: "BUY" | "SELL",
  notional: number,
  walletAddress: string
): Promise<{ serializedTransaction: string }> {
  const [baseToken] = pair.split("-");
  const isBuy = side === "BUY";
  const inputMint = isBuy ? JUPITER_MINTS.USDC : JUPITER_MINTS[baseToken];
  const outputMint = isBuy ? JUPITER_MINTS[baseToken] : JUPITER_MINTS.USDC;

  if (!inputMint || !outputMint) {
    throw new Error(`Unknown token in pair ${pair}. Supported: SOL-USDC`);
  }

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (process.env.JUPITER_API_KEY) headers["x-api-key"] = process.env.JUPITER_API_KEY;

  // For BUY: ExactIn with USDC amount (6 decimals)
  // For SELL: ExactOut — ask for exactly notional USDC output, Jupiter figures out SOL input
  const amount = Math.round(notional * 1_000_000); // USDC micro-units in both cases
  const swapMode = isBuy ? "ExactIn" : "ExactOut";

  // Step 1: Get quote from Jupiter v6
  const quoteUrl = `https://quote-api.jup.ag/v6/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=50&swapMode=${swapMode}`;
  const quoteRes = await fetch(quoteUrl, { headers });
  if (!quoteRes.ok) {
    throw new Error(`Jupiter quote failed (${quoteRes.status}): ${await quoteRes.text()}`);
  }
  const quoteResponse = await quoteRes.json();

  // Step 2: Get unsigned swap VersionedTransaction for user's wallet
  const swapRes = await fetch("https://quote-api.jup.ag/v6/swap", {
    method: "POST",
    headers,
    body: JSON.stringify({
      quoteResponse,
      userPublicKey: walletAddress,
      asLegacyTransaction: false, // VersionedTransaction
    }),
  });
  if (!swapRes.ok) {
    throw new Error(`Jupiter swap build failed (${swapRes.status}): ${await swapRes.text()}`);
  }
  const { swapTransaction } = await swapRes.json();
  if (!swapTransaction) {
    throw new Error("Jupiter did not return a swapTransaction");
  }

  return { serializedTransaction: swapTransaction }; // base64-encoded unsigned VersionedTransaction
}

// ── Base ──────────────────────────────────────────────────────────────────────

export async function buildBaseTransaction(
  pair: string,
  side: "BUY" | "SELL",
  notional: number,
  walletAddress: string
): Promise<{ steps: TransactionStep[] }> {
  const rpcUrl = process.env.BASE_RPC_URL || "https://mainnet.base.org";
  const primaryToken = process.env.BASE_PRIMARY_TOKEN as Address;
  const usdcAddress = (process.env.BASE_USDC || "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913") as Address;
  const swapRouter = (process.env.BASE_SWAP_ROUTER || "0x2626664c2603336E57B271c5C0b26F421741e481") as Address;
  const poolFee = parseInt(process.env.BASE_POOL_FEE || "3000", 10);

  if (!primaryToken) {
    throw new Error("Base chain not configured. Required: BASE_PRIMARY_TOKEN");
  }

  const isBuy = side === "BUY";
  const tokenIn: Address = isBuy ? usdcAddress : primaryToken;
  const tokenOut: Address = isBuy ? primaryToken : usdcAddress;
  const [baseSymbol] = pair.split("-");
  const inLabel = isBuy ? "USDC" : baseSymbol;
  const outLabel = isBuy ? baseSymbol : "USDC";

  const publicClient = createPublicClient({ chain: base, transport: http(rpcUrl) });
  const userAddress = walletAddress as Address;

  const inDecimals = await publicClient.readContract({
    address: tokenIn, abi: ERC20_ABI, functionName: "decimals",
  });
  const outDecimals = await publicClient.readContract({
    address: tokenOut, abi: ERC20_ABI, functionName: "decimals",
  });

  // Compute input amount
  let inAmountRaw: bigint;
  if (isBuy) {
    inAmountRaw = parseUnits(notional.toFixed(Number(inDecimals)), Number(inDecimals));
  } else {
    // SELL: QuoterV2 quoteExactOutputSingle → correct token amount to sell for target USDC
    const usdcAmountRaw = parseUnits(notional.toFixed(Number(outDecimals)), Number(outDecimals));
    let estimatedIn = BigInt(0);
    try {
      const { result } = await publicClient.simulateContract({
        address: QUOTER_V2,
        abi: QUOTER_V2_ABI,
        functionName: "quoteExactOutputSingle",
        args: [{
          tokenIn: primaryToken,
          tokenOut: usdcAddress,
          amount: usdcAmountRaw,
          fee: poolFee,
          sqrtPriceLimitX96: BigInt(0),
        }],
      });
      estimatedIn = result[0] as bigint;
    } catch {
      throw new Error("Could not quote SELL amount from QuoterV2 — check pool liquidity");
    }
    inAmountRaw = estimatedIn;
  }

  // QuoterV2 quoteExactInputSingle → real amountOutMinimum
  let quotedOut = BigInt(0);
  try {
    const { result } = await publicClient.simulateContract({
      address: QUOTER_V2,
      abi: QUOTER_V2_ABI,
      functionName: "quoteExactInputSingle",
      args: [{
        tokenIn,
        tokenOut,
        amountIn: inAmountRaw,
        fee: poolFee,
        sqrtPriceLimitX96: BigInt(0),
      }],
    });
    quotedOut = result[0] as bigint;
  } catch {
    // proceed with amountOutMinimum = 0 if quote fails
  }

  const maxSlippagePct = 0.5;
  const amountOutMinimum = quotedOut > BigInt(0)
    ? BigInt(Math.floor(Number(quotedOut) * (1 - maxSlippagePct / 100)))
    : BigInt(0);

  const deadline = BigInt(Math.floor(Date.now() / 1000) + 300); // 5 min
  const steps: TransactionStep[] = [];

  // Conditional approve step (skip if allowance already sufficient)
  const allowance = await publicClient.readContract({
    address: tokenIn,
    abi: ERC20_ABI,
    functionName: "allowance",
    args: [userAddress, swapRouter],
  });
  if ((allowance as bigint) < inAmountRaw) {
    steps.push({
      to: tokenIn,
      data: encodeFunctionData({
        abi: ERC20_ABI,
        functionName: "approve",
        args: [swapRouter, inAmountRaw],
      }),
      value: "0x0",
      description: `Approve ${inLabel} for swap router`,
    });
  }

  // Swap step
  steps.push({
    to: swapRouter,
    data: encodeFunctionData({
      abi: SWAP_ROUTER_ABI,
      functionName: "exactInputSingle",
      args: [{
        tokenIn,
        tokenOut,
        fee: poolFee,
        recipient: userAddress,
        deadline,
        amountIn: inAmountRaw,
        amountOutMinimum,
        sqrtPriceLimitX96: BigInt(0),
      }],
    }),
    value: "0x0",
    description: `Swap ${inLabel} → ${outLabel}`,
  });

  return { steps };
}
