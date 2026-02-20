/**
 * Base mainnet Uniswap V3 swap execution.
 * All token addresses and config come from environment variables.
 * Safety rails: KILL_SWITCH, notional cap, in-memory cooldown.
 */
import {
  createPublicClient,
  createWalletClient,
  http,
  parseUnits,
  type Address,
} from "viem";
import { base } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { type ExecutionReceipt, type Side } from "./types";

// ── In-memory cooldown ────────────────────────────────────────────────────────
let lastTradeTs = 0;

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

// Uniswap V3 SwapRouter (ISwapRouter) – includes deadline field
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

// ── Helpers ───────────────────────────────────────────────────────────────────
function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} not set`);
  return v;
}

export function getBaseWallet(): string {
  const pk = process.env.BASE_PRIVATE_KEY;
  if (!pk) return "(BASE_PRIVATE_KEY not set)";
  const key = (pk.startsWith("0x") ? pk : `0x${pk}`) as `0x${string}`;
  return privateKeyToAccount(key).address;
}

// ── Main function ─────────────────────────────────────────────────────────────
export interface ExecuteBaseTradeArgs {
  pair: string;
  side: Side;
  notionalUsd: number;
  maxSlippageBps?: number;
  reasons: string[];
  mode: string;
}

export async function executeBaseTrade(
  args: ExecuteBaseTradeArgs
): Promise<ExecutionReceipt> {
  const { pair, side, notionalUsd, maxSlippageBps = 50, reasons, mode } = args;

  // ── Safety rails ─────────────────────────────────────────────────────────
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

  // ── Config ────────────────────────────────────────────────────────────────
  const rpcUrl = requireEnv("BASE_RPC_URL");
  const pk = requireEnv("BASE_PRIVATE_KEY");
  const primaryToken = requireEnv("BASE_PRIMARY_TOKEN") as Address;
  const usdcAddress = requireEnv("BASE_USDC") as Address;
  const swapRouter = requireEnv("BASE_SWAP_ROUTER") as Address;
  const poolFee = parseInt(process.env.BASE_POOL_FEE || "3000", 10);
  const explorerPrefix =
    process.env.BASE_EXPLORER_TX_PREFIX || "https://basescan.org/tx/";

  // BUY = USDC → primaryToken, SELL = primaryToken → USDC
  const isBuy = side === "BUY";
  const tokenIn: Address = isBuy ? usdcAddress : primaryToken;
  const tokenOut: Address = isBuy ? primaryToken : usdcAddress;
  const [baseSymbol] = pair.split("-");
  const inTokenLabel = isBuy ? "USDC" : baseSymbol;
  const outTokenLabel = isBuy ? baseSymbol : "USDC";

  // ── Clients ───────────────────────────────────────────────────────────────
  const key = (pk.startsWith("0x") ? pk : `0x${pk}`) as `0x${string}`;
  const account = privateKeyToAccount(key);
  const publicClient = createPublicClient({ chain: base, transport: http(rpcUrl) });
  const walletClient = createWalletClient({
    account,
    chain: base,
    transport: http(rpcUrl),
  });

  // ── Resolve tokenIn decimals and amountIn ────────────────────────────────
  const decimals = await publicClient.readContract({
    address: tokenIn,
    abi: ERC20_ABI,
    functionName: "decimals",
  });
  const amountIn = parseUnits(
    notionalUsd.toFixed(Number(decimals)),
    Number(decimals)
  );

  // ── Approve if allowance is insufficient ─────────────────────────────────
  const allowance = await publicClient.readContract({
    address: tokenIn,
    abi: ERC20_ABI,
    functionName: "allowance",
    args: [account.address, swapRouter],
  });
  if (allowance < amountIn) {
    const approveTx = await walletClient.writeContract({
      address: tokenIn,
      abi: ERC20_ABI,
      functionName: "approve",
      args: [swapRouter, amountIn],
    });
    await publicClient.waitForTransactionReceipt({ hash: approveTx });
  }

  // ── Execute swap ──────────────────────────────────────────────────────────
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
        amountIn,
        amountOutMinimum: BigInt(0), // v1: safety via notional cap
        sqrtPriceLimitX96: BigInt(0),
      },
    ],
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash: swapTx });

  // Record trade timestamp only after tx is submitted
  lastTradeTs = Date.now();

  return {
    ok: receipt.status === "success",
    chain: "base",
    venue: "uniswap",
    pair,
    side,
    notionalUsd,
    txHash: swapTx,
    explorerUrl: `${explorerPrefix}${swapTx}`,
    inToken: inTokenLabel,
    outToken: outTokenLabel,
    inAmount: notionalUsd,
    outAmount: 0, // v1: not decoded from logs
    slippageBps: maxSlippageBps,
    reasons,
    mode,
    ts: Date.now(),
  };
}
