import express, { Request, Response } from "express";
import cors from "cors";
import dotenv from "dotenv";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../convex/_generated/api";
import { Id } from "../convex/_generated/dataModel";
import { createPublicClient, createWalletClient, http, parseUnits, encodeFunctionData } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
// NOTE: This Express server is DEPRECATED — replaced by convex/http.ts

dotenv.config({ path: "../.env.local" });

const app = express();
app.use(cors({
  origin: [
    "http://localhost:5173",
    process.env.FRONTEND_URL || "",
  ].filter(Boolean),
  credentials: true,
}));
app.use(express.json());

const convex = new ConvexHttpClient(process.env.VITE_CONVEX_URL!);
const RECEIVING_WALLET = process.env.RECEIVING_WALLET!;
const FACILITATOR = "https://x402.org/facilitator";
const NETWORK = "base";
const USDC_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const;

// ── Platform wallet (holds escrow, sends payouts + refunds) ──
const account = privateKeyToAccount(process.env.PLATFORM_PRIVATE_KEY as `0x${string}`);
const publicClient = createPublicClient({ chain: base, transport: http() });
const platformWallet = createWalletClient({ account, chain: base, transport: http() });

const ERC20_ABI = [
  {
    name: "transfer",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

async function sendUSDC(to: string, amountUSDC: number): Promise<string> {
  const amount = parseUnits(amountUSDC.toFixed(6), 6);
  const { request } = await publicClient.simulateContract({
    address: USDC_ADDRESS,
    abi: ERC20_ABI,
    functionName: "transfer",
    args: [to as `0x${string}`, amount],
    account,
  });
  const hash = await platformWallet.writeContract(request);
  console.log(`USDC sent: $${amountUSDC.toFixed(2)} → ${to.slice(0, 10)}… tx=${hash}`);
  return hash;
}

// ── x402 helpers ──

function buildRequirements(totalUSDC: number, resource: string, description: string) {
  return {
    scheme: "exact",
    network: NETWORK,
    maxAmountRequired: (totalUSDC * 1e6).toFixed(0),
    resource,
    description,
    mimeType: "application/json",
    payTo: RECEIVING_WALLET,
    maxTimeoutSeconds: 300,
    asset: USDC_ADDRESS,
    extra: { name: "INCITE", version: "1" },
  };
}

async function verifyAndSettle(
  paymentHeader: string,
  requirements: ReturnType<typeof buildRequirements>,
  res: Response
): Promise<boolean> {
  let payment: unknown;
  try {
    payment = JSON.parse(Buffer.from(paymentHeader, "base64").toString("utf8"));
  } catch {
    res.status(402).json({ error: "Malformed X-Payment header" });
    return false;
  }

  try {
    const vr = await fetch(`${FACILITATOR}/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ payment, paymentRequirements: requirements }),
    });
    const vd = (await vr.json()) as { isValid: boolean; invalidReason?: string };
    if (!vd.isValid) {
      res.status(402).json({ error: "Payment invalid", reason: vd.invalidReason });
      return false;
    }
  } catch (e: any) {
    res.status(502).json({ error: "Facilitator verify failed", detail: e.message });
    return false;
  }

  try {
    const sr = await fetch(`${FACILITATOR}/settle`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ payment, paymentRequirements: requirements }),
    });
    if (!sr.ok) {
      res.status(502).json({ error: "Settlement failed", detail: await sr.text() });
      return false;
    }
  } catch (e: any) {
    res.status(502).json({ error: "Facilitator settle failed", detail: e.message });
    return false;
  }
  return true;
}

function send402(res: Response, requirements: ReturnType<typeof buildRequirements>) {
  res
    .status(402)
    .set("X-Payment-Required", JSON.stringify({ accepts: [requirements] }))
    .json({ error: "Payment required", accepts: [requirements] });
}

// ── POST /task ── poster pays full itemCost + suggestedFee via x402
app.post("/task", async (req: Request, res: Response) => {
  const itemCost = parseFloat(req.body?.itemCost) || 0;
  const suggestedFee = parseFloat(req.body?.suggestedFee) || 0;
  const totalUSDC = Math.max(itemCost + suggestedFee, 0.01);

  const resource = `${req.protocol}://${req.get("host")}/task`;
  const requirements = buildRequirements(totalUSDC, resource, `INCITE task: $${totalUSDC.toFixed(2)} USDC`);

  const paymentHeader = req.headers["x-payment"] as string | undefined;
  if (!paymentHeader) return send402(res, requirements);

  const ok = await verifyAndSettle(paymentHeader, requirements, res);
  if (!ok) return;

  try {
    const taskId = await convex.mutation(api.tasks.create, req.body);
    res.json({ taskId });
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

// ── POST /accept-bid ── extra x402 if courier bid higher; USDC refund if lower
app.post("/accept-bid", async (req: Request, res: Response) => {
  const { taskId, bidId, posterId } = req.body;
  if (!taskId || !bidId || !posterId) {
    return res.status(400).json({ error: "Missing taskId, bidId, or posterId" });
  }

  let task: any, bid: any;
  try {
    task = await convex.query(api.tasks.getTask, { taskId: taskId as Id<"tasks"> });
    bid = await convex.query(api.tasks.getBid, { bidId: bidId as Id<"bids"> });
  } catch (e: any) {
    return res.status(400).json({ error: "Query failed: " + e.message });
  }

  if (!task || task.status !== "open") return res.status(400).json({ error: "Task not open" });
  if (!bid || bid.taskId !== taskId) return res.status(400).json({ error: "Invalid bid" });
  if (task.posterId !== posterId) return res.status(403).json({ error: "Not the poster" });

  const newTotal = task.itemCost + bid.fee;
  const diff = newTotal - task.totalEscrowed;

  // Courier bid higher → poster pays the difference via x402
  if (diff > 0.001) {
    const resource = `${req.protocol}://${req.get("host")}/accept-bid`;
    const requirements = buildRequirements(diff, resource, `INCITE extra fee: $${diff.toFixed(2)} USDC`);
    const paymentHeader = req.headers["x-payment"] as string | undefined;
    if (!paymentHeader) return send402(res, requirements);
    const ok = await verifyAndSettle(paymentHeader, requirements, res);
    if (!ok) return;
  }

  // Execute the mutation
  try {
    await convex.mutation(api.tasks.acceptBid, {
      taskId: taskId as Id<"tasks">,
      bidId: bidId as Id<"bids">,
      posterId: posterId as Id<"users">,
    });
  } catch (e: any) {
    return res.status(400).json({ error: e.message });
  }

  // Courier bid lower → refund the overpayment to poster on-chain
  if (diff < -0.001) {
    const refundAmount = Math.abs(diff);
    try {
      const poster = await convex.query(api.users.get, { userId: posterId as Id<"users"> });
      if (poster?.walletAddress) {
        const txHash = await sendUSDC(poster.walletAddress, refundAmount);
        return res.json({ ok: true, refund: refundAmount, txHash });
      }
    } catch (e: any) {
      console.error("Refund failed:", e.message);
      // Mutation succeeded, but refund failed — log for manual resolution
    }
  }

  res.json({ ok: true });
});

// ── POST /confirm-delivery ── send payout USDC to courier
app.post("/confirm-delivery", async (req: Request, res: Response) => {
  const { taskId, posterId, ratingScore, ratingComment } = req.body;
  if (!taskId || !posterId) {
    return res.status(400).json({ error: "Missing taskId or posterId" });
  }

  // Read task + courier data
  let task: any;
  try {
    task = await convex.query(api.tasks.getTask, { taskId: taskId as Id<"tasks"> });
  } catch (e: any) {
    return res.status(400).json({ error: e.message });
  }

  if (!task || (task.status !== "delivered" && task.status !== "in_progress")) {
    return res.status(400).json({ error: "Cannot confirm" });
  }
  if (task.posterId !== posterId || !task.courierId) {
    return res.status(403).json({ error: "Unauthorized" });
  }

  let courier: any;
  try {
    courier = await convex.query(api.users.get, { userId: task.courierId as Id<"users"> });
  } catch (e: any) {
    return res.status(400).json({ error: e.message });
  }
  if (!courier) return res.status(400).json({ error: "Courier not found" });

  // Calculate payout
  const FEE_RATE = 0.07;
  const burn = Math.round(task.totalEscrowed * FEE_RATE * 100) / 100;
  const payout = task.totalEscrowed - burn;

  // 1. Update DB first (status + ratings)
  try {
    await convex.mutation(api.tasks.confirmDelivery, {
      taskId: taskId as Id<"tasks">,
      posterId: posterId as Id<"users">,
      ratingScore,
      ratingComment,
    });
  } catch (e: any) {
    return res.status(400).json({ error: e.message });
  }

  // 2. Send USDC payout to courier on-chain
  let txHash: string | undefined;
  try {
    txHash = await sendUSDC(courier.walletAddress, payout);
  } catch (e: any) {
    console.error(`Payout to ${courier.walletAddress} failed:`, e.message);
    // DB updated but USDC failed — needs manual resolution
    return res.json({ ok: true, payout, payoutFailed: true, error: e.message });
  }

  res.json({ ok: true, payout, burn, txHash });
});

// ── POST /cancel-task ── refund full escrow USDC to poster
app.post("/cancel-task", async (req: Request, res: Response) => {
  const { taskId, posterId } = req.body;
  if (!taskId || !posterId) {
    return res.status(400).json({ error: "Missing taskId or posterId" });
  }

  // Read poster wallet
  let poster: any;
  try {
    poster = await convex.query(api.users.get, { userId: posterId as Id<"users"> });
  } catch (e: any) {
    return res.status(400).json({ error: e.message });
  }
  if (!poster) return res.status(400).json({ error: "User not found" });

  // 1. Update DB (marks status as cancelled, returns task with amounts)
  let task: any;
  try {
    task = await convex.mutation(api.tasks.cancel, {
      taskId: taskId as Id<"tasks">,
      posterId: posterId as Id<"users">,
    });
  } catch (e: any) {
    return res.status(400).json({ error: e.message });
  }

  // 2. Send full escrow refund on-chain
  let txHash: string | undefined;
  try {
    if (task?.totalEscrowed > 0) {
      txHash = await sendUSDC(poster.walletAddress, task.totalEscrowed);
    }
  } catch (e: any) {
    console.error(`Refund to ${poster.walletAddress} failed:`, e.message);
    return res.json({ ok: true, refund: task?.totalEscrowed, refundFailed: true, error: e.message });
  }

  res.json({ ok: true, refund: task?.totalEscrowed, txHash });
});

// ── Auto-refund cron (every 5 min) ── stuck in_progress tasks > 4 hours
async function processRefunds() {
  try {
    const stuck = await convex.query(api.tasks.getStuckTasks, {});
    for (const task of stuck) {
      console.log(`Auto-refunding task ${task._id} ($${task.totalEscrowed})`);

      // Mark as refunded in DB
      try {
        await convex.mutation(api.tasks.refundTask, { taskId: task._id as Id<"tasks"> });
      } catch (e: any) {
        console.error(`refundTask mutation failed for ${task._id}:`, e.message);
        continue;
      }

      // Send USDC back to poster
      try {
        const poster = await convex.query(api.users.get, { userId: task.posterId as Id<"users"> });
        if (poster?.walletAddress && task.totalEscrowed > 0) {
          await sendUSDC(poster.walletAddress, task.totalEscrowed);
        }
      } catch (e: any) {
        console.error(`Auto-refund USDC failed for ${task._id}:`, e.message);
      }
    }
  } catch (e: any) {
    console.error("processRefunds error:", e.message);
  }
}

// Run refund check every 5 minutes
setInterval(processRefunds, 5 * 60 * 1000);

app.get("/health", (_req, res) => res.json({ ok: true }));

const PORT = process.env.SERVER_PORT || 3001;
app.listen(PORT, () => {
  console.log(`INCITE payment server :${PORT}`);
  console.log(`Platform wallet: ${account.address}`);
  // Run once on startup
  processRefunds();
});
