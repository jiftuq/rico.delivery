"use node";
import { internalAction } from "./_generated/server";
import { v } from "convex/values";
import { createPublicClient, createWalletClient, http, parseUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { internal, api } from "./_generated/api";
import { Id } from "./_generated/dataModel";

const USDC_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const;
const FACILITATOR = "https://x402.org/facilitator";

const ERC20_ABI = [
  {
    name: "transfer",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

function getPlatformWallet() {
  const key = process.env.PLATFORM_PRIVATE_KEY;
  if (!key) throw new Error("PLATFORM_PRIVATE_KEY not set");
  const account = privateKeyToAccount(key as `0x${string}`);
  const publicClient = createPublicClient({ chain: base, transport: http() });
  const walletClient = createWalletClient({ account, chain: base, transport: http() });
  return { account, publicClient, walletClient };
}

// ── Send USDC on-chain from platform wallet ──
export const sendUSDC = internalAction({
  args: { to: v.string(), amountUSDC: v.float64() },
  handler: async (_ctx, { to, amountUSDC }) => {
    if (amountUSDC <= 0) return null;
    const { account, publicClient, walletClient } = getPlatformWallet();
    const amount = parseUnits(amountUSDC.toFixed(6), 6);
    const { request } = await publicClient.simulateContract({
      address: USDC_ADDRESS,
      abi: ERC20_ABI,
      functionName: "transfer",
      args: [to as `0x${string}`, amount],
      account,
    });
    const hash = await walletClient.writeContract(request);
    console.log(`USDC sent: $${amountUSDC.toFixed(2)} → ${to.slice(0, 10)}… tx=${hash}`);
    return hash;
  },
});

// ── Verify + settle x402 payment via facilitator ──
export const verifyX402 = internalAction({
  args: { paymentBase64: v.string(), requirements: v.any() },
  handler: async (_ctx, { paymentBase64, requirements }) => {
    const payment = JSON.parse(Buffer.from(paymentBase64, "base64").toString("utf8"));

    const vr = await fetch(`${FACILITATOR}/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ payment, paymentRequirements: requirements }),
    });
    const vd = (await vr.json()) as { isValid: boolean; invalidReason?: string };
    if (!vd.isValid) return { ok: false, reason: vd.invalidReason || "Invalid" };

    const sr = await fetch(`${FACILITATOR}/settle`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ payment, paymentRequirements: requirements }),
    });
    if (!sr.ok) return { ok: false, reason: "Settlement failed: " + (await sr.text()) };

    return { ok: true };
  },
});

// ── Auto-refund stuck tasks (called by cron) ──
export const processRefunds = internalAction({
  args: {},
  handler: async (ctx) => {
    const stuck: any[] = await ctx.runQuery(api.tasks.getStuckTasks, {});
    for (const task of stuck) {
      console.log(`Auto-refunding task ${task._id} ($${task.totalEscrowed})`);
      try {
        await ctx.runMutation(api.tasks.refundTask, { taskId: task._id });
        const poster: any = await ctx.runQuery(api.users.get, { userId: task.posterId });
        if (poster?.walletAddress && task.totalEscrowed > 0) {
          await ctx.runAction(internal.payments.sendUSDC, {
            to: poster.walletAddress,
            amountUSDC: task.totalEscrowed,
          });
        }
      } catch (e: any) {
        console.error(`Refund failed for ${task._id}:`, e.message);
      }
    }
  },
});
