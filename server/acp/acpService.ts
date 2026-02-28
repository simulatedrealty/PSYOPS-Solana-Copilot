import {
  AcpContractClientV2,
  AcpJob,
  AcpJobPhases,
  AcpMemo,
} from "@virtuals-protocol/acp-node";
import { createRequire } from "module";
import { invoke } from "../skills/tradingSkill";

const require = createRequire(import.meta.url);
const AcpClient = require("@virtuals-protocol/acp-node").default;

const ACP_ENTITY_ID = parseInt(process.env.ACP_ENTITY_ID || "0", 10);
const ACP_AGENT_WALLET = process.env.ACP_AGENT_WALLET_ADDRESS || "";
const ACP_PRIVATE_KEY = process.env.ACP_PRIVATE_KEY || "";

let acpClient: InstanceType<typeof AcpClient> | null = null;

export async function initAcp(): Promise<void> {
  if (!ACP_ENTITY_ID || !ACP_AGENT_WALLET || !ACP_PRIVATE_KEY) {
    console.log("[acp] ACP not configured — skipping initialization");
    return;
  }

  const contractClient = await AcpContractClientV2.build(
    ACP_PRIVATE_KEY as `0x${string}`,
    ACP_ENTITY_ID,
    ACP_AGENT_WALLET as `0x${string}`,
  );

  acpClient = new AcpClient({
    acpContractClient: contractClient,
    onNewTask: (job: AcpJob, memoToSign?: AcpMemo) => {
      handleJob(job, memoToSign).catch((err) =>
        console.error(`[acp] Unhandled error in job ${job.id}:`, err.message),
      );
    },
  });

  await acpClient.init();
  console.log(
    `[acp] ACP seller agent initialized (entity=${ACP_ENTITY_ID}, wallet=${ACP_AGENT_WALLET})`,
  );
}

async function handleJob(job: AcpJob, memoToSign?: AcpMemo): Promise<void> {
  try {
    // Phase 1: REQUEST → accept and create requirement
    if (
      job.phase === AcpJobPhases.REQUEST &&
      memoToSign?.nextPhase === AcpJobPhases.NEGOTIATION
    ) {
      console.log(`[acp] New job ${job.id} — accepting`);
      await job.accept("PSYOPS can fulfill this request");
      await job.createRequirement(
        `Job ${job.id} accepted, please make payment to proceed`,
      );
      return;
    }

    // Phase 2: TRANSACTION (payment received) → execute and deliver
    if (
      job.phase === AcpJobPhases.TRANSACTION &&
      memoToSign?.nextPhase === AcpJobPhases.EVALUATION
    ) {
      console.log(`[acp] Job ${job.id} paid — executing`);

      // Parse the job requirement to determine which action to invoke
      const args = parseJobRequirement(job);
      const action = resolveAction(args);
      const result = await invoke(action, args);

      const deliverable: Record<string, unknown> = {
        type: "url",
        value: JSON.stringify(result),
      };
      await job.deliver(deliverable);
      console.log(`[acp] Job ${job.id} delivered (action=${action})`);
      return;
    }
  } catch (err: any) {
    console.error(`[acp] Job ${job.id} error:`, err.message);
    try {
      await job.reject(`Error: ${err.message}`);
    } catch {}
  }
}

/**
 * Parse the job requirement fields into args for the Skill API.
 * The requirement comes from the buyer agent matching our schema.
 */
function parseJobRequirement(job: AcpJob): Record<string, any> {
  const req = job.requirement;
  if (!req) return {};

  // If requirement is a string, try to parse as JSON
  if (typeof req === "string") {
    try {
      return JSON.parse(req);
    } catch {
      return { raw: req };
    }
  }

  // If it's already an object, return it
  return req as Record<string, any>;
}

/**
 * Map job fields to the correct Skill API action.
 * Looks for an explicit "action" field, or infers from the job offering name.
 */
function resolveAction(args: Record<string, any>): string {
  if (args.action) return args.action;

  // Infer from fields present
  if (args.side && args.baseToken) return "execute_trade";
  if (args.side) return "propose_trade";
  if (args.baseToken || args.chain) return "get_market";
  if (args.pair) return "get_signal";
  if (args.receiptId) return "get_receipt";

  return "get_market"; // safe default
}

export function getAcpClient(): InstanceType<typeof AcpClient> | null {
  return acpClient;
}
