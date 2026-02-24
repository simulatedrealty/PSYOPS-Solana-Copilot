// SWAP POINT: Replace this file's internals with Privy SDK to get embedded wallets,
// social login, and cross-chain identity. The useWallet() interface stays the same.
//
// To swap in Privy:
//   1. npm install @privy-io/react-auth
//   2. Replace useSolanaWallet/useConnection with usePrivy() and useSolanaWallets()
//   3. Replace window.ethereum logic with privy.connectWallet()
//   4. The WalletState interface and all callers remain unchanged.

import { useState, useCallback, useEffect } from "react";
import {
  useWallet as useSolanaWallet,
  useConnection,
} from "@solana/wallet-adapter-react";
import { VersionedTransaction } from "@solana/web3.js";
import {
  createPublicClient,
  createWalletClient,
  custom,
  http,
  formatEther,
} from "viem";
import { base } from "viem/chains";

export interface WalletState {
  address: string | null;
  chain: "solana-devnet" | "base" | null;
  balance: number | null;
  connected: boolean;
  connect: (chain: "solana-devnet" | "base") => Promise<void>;
  disconnect: () => void;
  signTransaction: (tx: unknown) => Promise<string>; // returns tx hash / signature
}

export function useWallet(): WalletState {
  const solanaWallet = useSolanaWallet();
  const { connection } = useConnection();
  const [chain, setChain] = useState<"solana-devnet" | "base" | null>(null);
  const [baseAddress, setBaseAddress] = useState<string | null>(null);
  const [balance, setBalance] = useState<number | null>(null);

  const connected =
    chain === "solana-devnet"
      ? solanaWallet.connected
      : chain === "base"
      ? !!baseAddress
      : false;

  const address =
    chain === "solana-devnet"
      ? (solanaWallet.publicKey?.toBase58() ?? null)
      : baseAddress;

  // Fetch on-chain balance whenever connection state changes
  useEffect(() => {
    if (!connected || !address) {
      setBalance(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        if (chain === "solana-devnet" && solanaWallet.publicKey) {
          const lamports = await connection.getBalance(solanaWallet.publicKey);
          if (!cancelled) setBalance(lamports / 1e9);
        } else if (chain === "base" && baseAddress) {
          const pc = createPublicClient({ chain: base, transport: http() });
          const wei = await pc.getBalance({ address: baseAddress as `0x${string}` });
          if (!cancelled) setBalance(parseFloat(formatEther(wei)));
        }
      } catch {
        if (!cancelled) setBalance(null);
      }
    })();
    return () => { cancelled = true; };
  }, [connected, address, chain, solanaWallet.publicKey, baseAddress, connection]);

  const connect = useCallback(
    async (targetChain: "solana-devnet" | "base") => {
      if (targetChain === "solana-devnet") {
        // Select Phantom adapter if no wallet is currently selected
        if (!solanaWallet.wallet) {
          solanaWallet.select("Phantom" as Parameters<typeof solanaWallet.select>[0]);
        }
        await solanaWallet.connect();
        setChain("solana-devnet");
      } else {
        const eth = (window as { ethereum?: unknown }).ethereum;
        if (!eth) {
          throw new Error(
            "Install MetaMask or Coinbase Wallet to trade on Base"
          );
        }
        const accounts = await (eth as { request: (args: { method: string }) => Promise<string[]> }).request({
          method: "eth_requestAccounts",
        });
        setBaseAddress(accounts[0]);
        setChain("base");
      }
    },
    [solanaWallet]
  );

  const disconnect = useCallback(() => {
    if (chain === "solana-devnet") {
      solanaWallet.disconnect();
    }
    setChain(null);
    setBaseAddress(null);
    setBalance(null);
  }, [chain, solanaWallet]);

  const signTransaction = useCallback(
    async (tx: unknown): Promise<string> => {
      if (chain === "solana-devnet") {
        // tx is { serializedTransaction: string } — base64 unsigned VersionedTransaction from Jupiter
        const payload = tx as { serializedTransaction: string };
        const bytes = Buffer.from(payload.serializedTransaction, "base64");
        const vt = VersionedTransaction.deserialize(bytes);
        const sig = await solanaWallet.sendTransaction(vt, connection);
        return sig;
      } else if (chain === "base") {
        // tx is { steps: [{to, data, value, description}] } — approve + swap steps from server
        const eth = (window as { ethereum?: unknown }).ethereum;
        if (!eth) throw new Error("window.ethereum not found");
        const wc = createWalletClient({
          transport: custom(eth as Parameters<typeof custom>[0]),
          chain: base,
        });
        const [account] = await wc.getAddresses();
        const payload = tx as { steps: Array<{ to: string; data: string; value: string }> };
        let lastHash = "";
        for (const step of payload.steps) {
          lastHash = await wc.sendTransaction({
            account,
            to: step.to as `0x${string}`,
            data: step.data as `0x${string}`,
            value: BigInt(step.value || 0),
          });
        }
        return lastHash;
      }
      throw new Error("No wallet connected");
    },
    [chain, solanaWallet, connection]
  );

  return { address, chain, balance, connected, connect, disconnect, signTransaction };
}
