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

const USDC_DECIMALS = 6;
const PRIMARY_TOKEN_DECIMALS = 18; // standard ERC-20; update if token uses different decimals

// QuoterV2 is the same address on Base mainnet
const QUOTER_V2 = "0x3d4e44Eb1374240CE5F1B136cf394426C39B0FE9" as const;

// ── ABIs (minimal) ────────────────────────────────────────────────────────────
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

// Original Uniswap V3 SwapRouter — requires `deadline` in the params struct
const SWAP_ROUTER_V3_ABI = [
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

// ── Helpers ───────────────────────────────────────────────────────────────────
function getAccount() {
  const pk = process.env.BASE_PRIVATE_KEY;
  if (!pk) throw new Error("BASE_PRIVATE_KEY not set");
  const key = (pk.startsWith("0x") ? pk : `0x${pk}`) as `0x${string}`;
  return privateKeyToAccount(key);
}

function getEnvConfig() {
  const primaryToken = process.env.BASE_PRIMARY_TOKEN as `0x${string}`;
  if (!primaryToken) throw new Error("BASE_PRIMARY_TOKEN not set");
  const usdc = (process.env.BASE_USDC || "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913") as `0x${string}`;
  const swapRouter = (process.env.BASE_SWAP_ROUTER || "0xE592427A0AEce92De3Edee1F18E0157C05861564") as `0x${string}`;
  const poolFee = parseInt(process.env.BASE_POOL_FEE || "3000");
  return { primaryToken, usdc, swapRouter, poolFee };
}

// ── Engine ────────────────────────────────────────────────────────────────────
export const baseEngine: ExecutionEngine = {
  getWallet(): string {
    return getAccount().address;
  },

  async executeTrade(args: ExecuteArgs): Promise<ExecutionReceipt> {
    const { pair, side, notionalUsd, maxSlippagePct = 0.5, reasons, mode } = args;
    const explorerPrefix = process.env.BASE_EXPLORER_TX_PREFIX || "https://basescan.org/tx/";
    const rpcUrl = process.env.BASE_RPC_URL || "https://mainnet.base.org";
    const { primaryToken, usdc, swapRouter, poolFee } = getEnvConfig();

    const isBuy = side === "BUY";
    const tokenIn  = isBuy ? usdc : primaryToken;
    const tokenOut = isBuy ? primaryToken : usdc;
    const inTokenLabel  = isBuy ? "USDC" : "PRIMARY";
    const outTokenLabel = isBuy ? "PRIMARY" : "USDC";

    try {
      const account = getAccount();
      const publicClient = createPublicClient({ chain: base, transport: http(rpcUrl) });
      const walletClient = createWalletClient({ account, chain: base, transport: http(rpcUrl) });

      // ── Compute inAmount ───────────────────────────────────────────────────
      let inAmountHuman: number;
      let inAmountRaw: bigint;

      if (isBuy) {
        inAmountHuman = notionalUsd;
        inAmountRaw = parseUnits(notionalUsd.toFixed(USDC_DECIMALS), USDC_DECIMALS);
      } else {
        // SELL: quote how many primary tokens yield `notionalUsd` USDC out
        const usdcAmountRaw = parseUnits(notionalUsd.toFixed(USDC_DECIMALS), USDC_DECIMALS);
        let estimatedIn = BigInt(0);
        try {
          const { result } = await publicClient.simulateContract({
            address: QUOTER_V2,
            abi: QUOTER_V2_ABI,
            functionName: "quoteExactOutputSingle",
            args: [{ tokenIn: primaryToken, tokenOut: usdc, amount: usdcAmountRaw, fee: poolFee, sqrtPriceLimitX96: BigInt(0) }],
          });
          estimatedIn = result[0] as bigint;
        } catch {
          throw new Error("Could not quote SELL amount from QuoterV2 — check pool liquidity");
        }
        inAmountRaw  = estimatedIn;
        inAmountHuman = parseFloat(formatUnits(estimatedIn, PRIMARY_TOKEN_DECIMALS));
      }

      // ── Quote expected output (for slippage floor) ─────────────────────────
      let quotedOut = BigInt(0);
      try {
        const { result } = await publicClient.simulateContract({
          address: QUOTER_V2,
          abi: QUOTER_V2_ABI,
          functionName: "quoteExactInputSingle",
          args: [{ tokenIn, tokenOut, amountIn: inAmountRaw, fee: poolFee, sqrtPriceLimitX96: BigInt(0) }],
        });
        quotedOut = result[0] as bigint;
      } catch {
        // proceed with amountOutMinimum = 0
      }

      const slippageFactor = 1 - maxSlippagePct / 100;
      const amountOutMinimum =
        quotedOut > BigInt(0)
          ? BigInt(Math.floor(Number(quotedOut) * slippageFactor))
          : BigInt(0);

      // ── Approve router ─────────────────────────────────────────────────────
      const approveTx = await walletClient.writeContract({
        address: tokenIn,
        abi: ERC20_ABI,
        functionName: "approve",
        args: [swapRouter, inAmountRaw],
      });
      await publicClient.waitForTransactionReceipt({ hash: approveTx });

      // ── Swap via original V3 SwapRouter (deadline required) ────────────────
      const deadline = BigInt(Math.floor(Date.now() / 1000) + 300); // 5 min

      const swapTx = await walletClient.writeContract({
        address: swapRouter,
        abi: SWAP_ROUTER_V3_ABI,
        functionName: "exactInputSingle",
        args: [
          {
            tokenIn,
            tokenOut,
            fee: poolFee,
            recipient: account.address,
            deadline,
            amountIn: inAmountRaw,
            amountOutMinimum,
            sqrtPriceLimitX96: BigInt(0),
          },
        ],
      });
      const receipt = await publicClient.waitForTransactionReceipt({ hash: swapTx });

      const outDecimals = isBuy ? PRIMARY_TOKEN_DECIMALS : USDC_DECIMALS;
      const outAmountHuman =
        quotedOut > BigInt(0) ? parseFloat(formatUnits(quotedOut, outDecimals)) : 0;

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
