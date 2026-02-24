import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import type { TradingState, TradingConfig } from "@/lib/types";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useToast } from "@/hooks/use-toast";
import { useWallet } from "@/hooks/use-wallet";
import { WalletButton } from "@/components/wallet-button";
import { Switch } from "@/components/ui/switch";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  Activity,
  TrendingUp,
  TrendingDown,
  Minus,
  Play,
  Square,
  Zap,
  ShieldCheck,
  ShieldAlert,
  ExternalLink,
  ArrowUpCircle,
  ArrowDownCircle,
  DollarSign,
  BarChart3,
  Clock,
  Brain,
  Receipt,
  FileText,
  Wallet,
  Search,
} from "lucide-react";

function SignalBadge({ signal }: { signal: string | null }) {
  if (!signal) return <Badge variant="secondary">N/A</Badge>;
  const variants: Record<string, { className: string; icon: React.ReactNode }> = {
    BUY:  { className: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30", icon: <TrendingUp className="w-3 h-3" /> },
    SELL: { className: "bg-red-500/15 text-red-600 dark:text-red-400 border-red-500/30",               icon: <TrendingDown className="w-3 h-3" /> },
    HOLD: { className: "bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/30",       icon: <Minus className="w-3 h-3" /> },
  };
  const v = variants[signal] || variants.HOLD;
  return (
    <Badge variant="outline" className={v.className} data-testid={`badge-signal-${signal.toLowerCase()}`}>
      {v.icon}
      <span className="ml-1">{signal}</span>
    </Badge>
  );
}

function RiskIndicator({ allowed, checks }: { allowed: boolean; checks: TradingState["riskChecks"] }) {
  const allChecks = [
    { label: "Cooldown",     ok: checks.cooldownOK },
    { label: "Max Notional", ok: checks.maxNotionalOK },
    { label: "Daily Loss",   ok: checks.maxDailyLossOK },
    { label: "Slippage",     ok: checks.slippageOK },
  ];
  return (
    <div className="space-y-2" data-testid="risk-indicator">
      <div className="flex items-center gap-2">
        {allowed ? <ShieldCheck className="w-4 h-4 text-emerald-500" /> : <ShieldAlert className="w-4 h-4 text-red-500" />}
        <span className="text-sm font-medium">{allowed ? "Risk Allowed" : "Risk Blocked"}</span>
      </div>
      <div className="grid grid-cols-2 gap-1">
        {allChecks.map((c) => (
          <div key={c.label} className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <div className={`w-1.5 h-1.5 rounded-full ${c.ok ? "bg-emerald-500" : "bg-red-500"}`} />
            {c.label}
          </div>
        ))}
      </div>
    </div>
  );
}

function ConfidenceMeter({ value }: { value: number | null }) {
  const pct   = value != null ? Math.round(value * 100) : 0;
  const color = pct >= 70 ? "bg-emerald-500" : pct >= 40 ? "bg-amber-500" : "bg-red-500";
  return (
    <div className="space-y-1" data-testid="confidence-meter">
      <div className="flex items-center justify-between text-xs">
        <span className="text-muted-foreground">Confidence</span>
        <span className="font-mono font-medium">{value != null ? `${pct}%` : "N/A"}</span>
      </div>
      <div className="h-1.5 bg-muted rounded-full overflow-hidden">
        <div className={`h-full rounded-full transition-all duration-500 ${color}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function PriceDisplay({ price, label }: { price: number | null; label: string }) {
  return (
    <div className="text-center">
      <div className="text-xs text-muted-foreground mb-0.5">{label}</div>
      <div className="font-mono text-sm font-medium" data-testid={`text-price-${label.toLowerCase().replace(" ", "-")}`}>
        {price != null ? `$${price.toFixed(2)}` : "--"}
      </div>
    </div>
  );
}

export default function Dashboard() {
  const { toast } = useToast();
  const wallet = useWallet();

  // Base token address input — for trading any ERC20 token on Base
  const [baseTokenInput, setBaseTokenInput] = useState("");

  const { data: state, isLoading } = useQuery<TradingState>({
    queryKey: ["/api/ui/state"],
    refetchInterval: 2000,
    staleTime: 1000,
  });

  const { data: config } = useQuery<TradingConfig>({
    queryKey: ["/api/ui/config"],
    staleTime: 30000,
  });

  // Server is source of truth for active chain — read from state
  const activeChain = state?.activeChain ?? "solana-devnet";
  const walletConnected = wallet.connected && wallet.chain === activeChain;

  // set-chain mutation — updates server active chain/pair/tokens and resets rolling prices
  const setChainMutation = useMutation({
    mutationFn: (body: {
      chain: "solana-devnet" | "base";
      pair?: string;
      baseToken?: string;
      quoteToken?: string;
    }) => apiRequest("POST", "/api/ui/set-chain", body),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/ui/state"] }),
    onError: () => toast({ title: "Error", description: "Failed to switch chain.", variant: "destructive" }),
  });

  const startMutation = useMutation({
    mutationFn: () => apiRequest("POST", "/api/ui/start"),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/ui/state"] });
      toast({ title: "Agent Started", description: "Autonomous trading loop is now running." });
    },
    onError: () => toast({ title: "Error", description: "Failed to start agent.", variant: "destructive" }),
  });

  const stopMutation = useMutation({
    mutationFn: () => apiRequest("POST", "/api/ui/stop"),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/ui/state"] });
      toast({ title: "Agent Stopped", description: "Trading loop has been stopped." });
    },
    onError: () => toast({ title: "Error", description: "Failed to stop agent.", variant: "destructive" }),
  });

  const paperModeMutation = useMutation({
    mutationFn: (enabled: boolean) => apiRequest("POST", "/api/ui/paper-mode", { enabled }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/ui/state"] }),
    onError: () => toast({ title: "Error", description: "Failed to toggle paper mode.", variant: "destructive" }),
  });

  const executeMutation = useMutation({
    mutationFn: (side: "BUY" | "SELL") => apiRequest("POST", "/api/ui/execute-now", { side }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/ui/state"] });
      toast({ title: "Trade Executed", description: "Paper trade has been executed." });
    },
    onError: (err: any) =>
      toast({ title: "Trade Failed", description: err?.message || "Trade execution failed.", variant: "destructive" }),
  });

  // Live trading flow: build unsigned tx → wallet signs → server verifies
  const liveTradeMutation = useMutation({
    mutationFn: async (side: "BUY" | "SELL") => {
      if (!wallet.address) throw new Error("Wallet not connected");
      const activePair = state?.activePair ?? "SOL-USDC";
      const buildResult = await apiRequest("POST", "/api/ui/build-transaction", {
        chain: activeChain,
        pair: activePair,
        side,
        notional: config?.maxNotional ?? 20,
        walletAddress: wallet.address,
      });
      const txHash = await wallet.signTransaction(buildResult);
      return apiRequest("POST", "/api/ui/confirm-transaction", {
        chain: activeChain,
        txHash,
        walletAddress: wallet.address,
        pair: activePair,
        side,
        notional: config?.maxNotional ?? 20,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/ui/state"] });
      toast({ title: "Trade Executed", description: "Live trade confirmed on-chain." });
    },
    onError: (err: any) =>
      toast({ title: "Trade Failed", description: err?.message || "Live trade failed.", variant: "destructive" }),
  });

  if (isLoading || !state) {
    return (
      <div className="p-4 md:p-6 space-y-4 max-w-7xl mx-auto">
        <div className="flex items-center gap-3 mb-6">
          <Skeleton className="h-8 w-8 rounded-md" />
          <Skeleton className="h-8 w-64" />
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {Array.from({ length: 6 }).map((_, i) => (
            <Card key={i}><CardContent className="p-4"><Skeleton className="h-24 w-full" /></CardContent></Card>
          ))}
        </div>
      </div>
    );
  }

  const receipts = state.receipts || [];
  const recentReceipts = receipts.slice(-10).reverse();

  const chainWallet      = activeChain === "base" ? state.baseWallet : state.solanaWallet;
  const baseUnconfigured = !!state.baseWallet?.startsWith("(");

  const handleChainToggle = (v: string) => {
    if (!v) return;
    const newChain = v as "solana-devnet" | "base";
    setChainMutation.mutate({ chain: newChain });
    // If wallet is on the other chain, also auto-connect or show button
    if (wallet.connected && wallet.chain !== newChain) {
      wallet.disconnect();
    }
  };

  const handleBaseTokenApply = () => {
    const addr = baseTokenInput.trim();
    if (!addr) return;
    setChainMutation.mutate({ chain: "base", baseToken: addr });
  };

  return (
    <div className="p-4 md:p-6 space-y-4 max-w-7xl mx-auto">
      {/* ── Header ── */}
      <div className="flex flex-wrap items-center justify-between gap-3 mb-2">
        <div className="flex items-center gap-3">
          <div className="flex items-center justify-center w-9 h-9 rounded-md bg-primary/10">
            <Activity className="w-5 h-5 text-primary" />
          </div>
          <div>
            <h1 className="text-xl font-semibold tracking-tight">PSYOPS — Multi-Chain Trading Copilot</h1>
            <p className="text-xs text-muted-foreground">
              {state.paperMode ? "Paper Mode" : "Live Mode"} &middot;{" "}
              {activeChain === "base" ? "Base Mainnet" : "Devnet"} &middot;{" "}
              <span className="font-mono">{state.activePair}</span>
              {chainWallet && (
                <>
                  {" "}&middot;{" "}
                  <a
                    href={
                      activeChain === "base"
                        ? `https://basescan.org/address/${chainWallet}`
                        : `https://explorer.solana.com/address/${chainWallet}?cluster=devnet`
                    }
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-primary hover:underline font-mono"
                    data-testid="link-wallet-explorer"
                  >
                    {chainWallet.slice(0, 6)}...{chainWallet.slice(-4)}
                  </a>
                  {activeChain === "solana-devnet" && state.walletBalance !== null && state.walletBalance !== undefined && (
                    <span className="text-muted-foreground" data-testid="text-wallet-balance">
                      {" "}({state.walletBalance.toFixed(4)} SOL)
                    </span>
                  )}
                  {activeChain === "solana-devnet" && state.walletBalance === 0 && (
                    <>
                      {" "}&middot;{" "}
                      <a
                        href={`https://faucet.solana.com/?address=${chainWallet}&network=devnet`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-primary hover:underline inline-flex items-center gap-1"
                        data-testid="link-fund-wallet"
                      >
                        <Wallet className="w-3 h-3" />
                        Fund Wallet
                      </a>
                    </>
                  )}
                </>
              )}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-3 flex-wrap">
          {/* Chain toggle — fires set-chain on server */}
          <ToggleGroup
            type="single"
            value={activeChain}
            onValueChange={handleChainToggle}
            data-testid="toggle-chain"
          >
            <ToggleGroupItem
              value="solana-devnet"
              className="text-xs px-2 h-7 data-[state=on]:bg-purple-500/20 data-[state=on]:text-purple-600 dark:data-[state=on]:text-purple-400"
              data-testid="toggle-chain-solana"
            >
              Solana
            </ToggleGroupItem>
            <ToggleGroupItem
              value="base"
              className="text-xs px-2 h-7 data-[state=on]:bg-blue-500/20 data-[state=on]:text-blue-600 dark:data-[state=on]:text-blue-400"
              data-testid="toggle-chain-base"
            >
              Base
            </ToggleGroupItem>
          </ToggleGroup>

          <WalletButton chain={activeChain} />

          <div className="h-5 w-px bg-border" />

          {!walletConnected && (
            <div className="flex items-center gap-2">
              <FileText className="w-3.5 h-3.5 text-muted-foreground" />
              <span className="text-xs text-muted-foreground">Paper</span>
              <Switch
                checked={state.paperMode}
                onCheckedChange={(checked) => paperModeMutation.mutate(checked)}
                disabled={paperModeMutation.isPending || state.running}
                data-testid="switch-paper-mode"
              />
            </div>
          )}
          {walletConnected && (
            <Badge
              variant="outline"
              className="bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30"
              data-testid="badge-live-trading"
            >
              ● Live Trading
            </Badge>
          )}

          <div className="h-5 w-px bg-border" />

          <Badge variant={state.running ? "default" : "secondary"} data-testid="badge-agent-status">
            {state.running ? "Agent Running" : "Agent Stopped"}
          </Badge>
          {state.running ? (
            <Button size="sm" variant="outline" onClick={() => stopMutation.mutate()} disabled={stopMutation.isPending} data-testid="button-stop">
              <Square className="w-3.5 h-3.5 mr-1.5" />
              Stop
            </Button>
          ) : (
            <Button size="sm" onClick={() => startMutation.mutate()} disabled={startMutation.isPending} data-testid="button-start">
              <Play className="w-3.5 h-3.5 mr-1.5" />
              Start
            </Button>
          )}
        </div>
      </div>

      {/* ── Base token address input — any ERC20 on Base ── */}
      {activeChain === "base" && (
        <div className="flex items-center gap-2 rounded-md border border-blue-500/20 bg-blue-500/5 px-3 py-2" data-testid="panel-base-token">
          <Search className="w-3.5 h-3.5 text-blue-500/70 shrink-0" />
          <span className="text-xs text-muted-foreground whitespace-nowrap">Base token:</span>
          <Input
            className="h-6 text-xs font-mono border-0 bg-transparent shadow-none focus-visible:ring-0 px-1 min-w-0"
            placeholder="0x… contract address"
            value={baseTokenInput}
            onChange={(e) => setBaseTokenInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleBaseTokenApply()}
            data-testid="input-base-token"
          />
          <Button
            size="sm"
            variant="outline"
            className="h-6 px-2 text-xs shrink-0"
            onClick={handleBaseTokenApply}
            disabled={setChainMutation.isPending || !baseTokenInput.trim()}
            data-testid="button-base-token-apply"
          >
            Apply
          </Button>
          {state.activeTokens?.base && !state.activeTokens.base.startsWith("0x0000") && (
            <span className="text-[10px] font-mono text-muted-foreground truncate max-w-[120px]" title={state.activeTokens.base}>
              {state.activeTokens.base.slice(0, 6)}…{state.activeTokens.base.slice(-4)}
            </span>
          )}
        </div>
      )}

      {/* ── Base unconfigured banner ── */}
      {activeChain === "base" && baseUnconfigured && (
        <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-600 dark:text-amber-400" data-testid="banner-base-unconfigured">
          Base chain not configured — set BASE_PRIVATE_KEY, BASE_RPC_URL, BASE_PRIMARY_TOKEN, BASE_USDC, BASE_SWAP_ROUTER env vars to enable Base trading.
        </div>
      )}

      {/* ── Cards grid ── */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Market Price</CardTitle>
            <BarChart3 className="w-4 h-4 text-muted-foreground" />
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="text-2xl font-mono font-bold tracking-tight" data-testid="text-implied-price">
              {state.impliedPrice != null ? `$${state.impliedPrice.toFixed(2)}` : "Fetching..."}
            </div>
            <div className="flex items-center justify-between gap-2">
              <PriceDisplay price={state.rollingLow}  label="Rolling Low" />
              <div className="h-6 w-px bg-border" />
              <PriceDisplay price={state.rollingHigh} label="Rolling High" />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Signal & Decision</CardTitle>
            <Brain className="w-4 h-4 text-muted-foreground" />
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex items-center gap-3">
              <SignalBadge signal={state.signal} />
              {state.strength != null && (
                <span className="text-xs text-muted-foreground font-mono">
                  str: {state.strength.toFixed(2)}
                </span>
              )}
            </div>
            <ConfidenceMeter value={state.confidence} />
            {state.reasons.length > 0 && (
              <div className="space-y-1">
                {state.reasons.map((r, i) => (
                  <div key={i} className="flex items-start gap-1.5 text-xs text-muted-foreground">
                    <Zap className="w-3 h-3 mt-0.5 shrink-0 text-primary/60" />
                    <span>{r}</span>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Risk Status</CardTitle>
            {state.riskAllowed ? (
              <ShieldCheck className="w-4 h-4 text-emerald-500" />
            ) : (
              <ShieldAlert className="w-4 h-4 text-red-500" />
            )}
          </CardHeader>
          <CardContent>
            <RiskIndicator allowed={state.riskAllowed} checks={state.riskChecks} />
            {config && (
              <div className="mt-3 pt-3 border-t text-xs text-muted-foreground space-y-0.5">
                <div className="flex justify-between"><span>Max Notional</span><span className="font-mono">${config.maxNotional}</span></div>
                <div className="flex justify-between"><span>Max Slippage</span><span className="font-mono">{config.maxSlippageBps}bps</span></div>
                <div className="flex justify-between"><span>Cooldown</span><span className="font-mono">{config.cooldownSec}s</span></div>
                <div className="flex justify-between"><span>Max Daily Loss</span><span className="font-mono">${config.maxDailyLoss}</span></div>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Paper Portfolio</CardTitle>
            <DollarSign className="w-4 h-4 text-muted-foreground" />
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid grid-cols-3 gap-3">
              <div>
                <div className="text-xs text-muted-foreground mb-0.5">Position</div>
                <div className="font-mono text-sm font-medium" data-testid="text-position">
                  {state.paperPosition.toFixed(4)}
                </div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground mb-0.5">USDC</div>
                <div className="font-mono text-sm font-medium" data-testid="text-usdc">
                  ${state.paperUSDC.toFixed(2)}
                </div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground mb-0.5">PnL</div>
                <div
                  className={`font-mono text-sm font-medium ${state.paperPnL >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400"}`}
                  data-testid="text-pnl"
                >
                  {state.paperPnL >= 0 ? "+" : ""}${state.paperPnL.toFixed(2)}
                </div>
              </div>
            </div>
            {state.lastAction && (
              <div className="flex items-center gap-2 text-xs text-muted-foreground pt-1 border-t">
                <Clock className="w-3 h-3" />
                Last: {state.lastAction.side} @ ${state.lastAction.price.toFixed(2)}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Manual Controls</CardTitle>
            <Zap className="w-4 h-4 text-muted-foreground" />
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-xs text-muted-foreground">
              {walletConnected
                ? "Execute a live trade using your connected wallet."
                : "Execute a paper trade manually using the current market price."}
            </p>
            <div className="flex items-center gap-2">
              <Button
                className="flex-1 bg-emerald-600 hover:bg-emerald-700 text-white"
                onClick={() => walletConnected ? liveTradeMutation.mutate("BUY") : executeMutation.mutate("BUY")}
                disabled={executeMutation.isPending || liveTradeMutation.isPending}
                data-testid="button-manual-buy"
              >
                <ArrowUpCircle className="w-4 h-4 mr-1.5" />
                Buy
              </Button>
              <Button
                className="flex-1 bg-red-600 hover:bg-red-700 text-white"
                onClick={() => walletConnected ? liveTradeMutation.mutate("SELL") : executeMutation.mutate("SELL")}
                disabled={executeMutation.isPending || liveTradeMutation.isPending}
                data-testid="button-manual-sell"
              >
                <ArrowDownCircle className="w-4 h-4 mr-1.5" />
                Sell
              </Button>
            </div>
          </CardContent>
        </Card>

        <Card className="md:col-span-2 lg:col-span-1">
          <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Recent Receipts</CardTitle>
            <Receipt className="w-4 h-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            {recentReceipts.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-6 text-muted-foreground">
                <Receipt className="w-8 h-8 mb-2 opacity-30" />
                <p className="text-xs">No trades yet</p>
              </div>
            ) : (
              <ScrollArea className="h-[200px]">
                <div className="space-y-2">
                  {recentReceipts.map((r) => (
                    <div
                      key={r.id}
                      className="flex items-center justify-between gap-2 p-2 rounded-md bg-muted/40 text-xs"
                      data-testid={`receipt-${r.id}`}
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <Badge
                          variant="outline"
                          className={
                            r.side === "BUY"
                              ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20"
                              : "bg-red-500/10 text-red-600 dark:text-red-400 border-red-500/20"
                          }
                        >
                          {r.side}
                        </Badge>
                        <span className="font-mono truncate">${r.fillPrice.toFixed(2)}</span>
                        <span className="text-muted-foreground">N={r.notional}</span>
                      </div>
                      <div className="flex items-center gap-1.5 shrink-0">
                        <span className="font-mono text-muted-foreground">
                          {Math.round(r.confidence * 100)}%
                        </span>
                        {r.memoTxid && r.memoTxid !== "N/A" ? (
                          <a
                            href={
                              activeChain === "base"
                                ? `https://basescan.org/tx/${r.memoTxid}`
                                : `https://explorer.solana.com/tx/${r.memoTxid}?cluster=devnet`
                            }
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-primary hover:text-primary/80"
                            data-testid={`link-explorer-${r.id}`}
                          >
                            <ExternalLink className="w-3 h-3" />
                          </a>
                        ) : (
                          <Badge variant="outline" className="text-[10px] px-1 py-0 text-muted-foreground border-muted-foreground/20">
                            off-chain
                          </Badge>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </ScrollArea>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
