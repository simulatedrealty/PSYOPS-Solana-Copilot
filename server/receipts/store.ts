import { appendFileSync, existsSync, readFileSync, mkdirSync } from "fs";
import { join } from "path";

const DATA_DIR = join(process.cwd(), "data");
const JSONL_PATH = join(DATA_DIR, "receipts.jsonl");

function ensureDataDir(): void {
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }
}

export function appendReceipt(receipt: unknown): void {
  ensureDataDir();
  appendFileSync(JSONL_PATH, JSON.stringify(receipt) + "\n", "utf-8");
}

export function listReceipts(limit = 50): Record<string, unknown>[] {
  if (!existsSync(JSONL_PATH)) return [];
  const lines = readFileSync(JSONL_PATH, "utf-8").split("\n").filter(Boolean);
  const parsed: Record<string, unknown>[] = [];
  for (const line of lines) {
    try {
      parsed.push(JSON.parse(line));
    } catch {
      // skip malformed lines
    }
  }
  return parsed.slice(-limit);
}
