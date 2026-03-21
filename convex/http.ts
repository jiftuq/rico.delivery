import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { api, internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";

const NETWORK = "base";
const USDC_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

function corsHeaders(origin?: string) {
  return {
    "Access-Control-Allow-Origin": origin || "*",
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Payment",
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Expose-Headers": "X-Payment-Required",
  };
}

function json(data: unknown, status = 200, origin?: string) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
  });
}

function buildRequirements(totalUSDC: number, resource: string, description: string, receivingWallet: string) {
  return {
    scheme: "exact",
    network: NETWORK,
    maxAmountRequired: (totalUSDC * 1e6).toFixed(0),
    resource,
    description,
    mimeType: "application/json",
    payTo: receivingWallet,
    maxTimeoutSeconds: 300,
    asset: USDC_ADDRESS,
    extra: { name: "USD Coin", version: "2" },
  };
}

function send402(requirements: ReturnType<typeof buildRequirements>, origin?: string) {
  return new Response(
    JSON.stringify({ error: "Payment required", accepts: [requirements] }),
    {
      status: 402,
      headers: {
        "Content-Type": "application/json",
        "X-Payment-Required": JSON.stringify({ accepts: [requirements] }),
        ...corsHeaders(origin),
      },
    }
  );
}

// ── POST /task ──
const postTask = httpAction(async (ctx, request) => {
  const origin = request.headers.get("Origin") || undefined;
  const body = await request.json();

  const itemCost = parseFloat(body?.itemCost) || 0;
  const suggestedFee = parseFloat(body?.suggestedFee) || 0;
  const maxRunners = Math.max(1, parseInt(body?.maxRunners) || 1);
  // Multi-runner: escrow = fee * maxRunners. Single: itemCost + fee
  const totalUSDC = Math.max(maxRunners > 1 ? suggestedFee * maxRunners : itemCost + suggestedFee, 0.01);

  const receivingWallet: string = await ctx.runAction(internal.payments.getReceivingWallet, {});
  const resource = new URL("/task", request.url).toString();
  const requirements = buildRequirements(totalUSDC, resource, `GIGS.MOM task: $${totalUSDC.toFixed(2)} USDC`, receivingWallet);

  const paymentHeader = request.headers.get("X-Payment");
  if (!paymentHeader) return send402(requirements, origin);

  const result: any = await ctx.runAction(internal.payments.verifyX402, {
    paymentBase64: paymentHeader,
    requirements,
  });
  if (!result.ok) return json({ error: "Payment invalid", reason: result.reason }, 402, origin);

  try {
    const taskId = await ctx.runMutation(api.tasks.create, body);
    return json({ taskId }, 200, origin);
  } catch (e: any) {
    return json({ error: e.message }, 400, origin);
  }
});

