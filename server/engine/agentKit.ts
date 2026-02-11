import { SolanaAgentKit } from "solana-agent-kit";
import {
  Keypair,
  Transaction,
  TransactionInstruction,
  PublicKey,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import bs58 from "bs58";

const MEMO_PROGRAM_ID = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");

let agentKit: SolanaAgentKit | null = null;

function getOrCreateKeypair(): Keypair {
  const raw = process.env.SOLANA_KEYPAIR_JSON;
  if (raw) {
    try {
      let cleaned = raw.replace(/\\n/g, "").replace(/\n/g, "").trim();
      if (!cleaned.startsWith("[")) {
        cleaned = `[${cleaned}]`;
      }
      const parsed = JSON.parse(cleaned);
      const arr = Array.isArray(parsed) ? parsed : Object.values(parsed);
      const secretKey = new Uint8Array(arr);
      const kp = Keypair.fromSecretKey(secretKey);
      console.log("[agentKit] Loaded persistent keypair:", kp.publicKey.toBase58());
      return kp;
    } catch (e: any) {
      console.warn("[agentKit] Failed to parse SOLANA_KEYPAIR_JSON:", e.message);
      console.warn("[agentKit] Raw value length:", raw.length, "starts with:", raw.substring(0, 20));
    }
  }
  const kp = Keypair.generate();
  console.log("[agentKit] Generated ephemeral keypair:", kp.publicKey.toBase58());
  return kp;
}

export function initAgentKit(): SolanaAgentKit {
  if (agentKit) return agentKit;

  const kp = getOrCreateKeypair();
  const rpcUrl = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
  const openaiKey = process.env.OPENAI_API_KEY || "";

  const privateKeyBase58 = bs58.encode(kp.secretKey);

  agentKit = new SolanaAgentKit(privateKeyBase58, rpcUrl, openaiKey);
  console.log("[agentKit] SolanaAgentKit initialized, wallet:", agentKit.wallet_address.toBase58());

  ensureFunded(agentKit);

  return agentKit;
}

let fundingReady = false;

export function isFunded(): boolean {
  return fundingReady;
}

async function ensureFunded(kit: SolanaAgentKit) {
  const maxRetries = 5;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const balance = await kit.connection.getBalance(kit.wallet_address);
      if (balance >= 5_000_000) {
        console.log(`[agentKit] Wallet funded: ${balance / 1e9} SOL`);
        fundingReady = true;
        return;
      }
      console.log(`[agentKit] Airdrop attempt ${attempt}/${maxRetries}...`);

      try {
        const resp = await fetch(`https://faucet.solana.com/api/fund`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            wallet: kit.wallet_address.toBase58(),
            network: "devnet",
            amount: 1,
          }),
        });
        if (resp.ok) {
          console.log("[agentKit] Web faucet request sent, waiting for confirmation...");
          await new Promise((r) => setTimeout(r, 5000));
          const newBalance = await kit.connection.getBalance(kit.wallet_address);
          if (newBalance >= 5_000_000) {
            console.log(`[agentKit] Wallet funded via web faucet: ${newBalance / 1e9} SOL`);
            fundingReady = true;
            return;
          }
        }
      } catch {}

      const sig = await kit.connection.requestAirdrop(kit.wallet_address, 1_000_000_000);
      await kit.connection.confirmTransaction(sig, "confirmed");
      console.log("[agentKit] Airdrop confirmed via RPC");
      fundingReady = true;
      return;
    } catch (err: any) {
      console.warn(`[agentKit] Airdrop attempt ${attempt} failed:`, err.message);
      if (attempt < maxRetries) {
        const delay = Math.min(2000 * Math.pow(2, attempt - 1), 30000);
        console.log(`[agentKit] Retrying in ${delay / 1000}s...`);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
  console.warn("[agentKit] All airdrop attempts failed. Memo transactions will fail until wallet is funded.");
}

export function getAgentPublicKey(): string {
  const kit = initAgentKit();
  return kit.wallet_address.toBase58();
}

export async function agentSendMemo(text: string): Promise<string> {
  try {
    const kit = initAgentKit();

    if (!fundingReady) {
      const balance = await kit.connection.getBalance(kit.wallet_address);
      if (balance < 5_000) {
        console.warn("[agentKit] Wallet not funded, skipping memo. Retrying airdrop...");
        ensureFunded(kit);
        return "N/A";
      }
      fundingReady = true;
    }

    const instruction = new TransactionInstruction({
      keys: [{ pubkey: kit.wallet_address, isSigner: true, isWritable: false }],
      programId: MEMO_PROGRAM_ID,
      data: Buffer.from(text, "utf-8"),
    });

    const tx = new Transaction().add(instruction);
    const sig = await sendAndConfirmTransaction(kit.connection, tx, [kit.wallet], {
      commitment: "confirmed",
    });
    console.log("[agentKit] Memo sent:", sig);
    return sig;
  } catch (err: any) {
    console.error("[agentKit] Failed to send memo tx:", err.message || err);
    return "N/A";
  }
}
