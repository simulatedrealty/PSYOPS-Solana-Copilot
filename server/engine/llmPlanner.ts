import OpenAI from "openai";

let _openai: OpenAI | null = null;
function getOpenAI() {
  if (!_openai) {
    _openai = new OpenAI({
      apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY,
      baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL,
    });
  }
  return _openai;
}

export interface LLMContext {
  chain: "solana-devnet" | "base";
  pair: string;
  impliedPrice: number;
  rollingHigh: number;
  rollingLow: number;
  breakoutSignal: "BUY" | "SELL" | "HOLD";
  breakoutStrength: number;
  slippageBps: number;
  risk: {
    allowed: boolean;
    checks: {
      cooldownOK: boolean;
      maxNotionalOK: boolean;
      maxDailyLossOK: boolean;
      slippageOK: boolean;
    };
  };
  lastActions: { ts: string; side: string; price: number }[];
}

export interface LLMDecision {
  action: "BUY" | "SELL" | "HOLD";
  confidence: number;
  reasons: string[];
}

const SYSTEM_PROMPT = `You are a Multi-Chain Autonomous Trading Agent supporting Solana devnet and Base mainnet. You receive live market context (chain, pair, price, breakout signals, risk constraints) and must decide: BUY, SELL, or HOLD.

Rules:
- NEVER BUY if slippage is above threshold.
- NEVER EXECUTE trades if risk.allowed = false.
- HOLD if context is unclear.
- The "chain" and "pair" fields tell you exactly what you are trading (e.g. VIRTUAL-USDC on Base, or SOL-USDC on Solana devnet).
- Provide 2-4 short bullet points explaining your reasoning.
- Provide a confidence score between 0 and 1.

You MUST respond with valid JSON in this exact format:
{"action": "HOLD", "confidence": 0.5, "reasons": ["reason 1", "reason 2"]}`;

export async function decideAction(context: LLMContext): Promise<LLMDecision> {
  try {
    const response = await getOpenAI().chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: `Market context:\n${JSON.stringify(context, null, 2)}\n\nRespond with JSON only.` },
      ],
      response_format: { type: "json_object" },
      max_tokens: 512,
    });

    const raw = response.choices[0]?.message?.content || "";
    console.log("[llmPlanner] Raw response:", raw.substring(0, 200));

    if (!raw) {
      return { action: "HOLD", confidence: 0, reasons: ["LLM returned empty response"] };
    }

    const parsed = JSON.parse(raw);
    const action = ["BUY", "SELL", "HOLD"].includes(parsed.action) ? parsed.action : "HOLD";
    const confidence = typeof parsed.confidence === "number" ? Math.max(0, Math.min(1, parsed.confidence)) : 0;
    const reasons = Array.isArray(parsed.reasons) ? parsed.reasons.map(String) : [];

    return { action, confidence, reasons };
  } catch (err: any) {
    console.error("[llmPlanner] Error:", err.message);
    return { action: "HOLD", confidence: 0, reasons: [`LLM error: ${err.message}`] };
  }
}