// ── POST /accept-bid ──
const acceptBid = httpAction(async (ctx, request) => {
  const origin = request.headers.get("Origin") || undefined;
  const body = await request.json();
  const { taskId, bidId, posterId } = body;

  if (!taskId || !bidId || !posterId) {
    return json({ error: "Missing taskId, bidId, or posterId" }, 400, origin);
  }

  let task: any, bid: any;
  try {
    task = await ctx.runQuery(api.tasks.getTask, { taskId: taskId as Id<"tasks"> });
    bid = await ctx.runQuery(api.tasks.getBid, { bidId: bidId as Id<"bids"> });
  } catch (e: any) {
    return json({ error: "Query failed: " + e.message }, 400, origin);
  }

  if (!task || (task.status !== "open" && task.status !== "in_progress")) return json({ error: "Task not accepting bids" }, 400, origin);
  if (!bid || bid.taskId !== taskId) return json({ error: "Invalid bid" }, 400, origin);
  if (task.posterId !== posterId) return json({ error: "Not the poster" }, 403, origin);

  const multi = (task.maxRunners || 1) > 1;

  if (!multi) {
    // Single-runner: check if extra payment needed
    const newTotal = (task.itemCost || 0) + bid.fee;
    const diff = newTotal - task.totalEscrowed;

    if (diff > 0.001) {
      const receivingWallet: string = await ctx.runAction(internal.payments.getReceivingWallet, {});
      const resource = new URL("/accept-bid", request.url).toString();
      const requirements = buildRequirements(diff, resource, `GIGS.MOM extra fee: $${diff.toFixed(2)} USDC`, receivingWallet);
      const paymentHeader = request.headers.get("X-Payment");
      if (!paymentHeader) return send402(requirements, origin);
      const result: any = await ctx.runAction(internal.payments.verifyX402, {
        paymentBase64: paymentHeader,
        requirements,
      });
      if (!result.ok) return json({ error: "Payment invalid", reason: result.reason }, 402, origin);
    }

    try {
      await ctx.runMutation(api.tasks.acceptBid, {
        taskId: taskId as Id<"tasks">, bidId: bidId as Id<"bids">, posterId: posterId as Id<"users">,
      });
    } catch (e: any) {
      return json({ error: e.message }, 400, origin);
    }

    // Refund overpayment for single-runner
    if (diff < -0.001) {
      const refundAmount = Math.abs(diff);
      try {
        const poster: any = await ctx.runQuery(api.users.get, { userId: posterId as Id<"users"> });
        if (poster?.walletAddress) {
          const txHash = await ctx.runAction(internal.payments.sendUSDC, {
            to: poster.walletAddress, amountUSDC: refundAmount,
          });
          return json({ ok: true, refund: refundAmount, txHash }, 200, origin);
        }
      } catch (e: any) {
        console.error("Refund failed:", e.message);
      }
    }
  } else {
    // Multi-runner: all escrowed upfront, no extra payment needed per bid accept
    try {
      await ctx.runMutation(api.tasks.acceptBid, {
        taskId: taskId as Id<"tasks">, bidId: bidId as Id<"bids">, posterId: posterId as Id<"users">,
      });
    } catch (e: any) {
      return json({ error: e.message }, 400, origin);
    }
  }

  return json({ ok: true }, 200, origin);
});

// ── POST /confirm-delivery ──
const confirmDelivery = httpAction(async (ctx, request) => {
  const origin = request.headers.get("Origin") || undefined;
  const body = await request.json();
  const { taskId, posterId, runnerId, ratingScore, ratingComment } = body;

  if (!taskId || !posterId) {
    return json({ error: "Missing taskId or posterId" }, 400, origin);
  }

  let task: any;
  try {
    task = await ctx.runQuery(api.tasks.getTask, { taskId: taskId as Id<"tasks"> });
  } catch (e: any) {
    return json({ error: e.message }, 400, origin);
  }

  if (!task) return json({ error: "Task not found" }, 400, origin);
  if (task.posterId !== posterId) return json({ error: "Unauthorized" }, 403, origin);

  const multi = (task.maxRunners || 1) > 1;
  const FEE_RATE = 0.07;

  // Determine who to pay
  let payRunnerId: string;
  let payAmount: number;

  if (multi) {
    if (!runnerId) return json({ error: "runnerId required for multi-runner task" }, 400, origin);
    payRunnerId = runnerId;
    // Per-runner payout: their accepted fee minus platform fee
    // We need to look up the taskRunner entry to find their fee
    const runners: any[] = await ctx.runQuery(api.tasks.getTaskRunners, { taskId: taskId as Id<"tasks"> });
    const tr = runners.find((r: any) => r.runnerId === runnerId);
    if (!tr) return json({ error: "Runner not found on task" }, 400, origin);
    const burn = Math.round(tr.fee * FEE_RATE * 100) / 100;
    payAmount = tr.fee - burn;
  } else {
    if (!task.courierId) return json({ error: "No runner assigned" }, 400, origin);
    if (task.status !== "delivered" && task.status !== "in_progress") return json({ error: "Cannot confirm" }, 400, origin);
    payRunnerId = task.courierId;
    const burn = Math.round(task.totalEscrowed * FEE_RATE * 100) / 100;
    payAmount = task.totalEscrowed - burn;
  }

  let courier: any;
  try {
    courier = await ctx.runQuery(api.users.get, { userId: payRunnerId as Id<"users"> });
  } catch (e: any) {
    return json({ error: e.message }, 400, origin);
  }
  if (!courier) return json({ error: "Runner not found" }, 400, origin);

  // 1. Update DB (status + ratings)
  try {
    await ctx.runMutation(api.tasks.confirmDelivery, {
      taskId: taskId as Id<"tasks">,
      posterId: posterId as Id<"users">,
      runnerId: multi ? runnerId as Id<"users"> : undefined,
      ratingScore,
      ratingComment,
    });
  } catch (e: any) {
    return json({ error: e.message }, 400, origin);
  }

  // 2. Send USDC payout to runner on-chain
  let txHash: string | null | undefined;
  try {
    txHash = await ctx.runAction(internal.payments.sendUSDC, {
      to: courier.walletAddress,
      amountUSDC: payAmount,
    });
  } catch (e: any) {
    console.error(`Payout to ${courier.walletAddress} failed:`, e.message);
    return json({ ok: true, payout: payAmount, payoutFailed: true, error: e.message }, 200, origin);
  }

  return json({ ok: true, payout: payAmount, txHash }, 200, origin);
});

