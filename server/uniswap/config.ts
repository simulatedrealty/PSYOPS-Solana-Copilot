export interface UniswapConfig {
  pair: string;
  maxNotional: number;
  maxSlippageBps: number;
  maxGasPriceGwei: number;
  cooldownSec: number;
  maxDailyLoss: number;
  breakoutThresholdBps: number;
}

export function getUniswapConfig(): UniswapConfig {
  return {
    pair: process.env.UNISWAP_PAIR || "ETH-USDC",
    maxNotional: parseInt(process.env.UNISWAP_MAX_NOTIONAL || "100"),
    maxSlippageBps: parseInt(process.env.UNISWAP_MAX_SLIPPAGE_BPS || "30"),
    maxGasPriceGwei: parseInt(process.env.UNISWAP_MAX_GAS_GWEI || "50"),
    cooldownSec: parseInt(process.env.UNISWAP_COOLDOWN_SEC || "60"),
    maxDailyLoss: parseInt(process.env.UNISWAP_MAX_DAILY_LOSS || "50"),
    breakoutThresholdBps: parseInt(process.env.UNISWAP_BREAKOUT_BPS || "30"),
  };
}
