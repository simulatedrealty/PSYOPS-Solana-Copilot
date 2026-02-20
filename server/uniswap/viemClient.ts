import { createPublicClient, http, type PublicClient } from "viem";
import { mainnet } from "viem/chains";

let publicClient: PublicClient | null = null;

/**
 * Returns a singleton viem PublicClient connected to Ethereum mainnet.
 * Used for reading Uniswap v3 pool data and gas prices on-chain.
 * Set ETHEREUM_RPC_URL env var to override the default public RPC.
 */
export function getViemClient(): PublicClient {
  if (publicClient) return publicClient;
  const rpcUrl = process.env.ETHEREUM_RPC_URL || "https://eth.llamarpc.com";
  publicClient = createPublicClient({
    chain: mainnet,
    transport: http(rpcUrl),
  }) as PublicClient;
  console.log("[viemClient] Initialized Ethereum mainnet client via", rpcUrl);
  return publicClient;
}
