import { getViemClient } from "./viemClient";

// USDC/WETH 0.05% fee Uniswap v3 pool on Ethereum mainnet
// token0 = USDC (0xA0b86991..., 6 decimals), token1 = WETH (0xC02aaA..., 18 decimals)
const USDC_WETH_POOL = "0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640" as const;

const POOL_ABI = [
  {
    inputs: [],
    name: "slot0",
    outputs: [
      { name: "sqrtPriceX96", type: "uint160" },
      { name: "tick", type: "int24" },
      { name: "observationIndex", type: "uint16" },
      { name: "observationCardinality", type: "uint16" },
      { name: "observationCardinalityNext", type: "uint16" },
      { name: "feeProtocol", type: "uint8" },
      { name: "unlocked", type: "bool" },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "liquidity",
    outputs: [{ name: "", type: "uint128" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

export interface UniswapMarketData {
  pair: string;
  impliedPrice: number;
  gasPriceGwei: number;
  liquidityUSD: number;
  poolAddress: string;
  source: "uniswap-v3-viem";
}

/**
 * Fetches live ETH/USDC price from the Uniswap v3 USDC/WETH 0.05% pool
 * using the viem client (on-chain read of pool slot0).
 *
 * Price derivation:
 *   sqrtPriceX96 = sqrt(WETH_raw / USDC_raw) * 2^96
 *   ethPriceUSDC = 10^12 * 2^192 / sqrtPriceX96^2
 *   (adjusts for token decimals: USDC=6, WETH=18)
 */
export async function getUniswapMarketData(
  pair: string = "ETH-USDC"
): Promise<UniswapMarketData> {
  const client = getViemClient();

  try {
    const [slot0Result, gasPrice, liquidity] = await Promise.all([
      client.readContract({
        address: USDC_WETH_POOL,
        abi: POOL_ABI,
        functionName: "slot0",
      }),
      client.getGasPrice(),
      client.readContract({
        address: USDC_WETH_POOL,
        abi: POOL_ABI,
        functionName: "liquidity",
      }),
    ]);

    const sqrtPriceX96 = slot0Result[0] as bigint;

    // Compute ETH price in USDC with BigInt to avoid precision loss
    // ethPrice = 10^12 * 2^192 / sqrtPriceX96^2
    // Multiply numerator by 10000 to retain 4 decimal places
    const SCALE = BigInt(10000);
    const numerator =
      BigInt(10) ** BigInt(12) * BigInt(2) ** BigInt(192) * SCALE;
    const denominator = sqrtPriceX96 * sqrtPriceX96;
    const priceScaled = numerator / denominator;
    const impliedPrice = Number(priceScaled) / 10000;

    const gasPriceGwei = Number(gasPrice) / 1e9;

    // Rough USD liquidity estimate: liquidity * price / 1e12
    const liquidityUSD =
      (Number(liquidity) * impliedPrice) / 1e12;

    return {
      pair,
      impliedPrice,
      gasPriceGwei,
      liquidityUSD,
      poolAddress: USDC_WETH_POOL,
      source: "uniswap-v3-viem",
    };
  } catch (err: any) {
    console.error("[uniswap/market] Error fetching market data:", err.message);
    return {
      pair,
      impliedPrice: 0,
      gasPriceGwei: 0,
      liquidityUSD: 0,
      poolAddress: USDC_WETH_POOL,
      source: "uniswap-v3-viem",
    };
  }
}
