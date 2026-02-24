import { type ReactNode, useMemo } from "react";
import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import { PhantomWalletAdapter } from "@solana/wallet-adapter-wallets";
import { clusterApiUrl } from "@solana/web3.js";

const DEVNET_ENDPOINT = clusterApiUrl("devnet");

/**
 * WalletProviderWrapper — wraps the app with Solana ConnectionProvider + WalletProvider.
 *
 * Phantom is the only supported adapter for Solana devnet.
 * Base chain uses raw window.ethereum (no wagmi/RainbowKit).
 *
 * Must be placed at the outermost level of the component tree (outside Router and
 * QueryClientProvider) so that useConnection() and the adapter useWallet() are
 * available anywhere in the app.
 *
 * SWAP POINT: To switch to Privy, replace ConnectionProvider + WalletProvider with
 * PrivyProvider and update use-wallet.ts internals. This component can be replaced
 * with a thin PrivyProvider wrapper.
 */
export function WalletProviderWrapper({ children }: { children: ReactNode }) {
  // Stable adapter instance — memoized to avoid recreating on every render
  const wallets = useMemo(() => [new PhantomWalletAdapter()], []);

  return (
    <ConnectionProvider endpoint={DEVNET_ENDPOINT}>
      <WalletProvider wallets={wallets} autoConnect={false}>
        {children}
      </WalletProvider>
    </ConnectionProvider>
  );
}
