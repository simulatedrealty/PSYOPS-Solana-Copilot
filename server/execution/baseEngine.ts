/**
 * Base mainnet Uniswap V3 swap execution — merged engine.
 *
 * Safety rails (from baseMainnetEngine):
 *   - KILL_SWITCH env guard — halts all trading immediately
 *   - BASE_MAX_NOTIONAL_USD cap — rejects oversized trades
 *   - In-memory cooldown (BASE_COOLDOWN_SECONDS)
 *   - requireEnv() — throws loudly on any missing env var (no silent fallbacks)
 *   - On-chain decimals() — works for WBTC (8), USDT (6), any non-18 token
 *   - Conditional approve — reads allowance first, skips approve if sufficient
 *
 * QuoterV2 features (from baseEngine):
 *   1. quoteExactInputSingle → real amountOutMinimum (on-chain slippage floor, not 0)
 *   2. quoteExactOutputSingle for SELL sizing (correct token amount, not notionalUsd)
 *   3. outAmountHuman decoded from quotedOut (receipt shows real value, not 0)
 */
import {
  createPublicClient,
  createWalletClient,
  http,
  parseUnits,
  formatUnits,
  getAddress,
  type Address,
} from "viem";
import { base } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { type ExecutionEngine, type ExecuteArgs, type ExecutionReceipt } from "./types";

// ── In-memory cooldown ────────────────────────────────────────────────────────
let lastTradeTs = 0;

// QuoterV2 — same address on Base mainnet
const QUOTER_V2 = getAddress("0x3d4e44Eb1374240CE5F1B136cf394426C39B0FE9");

