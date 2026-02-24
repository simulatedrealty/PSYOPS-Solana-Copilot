import type { Express } from "express";
import { createServer, type Server } from "http";
import { sharedState, getPubkey, getConnection } from "./engine/state";
import { initAgentKit } from "./engine/agentKit";
import { getConfig } from "./engine/config";
import { getMarket, getSignal, getReceipts, getReceiptById } from "./engine/tradingEngine";
import { updateRollingPrices } from "./engine/signal";
import { checkRisk } from "./engine/risk";
import { startLoop, stopLoop } from "./engine/loop";
import { manifest, invoke } from "./skills/tradingSkill";
import { listReceipts } from "./receipts/store";
import { handleTrade } from "./execution/handler";
import { getEngine } from "./execution/getEngine";

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {
  let cachedBalance: number | null = null;
  let lastBalanceCheck = 0;

  app.get("/api/ui/state", async (_req, res) => {
    const receipts = getReceipts();
    const now = Date.now();

    if (now - lastBalanceCheck > 30000) {
      try {
        const balance = await getConnection().getBalance(initAgentKit().wallet_address);
        cachedBalance = balance / 1e9;
        lastBalanceCheck = now;
      } catch {}
    }

    res.json({
      running: sharedState.running,
      paperMode: sharedState.paperMode,
      walletAddress: getPubkey(),
      walletBalance: cachedBalance,
      activeChains: ["solana-devnet", "base"],
      solanaWallet: getEngine("solana-devnet").getWallet(),
      baseWallet: getEngine("base").getWallet(),
      pair: getConfig().pair,
      impliedPrice: sharedState.lastImpliedPrice,
      rollingHigh: sharedState.rollingPrices.length > 0 ? Math.max(...sharedState.rollingPrices) : null,
      rollingLow: sharedState.rollingPrices.length > 0 ? Math.min(...sharedState.rollingPrices) : null,
      signal: sharedState.lastSignal,
      strength: sharedState.lastStrength,
      confidence: sharedState.lastConfidence,
      reasons: sharedState.lastReasons,
      riskAllowed: sharedState.lastRiskAllowed,
      riskChecks: sharedState.lastRiskChecks,
      paperPosition: sharedState.paperPosition,
      paperUSDC: sharedState.paperUSDC,
      paperPnL: sharedState.paperPnL,
      lastAction: sharedState.tradeHistory.length > 0
        ? sharedState.tradeHistory[sharedState.tradeHistory.length - 1]
        : null,
      lastTxHash: sharedState.lastTxHash,
      lastExplorerUrl: sharedState.lastExplorerUrl,
      totalTrades: receipts.length,
      receipts,
    });
  });

  app.post("/api/ui/start", (_req, res) => {
    startLoop();
    res.json({ status: "started" });
  });

  app.post("/api/ui/stop", (_req, res) => {
    stopLoop();
    res.json({ status: "stopped" });
  });

  app.get("/api/ui/config", (_req, res) => {
    res.json(getConfig());
  });

  app.post("/api/ui/paper-mode", (req, res) => {
    const { enabled } = req.body;
    if (typeof enabled !== "boolean") {
      return res.status(400).json({ error: "enabled must be a boolean" });
    }
    sharedState.paperMode = enabled;
    res.json({ paperMode: sharedState.paperMode });
  });

  app.post("/api/ui/execute-now", async (req, res) => {
    try {
      const side = req.body.side as "BUY" | "SELL";
      if (!side || !["BUY", "SELL"].includes(side)) {
        return res.status(400).json({ error: "side must be BUY or SELL" });
      }
      const chain = req.body.chain === "base" ? "base" : "solana-devnet";
      const cfg = getConfig();
      const market = await getMarket(cfg.pair);
      if (market.impliedPrice > 0) {
        updateRollingPrices(market.impliedPrice);
        sharedState.lastImpliedPrice = market.impliedPrice;
      }
      const risk = checkRisk(cfg.maxNotional, market.slippageBps, cfg);
      sharedState.lastRiskAllowed = risk.allowed;
      sharedState.lastRiskChecks = risk.checks;
      if (!risk.allowed) {
        return res.status(400).json({
          error: "Trade blocked by risk checks",
          checks: risk.checks,
        });
      }
      const result = await handleTrade({
        chain,
        pair: cfg.pair,
        side,
        notionalUsd: cfg.maxNotional,
        reasons: ["Manual execution from dashboard"],
        mode: "manual",
        source: "ui",
      });
      if ("error" in result) {
        return res.status(400).json(result);
      }
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/ui/receipts", (req, res) => {
    const limit = Math.min(parseInt((req.query.limit as string) || "50", 10), 500);
    res.json(listReceipts(limit));
  });

  app.get(["/skill.md", "/api/skill.md"], (req, res) => {
    const baseUrl = `${req.protocol}://${req.get("host")}`;

    const md = `# PSYOPS — Multi-Chain Trading Copilot Skill

PSYOPS is an LLM-driven autonomous trading copilot supporting Solana devnet and Base mainnet.
It runs in paper mode by default and commits on-chain memo receipts on Solana devnet.

## Base URL

${baseUrl}

## Invoke Endpoint

POST ${baseUrl}/api/skill/invoke

Body:

\`\`\`json
{
  "action": "get_market | get_signal | propose_trade | execute_trade | get_receipt | set_chain",
  "args": {}
}
\`\`\`

### Actions

| Action | Args | Description |
|--------|------|-------------|
| get_market | { "pair": "SOL-USDC" } | Get current implied price and slippage from Jupiter |
| get_signal | { "pair": "SOL-USDC" } | Get breakout signal (BUY/SELL/HOLD) with strength |
| propose_trade | { "pair": "SOL-USDC", "side": "BUY", "notional": 20 } | Run risk checks and get trade explanation |
| execute_trade | { "pair": "SOL-USDC", "side": "BUY", "notional": 20, "chain": "solana-devnet" } | Execute trade on the specified chain (default: solana-devnet) |
| get_receipt | { "id": "<receipt_id>" } | Retrieve a specific trade receipt |
| set_chain | { "chain": "solana-devnet" \| "base" } | Validate chain availability and return wallet info |

### Chain Parameter

All actions accept an optional \`chain\` arg: \`"solana-devnet"\` (default) or \`"base"\`.

\`\`\`json
{ "action": "execute_trade", "args": { "pair": "SOL-USDC", "side": "BUY", "notional": 20, "chain": "solana-devnet" } }
\`\`\`

Base chain requires \`BASE_PRIVATE_KEY\`, \`BASE_RPC_URL\`, \`BASE_PRIMARY_TOKEN\`, \`BASE_USDC\`, \`BASE_SWAP_ROUTER\` env vars.
If not configured, returns \`{ "error": "Base chain not configured. Required: ..." }\`.

### Example

\`\`\`bash
curl -s ${baseUrl}/api/skill/invoke \\
  -H "Content-Type: application/json" \\
  -d '{"action":"get_signal","args":{"pair":"SOL-USDC"}}'
\`\`\`

## Manifest

GET ${baseUrl}/api/skill/manifest

## On-chain Receipts

Each Solana trade writes a devnet memo transaction containing trade details and receipt ID for audit.
Base trades write an on-chain Uniswap V3 swap transaction on Base mainnet.
Receipts include \`chain\` and \`source\` fields identifying the execution path.
`;

    res.setHeader("Content-Type", "text/markdown");
    res.send(md);
  });

  app.get("/api/skill/manifest", (_req, res) => {
    res.json(manifest());
  });

  app.post("/api/skill/invoke", async (req, res) => {
    try {
      const { action, args } = req.body;
      if (!action) {
        return res.status(400).json({ error: "action is required" });
      }
      const result = await invoke(action, args || {});
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  return httpServer;
}
