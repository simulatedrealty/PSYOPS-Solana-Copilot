import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Wallet, LogOut, Loader2 } from "lucide-react";
import { useWallet } from "@/hooks/use-wallet";
import { useToast } from "@/hooks/use-toast";

interface WalletButtonProps {
  chain: "solana-devnet" | "base";
}

/**
 * WalletButton — connect/disconnect UI for browser wallets.
 *
 * - Disconnected: shows "Connect Wallet" button
 * - Connected (this chain): shows truncated address + balance + disconnect button
 * - Connected (other chain): shows "Connect Wallet" (switches chains on click)
 *
 * Solana styling: purple. Base styling: blue.
 */
export function WalletButton({ chain }: WalletButtonProps) {
  const wallet = useWallet();
  const { toast } = useToast();
  const [connecting, setConnecting] = useState(false);

  const isSolana = chain === "solana-devnet";
  const activeForChain = wallet.connected && wallet.chain === chain;

  const chainColorClass = isSolana
    ? "bg-purple-500/10 text-purple-600 dark:text-purple-400 border-purple-500/20 hover:bg-purple-500/20"
    : "bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/20 hover:bg-blue-500/20";

  const handleConnect = async () => {
    setConnecting(true);
    try {
      // Disconnect from the other chain first if needed
      if (wallet.connected && wallet.chain !== chain) {
        wallet.disconnect();
      }
      await wallet.connect(chain);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Failed to connect wallet";
      toast({
        title: "Wallet Error",
        description: message,
        variant: "destructive",
      });
    } finally {
      setConnecting(false);
    }
  };

  if (activeForChain && wallet.address) {
    const shortAddr = `${wallet.address.slice(0, 4)}...${wallet.address.slice(-4)}`;
    const balanceLabel =
      wallet.balance !== null
        ? `${wallet.balance.toFixed(3)} ${isSolana ? "SOL" : "ETH"}`
        : null;

    return (
      <div className="flex items-center gap-1" data-testid="wallet-connected">
        <Badge
          variant="outline"
          className={`gap-1 font-mono text-[11px] ${chainColorClass}`}
          data-testid="badge-wallet-address"
        >
          <Wallet className="w-3 h-3" />
          {shortAddr}
          {balanceLabel && (
            <span className="opacity-70">{balanceLabel}</span>
          )}
        </Badge>
        <Button
          size="sm"
          variant="ghost"
          className="h-6 w-6 p-0 text-muted-foreground hover:text-foreground"
          onClick={() => wallet.disconnect()}
          title="Disconnect wallet"
          data-testid="button-disconnect-wallet"
        >
          <LogOut className="w-3 h-3" />
        </Button>
      </div>
    );
  }

  return (
    <Button
      size="sm"
      variant="outline"
      className={`h-7 text-xs gap-1 ${chainColorClass}`}
      onClick={handleConnect}
      disabled={connecting}
      data-testid="button-connect-wallet"
    >
      {connecting ? (
        <Loader2 className="w-3 h-3 animate-spin" />
      ) : (
        <Wallet className="w-3 h-3" />
      )}
      Connect Wallet
    </Button>
  );
}
