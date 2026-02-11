import type { Express } from "express";
import { createServer, type Server } from "http";
import { sharedState, getPubkey, getConnection } from "./engine/state";
import { initAgentKit } from "./engine/agentKit";
import { getConfig } from "./engine/config";
import { getMarket, getSignal, executeTrade, getReceipts, getReceiptById } from "./engine/tradingEngine";
import { updateRollingPrices } from "./engine/signal";
import { checkRisk } from "./engine/risk";
import { startLoop, stopLoop } from "./engine/loop";
import { manifest, invoke } from "./skills/tradingSkill";

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
      const receipt = await executeTrade(
        cfg.pair,
        side,
        cfg.maxNotional,
        0.5,
        ["Manual execution from dashboard"],
        "manual"
      );
      res.json(receipt);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/ui/receipts", (_req, res) => {
    res.json(getReceipts());
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
