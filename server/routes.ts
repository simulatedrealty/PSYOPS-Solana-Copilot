import type { Express } from "express";
import { createServer, type Server } from "http";
import { randomUUID } from "crypto";
import { sharedState, getPubkey, getConnection } from "./engine/state";
import { initAgentKit } from "./engine/agentKit";
import { getConfig } from "./engine/config";
import { getMarket, getSignal, getReceipts, getReceiptById } from "./engine/tradingEngine";
import { getMarketForChain } from "./engine/market";
import { updateRollingPrices } from "./engine/signal";
import { checkRisk } from "./engine/risk";
import { startLoop, stopLoop } from "./engine/loop";
import { manifest, invoke } from "./skills/tradingSkill";
import { listReceipts, appendReceipt } from "./receipts/store";
import { handleTrade } from "./execution/handler";
import { getEngine } from "./execution/getEngine";
import { buildSolanaTransaction, buildBaseTransaction } from "./execution/buildTransaction";
import { createPublicClient, http, getAddress } from "viem";
import { base } from "viem/chains";
import { getAcpClient } from "./acp/acpService";

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
      activeChain: sharedState.activeChain,
      activePair: sharedState.activePair,
      activeTokens: sharedState.activeTokens,
      solanaWallet: getEngine("solana-devnet").getWallet(),
      baseWallet: getEngine("base").getWallet(),
      pair: sharedState.activePair,
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
      acpEnabled: !!(process.env.ACP_ENTITY_ID && process.env.ACP_AGENT_WALLET_ADDRESS && process.env.ACP_PRIVATE_KEY),
      acpEntityId: process.env.ACP_ENTITY_ID || null,
      acpWallet: process.env.ACP_AGENT_WALLET_ADDRESS || null,
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

  // POST /api/ui/set-chain
  // Changes the active chain/pair and resolves token addresses.
  // Resets rollingPrices and stale signal state so the new pair starts clean.
  app.post("/api/ui/set-chain", (req, res) => {
    const { chain, pair, baseToken, quoteToken } = req.body;

    if (chain !== "solana-devnet" && chain !== "base") {
      return res.status(400).json({ error: 'chain must be "solana-devnet" or "base"' });
    }

    const prevPair = sharedState.activePair;

    // Resolve token addresses
    if (chain === "solana-devnet") {
      const SOL_MINT  = "So11111111111111111111111111111111111111112";
      const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
      sharedState.activeTokens = {
        base:  baseToken  || SOL_MINT,
        quote: quoteToken || USDC_MINT,
      };
      sharedState.activePair = pair || "SOL-USDC";
    } else {
      // Base — caller provides explicit ERC20 addresses for any token, or fall back to env vars.
      // Normalize with getAddress() so any casing is accepted (EIP-55 checksum).
      const rawBase  = baseToken  || process.env.BASE_PRIMARY_TOKEN || "";
      const rawQuote = quoteToken || process.env.BASE_USDC          || "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
      sharedState.activeTokens = {
        base:  rawBase  ? getAddress(rawBase)  : "",
        quote: getAddress(rawQuote),
      };
      sharedState.activePair = pair || "BASE-USDC";
    }

    sharedState.activeChain = chain;

    // Reset rolling prices whenever chain or pair changes — old prices are for a different token
    if (sharedState.activeChain !== chain || sharedState.activePair !== prevPair) {
      sharedState.rollingPrices = [];
    }
    sharedState.rollingPrices  = [];
    sharedState.lastSignal     = null;
    sharedState.lastStrength   = null;
    sharedState.lastConfidence = null;
    sharedState.lastReasons    = [];
    sharedState.lastImpliedPrice = null;

    res.json({
      activeChain:  sharedState.activeChain,
      activePair:   sharedState.activePair,
      activeTokens: sharedState.activeTokens,
    });
  });

  app.post("/api/ui/execute-now", async (req, res) => {
    try {
      const side = req.body.side as "BUY" | "SELL";
      if (!side || !["BUY", "SELL"].includes(side)) {
        return res.status(400).json({ error: "side must be BUY or SELL" });
      }
      const cfg = getConfig();
      const activeChain  = sharedState.activeChain;
      const activePair   = sharedState.activePair;
      const activeTokens = sharedState.activeTokens;
      const market = await getMarketForChain(activeChain, activePair, activeTokens, cfg.maxNotional);
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
        chain: activeChain,
        pair: activePair,
        side,
        notionalUsd: cfg.maxNotional,
        reasons: ["Manual execution from dashboard"],
        mode: "manual",
        source: "ui",
        tokens: activeTokens,
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

  // ── Phase 2: Browser-wallet live trading ─────────────────────────────────────
  // Server builds unsigned tx; browser wallet signs and submits; server verifies.
  // Server never receives, stores, or logs user private keys.

  app.post("/api/ui/build-transaction", async (req, res) => {
    try {
      const { chain, pair, side, notional, walletAddress } = req.body;
      if (!chain || !pair || !["BUY", "SELL"].includes(side) || !notional || !walletAddress) {
        return res.status(400).json({ error: "Missing required fields: chain, pair, side, notional, walletAddress" });
      }
      let result;
      if (chain === "solana-devnet") {
        result = await buildSolanaTransaction(pair, side, notional, walletAddress);
      } else if (chain === "base") {
        result = await buildBaseTransaction(pair, side, notional, walletAddress);
      } else {
        return res.status(400).json({ error: `Unknown chain: ${chain}` });
      }
      res.json(result);
    } catch (err: any) {
      console.error("[build-transaction]", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/ui/confirm-transaction", async (req, res) => {
    try {
      let { chain, txHash, walletAddress, pair, side, notional } = req.body;
      if (!chain || !txHash || !walletAddress || !pair || !side || !notional) {
        return res.status(400).json({ error: "Missing required fields: chain, txHash, walletAddress, pair, side, notional" });
      }

      // Verify the transaction actually exists and succeeded on-chain
      if (chain === "solana-devnet") {
        const conn = getConnection();
        const tx = await conn.getTransaction(txHash, {
          commitment: "confirmed",
          maxSupportedTransactionVersion: 0,
        });
        if (!tx) {
          return res.status(400).json({ error: "Transaction not found on Solana devnet. Wait for confirmation and retry." });
        }
        if (tx.meta?.err) {
          return res.status(400).json({ error: "Transaction failed on-chain", details: tx.meta.err });
        }
      } else if (chain === "base") {
        // Normalize EVM address at the boundary before any viem usage
        walletAddress = getAddress(walletAddress);
        const rpcUrl = process.env.BASE_RPC_URL || "https://mainnet.base.org";
        const publicClient = createPublicClient({ chain: base, transport: http(rpcUrl) });
        const txReceipt = await publicClient.getTransactionReceipt({ hash: txHash as `0x${string}` });
        if (!txReceipt) {
          return res.status(400).json({ error: "Transaction not found on Base. Wait for confirmation and retry." });
        }
        if (txReceipt.status === "reverted") {
          return res.status(400).json({ error: "Transaction reverted on-chain" });
        }
      } else {
        return res.status(400).json({ error: `Unknown chain: ${chain}` });
      }

      // Build and save receipt (mode: "live", wallet included)
      const receipt = {
        id: randomUUID().slice(0, 8),
        ts: Date.now(),
        pair,
        side,
        mode: "live",
        notional,
        fillPrice: 0, // Decoded from on-chain events is a future enhancement; tx hash is source of truth
        confidence: 1,
        reasons: [`Live trade via wallet ${walletAddress.slice(0, 6)}...${walletAddress.slice(-4)}`],
        riskChecks: {
          cooldownOK: true,
          maxNotionalOK: true,
          maxDailyLossOK: true,
          slippageOK: true,
        },
        memoTxid: txHash,
        status: "SUCCESS",
        chain,
        source: "ui",
        wallet: walletAddress,
      };
      appendReceipt(receipt);
      res.json(receipt);
    } catch (err: any) {
      console.error("[confirm-transaction]", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // ── ACP job query endpoints ──────────────────────────────────────────────────

  app.get("/api/acp/jobs/active", async (_req, res) => {
    const client = getAcpClient();
    if (!client) return res.status(503).json({ error: "ACP not configured" });
    try {
      const jobs = await client.getActiveJobs(1, 20);
      res.json(jobs);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/acp/jobs/completed", async (_req, res) => {
    const client = getAcpClient();
    if (!client) return res.status(503).json({ error: "ACP not configured" });
    try {
      const jobs = await client.getCompletedJobs(1, 20);
      res.json(jobs);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Skill API ───────────────────────────────────────────────────────────────

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
