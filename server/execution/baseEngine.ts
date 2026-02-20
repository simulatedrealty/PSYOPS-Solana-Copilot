import {
  createPublicClient,
  createWalletClient,
  http,
  parseUnits,
  formatUnits,
} from "viem";
import { base } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { type ExecutionEngine, type ExecuteArgs, type ExecutionReceipt } from "./types";

// ── Token addresses on Base mainnet ──────────────────────────────────────────
const WETH = "0x4200000000000000000000000000000000000006" as const;
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const;
const USDC_WETH_POOL = "0xd0b53D9277642d899DF5C87A3966A349A798F224" as const; // 0.05% fee
const SWAP_ROUTER_02 = "0x2626664c2603336E57B271c5C0b26F421741e481" as const;
const QUOTER_V2 = "0x3d4e44Eb1374240CE5F1B136cf394426C39B0FE9" as const;

const USDC_DECIMALS = 6;
const WETH_DECIMALS = 18;
const POOL_FEE = 500; // 0.05%

// Precomputed BigInt constants (avoids ** operator which needs tsconfig target ES2016+)
const TEN_TO_12 = BigInt("1000000000000");
const TWO_TO_192 = BigInt("6277101735386680763835789423207666416102355444464034512896");

// ── ABIs (minimal) ───────────────────────────────────────────────────────────
const ERC20_ABI = [
  {
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    name: "approve",
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "nonpayable",
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
] as const;

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
] as const;

// ── Helpers ───────────────────────────────────────────────────────────────────
function getAccount() {
  const pk = process.env.BASE_PRIVATE_KEY;
  if (!pk) throw new Error("BASE_PRIVATE_KEY not set");
  const key = (pk.startsWith("0x") ? pk : `0x${pk}`) as `0x${string}`;
  return privateKeyToAccount(key);
}

// ── Engine ────────────────────────────────────────────────────────────────────
export const baseEngine: ExecutionEngine = {
  getWallet(): string {
    return getAccount().address;
  },

  async executeTrade(args: ExecuteArgs): Promise<ExecutionReceipt> {
    const { pair, side, notionalUsd, maxSlippagePct = 0.5, reasons, mode } = args;
    const explorerPrefix =
      process.env.BASE_EXPLORER_TX_PREFIX || "https://basescan.org/tx/";
    const rpcUrl = process.env.BASE_RPC_URL || "https://mainnet.base.org";

    const isBuy = side === "BUY";
    const tokenIn = isBuy ? USDC : WETH;
    const tokenOut = isBuy ? WETH : USDC;
    const inTokenLabel = isBuy ? "USDC" : "WETH";
    const outTokenLabel = isBuy ? "WETH" : "USDC";

    try {
      const account = getAccount();
      const publicClient = createPublicClient({ chain: base, transport: http(rpcUrl) });
      const walletClient = createWalletClient({
        account,
        chain: base,
        transport: http(rpcUrl),
      });

      // Compute inAmount
      let inAmountHuman: number;
      let inAmountRaw: bigint;

      if (isBuy) {
        inAmountHuman = notionalUsd;
        inAmountRaw = parseUnits(notionalUsd.toFixed(USDC_DECIMALS), USDC_DECIMALS);
      } else {
        // SELL: convert notionalUsd → WETH using current ETH price from pool slot0
        const slot0 = await publicClient.readContract({
          address: USDC_WETH_POOL,
          abi: POOL_ABI,
          functionName: "slot0",
        });
        const sqrtPriceX96 = slot0[0] as bigint;
        const SCALE = BigInt(10000);
        const num = TEN_TO_12 * TWO_TO_192 * SCALE;
        const den = sqrtPriceX96 * sqrtPriceX96;
        const ethPrice = Number(num / den) / 10000;
        if (ethPrice <= 0) throw new Error("Could not determine ETH price from pool");
        inAmountHuman = notionalUsd / ethPrice;
        inAmountRaw = parseUnits(inAmountHuman.toFixed(8), WETH_DECIMALS);
      }

      // Quote expected output via QuoterV2 (off-chain simulation)
      let quotedOut = BigInt(0);
      try {
        const { result } = await publicClient.simulateContract({
          address: QUOTER_V2,
          abi: QUOTER_V2_ABI,
          functionName: "quoteExactInputSingle",
          args: [
            {
              tokenIn,
              tokenOut,
              amountIn: inAmountRaw,
              fee: POOL_FEE,
              sqrtPriceLimitX96: BigInt(0),
            },
          ],
        });
        quotedOut = result[0] as bigint;
      } catch {
        // quoter may fail; proceed with amountOutMinimum = 0
      }

      const slippageFactor = 1 - maxSlippagePct / 100;
      const amountOutMinimum =
        quotedOut > BigInt(0)
          ? BigInt(Math.floor(Number(quotedOut) * slippageFactor))
          : BigInt(0);

      // Approve router to spend tokenIn
      const approveTx = await walletClient.writeContract({
        address: tokenIn,
        abi: ERC20_ABI,
        functionName: "approve",
        args: [SWAP_ROUTER_02, inAmountRaw],
      });
      await publicClient.waitForTransactionReceipt({ hash: approveTx });

      // Execute swap via SwapRouter02 exactInputSingle
      const swapTx = await walletClient.writeContract({
        address: SWAP_ROUTER_02,
        abi: SWAP_ROUTER_ABI,
        functionName: "exactInputSingle",
        args: [
          {
            tokenIn,
            tokenOut,
            fee: POOL_FEE,
            recipient: account.address,
            amountIn: inAmountRaw,
            amountOutMinimum,
            sqrtPriceLimitX96: BigInt(0),
          },
        ],
      });
      const receipt = await publicClient.waitForTransactionReceipt({ hash: swapTx });

      const outDecimals = isBuy ? WETH_DECIMALS : USDC_DECIMALS;
      const outAmountHuman =
        quotedOut > BigInt(0)
          ? parseFloat(formatUnits(quotedOut, outDecimals))
          : 0;

      return {
        ok: receipt.status === "success",
        chain: "base",
        venue: "uniswap-v3",
        pair,
        side,
        notionalUsd,
        txHash: swapTx,
        explorerUrl: `${explorerPrefix}${swapTx}`,
        inToken: inTokenLabel,
        outToken: outTokenLabel,
        inAmount: inAmountHuman,
        outAmount: outAmountHuman,
        slippageBps: Math.round(maxSlippagePct * 100),
        reasons,
        mode,
        ts: Date.now(),
      };
    } catch (err: any) {
      console.error("[baseEngine] executeTrade error:", err.message);
      return {
        ok: false,
        chain: "base",
        venue: "uniswap-v3",
        pair,
        side,
        notionalUsd,
        inToken: inTokenLabel,
        outToken: outTokenLabel,
        inAmount: 0,
        outAmount: 0,
        slippageBps: Math.round(maxSlippagePct * 100),
        reasons,
        mode,
        ts: Date.now(),
        notes: err.message,
      };
    }
  },
};