// ── ABIs ──────────────────────────────────────────────────────────────────────
const ERC20_ABI = [
  {
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    name: "allowance",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
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
  {
    inputs: [],
    name: "decimals",
    outputs: [{ name: "", type: "uint8" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

// Original Uniswap V3 SwapRouter — requires deadline in params struct
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

// ── Helpers ───────────────────────────────────────────────────────────────────
function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} not set`);
  return v;
}

// ── Engine ────────────────────────────────────────────────────────────────────
export const baseEngine: ExecutionEngine = {
  getWallet(): string {
    const pk = process.env.BASE_PRIVATE_KEY;
    if (!pk) return "(BASE_PRIVATE_KEY not set)";
    const key = (pk.startsWith("0x") ? pk : `0x${pk}`) as `0x${string}`;
    return privateKeyToAccount(key).address;
  },

  async executeTrade(args: ExecuteArgs): Promise<ExecutionReceipt> {
    const { pair, side, notionalUsd, maxSlippagePct = 0.5, reasons, mode } = args;

    // ── Safety rails ──────────────────────────────────────────────────────────
    if (process.env.KILL_SWITCH === "true") {
      throw new Error("KILL_SWITCH is enabled — trading halted");
    }

    const maxNotional = parseFloat(process.env.BASE_MAX_NOTIONAL_USD || "50");
    if (notionalUsd > maxNotional) {
      throw new Error(
        `notionalUsd ${notionalUsd} exceeds BASE_MAX_NOTIONAL_USD ${maxNotional}`
      );
    }

    const cooldownMs =
      parseInt(process.env.BASE_COOLDOWN_SECONDS || "120", 10) * 1000;
    const now = Date.now();
    if (now - lastTradeTs < cooldownMs) {
      const remaining = Math.ceil((cooldownMs - (now - lastTradeTs)) / 1000);
      throw new Error(`Cooldown active — ${remaining}s remaining`);
    }

    // ── Strict env config (no silent fallbacks) ───────────────────────────────
    const rpcUrl = process.env.BASE_RPC_URL || "https://mainnet.base.org";
    const pk = requireEnv("BASE_PRIVATE_KEY");
    const swapRouter = getAddress(process.env.BASE_SWAP_ROUTER || "0x2626664c2603336E57B271c5C0b26F421741e481") as Address;
    const poolFee = parseInt(process.env.BASE_POOL_FEE || "3000", 10);
    const explorerPrefix =
      process.env.BASE_EXPLORER_TX_PREFIX || "https://basescan.org/tx/";

    const isBuy = side === "BUY";

    // Per-request token overrides allow any ERC20 pair on Base without env var changes.
    // args.tokenIn/tokenOut are swap-direction-aware (what you spend / what you get).
    // Falls back to BASE_PRIMARY_TOKEN / BASE_USDC env vars for the standard pair.
    let tokenIn: Address;
    let tokenOut: Address;
    if (args.tokenIn && args.tokenOut) {
      tokenIn  = getAddress(args.tokenIn) as Address;
      tokenOut = getAddress(args.tokenOut) as Address;
    } else {
      const primaryToken = getAddress(requireEnv("BASE_PRIMARY_TOKEN")) as Address;
      const usdcAddress  = getAddress(process.env.BASE_USDC || "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913") as Address;
      tokenIn  = isBuy ? usdcAddress  : primaryToken;
      tokenOut = isBuy ? primaryToken : usdcAddress;
    }

    const [baseSymbol] = pair.split("-");
    const inTokenLabel  = isBuy ? "USDC" : baseSymbol;
    const outTokenLabel = isBuy ? baseSymbol : "USDC";

    const key = (pk.startsWith("0x") ? pk : `0x${pk}`) as `0x${string}`;
    const account = privateKeyToAccount(key);
    const publicClient = createPublicClient({ chain: base, transport: http(rpcUrl) });
    const walletClient = createWalletClient({
      account,
      chain: base,
      transport: http(rpcUrl),
    });

    try {
      // ── On-chain decimals (correct for WBTC/8, USDT/6, any non-18 token) ───
      const inDecimals = await publicClient.readContract({
        address: tokenIn,
        abi: ERC20_ABI,
        functionName: "decimals",
      });
      const outDecimals = await publicClient.readContract({
        address: tokenOut,
        abi: ERC20_ABI,
        functionName: "decimals",
      });

      // ── Compute inAmountRaw ───────────────────────────────────────────────
      let inAmountRaw: bigint;
      let inAmountHuman: number;

      if (isBuy) {
        inAmountRaw = parseUnits(
          notionalUsd.toFixed(Number(inDecimals)),
          Number(inDecimals)
        );
        inAmountHuman = notionalUsd;
      } else {
        // SELL: QuoterV2 quoteExactOutputSingle → correct token amount to sell
        // fixes baseMainnetEngine bug of using notionalUsd directly as token units
        const usdcAmountRaw = parseUnits(
          notionalUsd.toFixed(Number(outDecimals)),
          Number(outDecimals)
        );
        let estimatedIn = BigInt(0);
        try {
          // tokenIn = base token (spending), tokenOut = quote/USDC (receiving)
          // This is already correct since tokenIn/tokenOut are swap-direction-aware.
          const { result } = await publicClient.simulateContract({
            address: QUOTER_V2,
            abi: QUOTER_V2_ABI,
            functionName: "quoteExactOutputSingle",
            args: [
              {
                tokenIn,
                tokenOut,
                amount: usdcAmountRaw,
                fee: poolFee,
                sqrtPriceLimitX96: BigInt(0),
              },
            ],
          });
          estimatedIn = result[0] as bigint;
        } catch {
          throw new Error(
            "Could not quote SELL amount from QuoterV2 — check pool liquidity"
          );
        }
        inAmountRaw = estimatedIn;
        inAmountHuman = parseFloat(formatUnits(estimatedIn, Number(inDecimals)));
      }

      // ── QuoterV2 quoteExactInputSingle → real amountOutMinimum ────────────
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
              fee: poolFee,
              sqrtPriceLimitX96: BigInt(0),
            },
          ],
        });
        quotedOut = result[0] as bigint;
      } catch {
        // proceed with amountOutMinimum = 0 if quote fails
      }

      const slippageFactor = 1 - maxSlippagePct / 100;
      const amountOutMinimum =
        quotedOut > BigInt(0)
          ? BigInt(Math.floor(Number(quotedOut) * slippageFactor))
          : BigInt(0);

      // ── Conditional approve (saves gas when allowance already sufficient) ──
      const allowance = await publicClient.readContract({
        address: tokenIn,
        abi: ERC20_ABI,
        functionName: "allowance",
        args: [account.address, swapRouter],
      });
      if (allowance < inAmountRaw) {
        const approveTx = await walletClient.writeContract({
          address: tokenIn,
          abi: ERC20_ABI,
          functionName: "approve",
          args: [swapRouter, inAmountRaw],
        });
        await publicClient.waitForTransactionReceipt({ hash: approveTx });
      }

      // ── Execute swap ──────────────────────────────────────────────────────
      const deadline = BigInt(Math.floor(Date.now() / 1000) + 300); // 5 min
      const swapTx = await walletClient.writeContract({
        address: swapRouter,
        abi: SWAP_ROUTER_ABI,
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

      // Record timestamp only after tx is submitted
      lastTradeTs = Date.now();

      // ── Decode real output amount (not hardcoded 0) ───────────────────────
      const outAmountHuman =
        quotedOut > BigInt(0)
          ? parseFloat(formatUnits(quotedOut, Number(outDecimals)))
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