// ── POST /cancel-task ──
const cancelTask = httpAction(async (ctx, request) => {
  const origin = request.headers.get("Origin") || undefined;
  const body = await request.json();
  const { taskId, posterId } = body;

  if (!taskId || !posterId) {
    return json({ error: "Missing taskId or posterId" }, 400, origin);
  }

  let poster: any;
  try {
    poster = await ctx.runQuery(api.users.get, { userId: posterId as Id<"users"> });
  } catch (e: any) {
    return json({ error: e.message }, 400, origin);
  }
  if (!poster) return json({ error: "User not found" }, 400, origin);

  let task: any;
  try {
    task = await ctx.runMutation(api.tasks.cancel, {
      taskId: taskId as Id<"tasks">,
      posterId: posterId as Id<"users">,
    });
  } catch (e: any) {
    return json({ error: e.message }, 400, origin);
  }

  let txHash: string | null | undefined;
  try {
    if (task?.totalEscrowed > 0) {
      txHash = await ctx.runAction(internal.payments.sendUSDC, {
        to: poster.walletAddress,
        amountUSDC: task.totalEscrowed,
      });
    }
  } catch (e: any) {
    console.error(`Refund to ${poster.walletAddress} failed:`, e.message);
    return json({ ok: true, refund: task?.totalEscrowed, refundFailed: true, error: e.message }, 200, origin);
  }

  return json({ ok: true, refund: task?.totalEscrowed, txHash }, 200, origin);
});

// ── CORS preflight ──
const corsOptions = httpAction(async (_ctx, request) => {
  const origin = request.headers.get("Origin") || undefined;
  return new Response(null, { status: 204, headers: corsHeaders(origin) });
});

// ── Health ──
const health = httpAction(async (_ctx, request) => {
  const origin = request.headers.get("Origin") || undefined;
  return json({ ok: true }, 200, origin);
});

// ── Router ──
const http = httpRouter();

http.route({ path: "/task", method: "POST", handler: postTask });
http.route({ path: "/task", method: "OPTIONS", handler: corsOptions });

http.route({ path: "/accept-bid", method: "POST", handler: acceptBid });
http.route({ path: "/accept-bid", method: "OPTIONS", handler: corsOptions });

http.route({ path: "/confirm-delivery", method: "POST", handler: confirmDelivery });
http.route({ path: "/confirm-delivery", method: "OPTIONS", handler: corsOptions });

http.route({ path: "/cancel-task", method: "POST", handler: cancelTask });
http.route({ path: "/cancel-task", method: "OPTIONS", handler: corsOptions });

http.route({ path: "/health", method: "GET", handler: health });

export default http;
