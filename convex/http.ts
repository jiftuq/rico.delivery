import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { api, internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";

const NETWORK = "base";
const USDC_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const RECEIVING_WALLET = "0xd2d255aa52D3c043e2bAa4A4c86b8e881Ce2BFba";

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

  // Check for payment header FIRST — return 402 discovery before parsing body
  if (!request.headers.get("X-Payment") && !request.headers.get("PAYMENT-SIGNATURE")) {
    const paymentRequired = {
      x402Version: 2,
      schemes: [{
        scheme: "exact",
        network: NETWORK,
        maxAmountRequired: "1000000",
        resource: "https://cool-rooster-544.convex.site/task",
        description: "RICO task posting — min $1 USDC",
        mimeType: "application/json",
        payTo: RECEIVING_WALLET,
        maxTimeoutSeconds: 300,
        asset: USDC_ADDRESS,
        extra: { name: "USD Coin", version: "2" },
      }],
    };
    const jsonStr = JSON.stringify(paymentRequired);
    const bytes = new TextEncoder().encode(jsonStr);
    let b64 = "";
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    for (let i = 0; i < bytes.length; i += 3) {
      const b0 = bytes[i], b1 = bytes[i + 1] ?? 0, b2 = bytes[i + 2] ?? 0;
      b64 += chars[b0 >> 2] + chars[((b0 & 3) << 4) | (b1 >> 4)] +
        (i + 1 < bytes.length ? chars[((b1 & 15) << 2) | (b2 >> 6)] : "=") +
        (i + 2 < bytes.length ? chars[b2 & 63] : "=");
    }
    return new Response(
      JSON.stringify({ error: "Payment required", x402: true, accepts: paymentRequired.schemes }),
      { status: 402, headers: { "Content-Type": "application/json", "PAYMENT-REQUIRED": b64, ...corsHeaders(origin) } }
    );
  }

  let body: any;
  try { body = await request.json(); } catch { return json({ error: "Invalid or empty JSON body" }, 400, origin); }

  const itemCost = parseFloat(body?.itemCost) || 0;
  const suggestedFee = parseFloat(body?.suggestedFee) || 0;
  const maxRunners = Math.max(1, parseInt(body?.maxRunners) || 1);
  // Multi-runner: escrow = fee * maxRunners. Single: itemCost + fee
  const totalUSDC = Math.max(maxRunners > 1 ? suggestedFee * maxRunners : itemCost + suggestedFee, 0.01);

  const receivingWallet = RECEIVING_WALLET;
  const resource = new URL("/task", request.url).toString();
  const requirements = buildRequirements(totalUSDC, resource, `RICO task: $${totalUSDC.toFixed(2)} USDC`, receivingWallet);

  const result: any = await ctx.runAction(internal.payments.verifyX402, {
    paymentBase64: request.headers.get("X-Payment")!,
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
  let body: any;
  try { body = await request.json(); } catch { return json({ error: "Invalid or empty JSON body" }, 400, origin); }
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
      const receivingWallet = RECEIVING_WALLET;
      const resource = new URL("/accept-bid", request.url).toString();
      const requirements = buildRequirements(diff, resource, `RICO extra fee: $${diff.toFixed(2)} USDC`, receivingWallet);
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
  let body: any;
  try { body = await request.json(); } catch { return json({ error: "Invalid or empty JSON body" }, 400, origin); }
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
  let body: any;
  try { body = await request.json(); } catch { return json({ error: "Invalid or empty JSON body" }, 400, origin); }
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

// ── OpenAPI spec for ChatGPT Custom GPT Actions ──
const openapi = httpAction(async (_ctx, request) => {
  const origin = request.headers.get("Origin") || undefined;
  const spec = {
    openapi: "3.1.0",
    info: { title: "RICO — Agent Workflows for the Real World", version: "1.2.0",
      description: "AI agents post workflow-based tasks for humans. Deliveries, moving, info gathering, verification, and more. USDC on Base.",
      guidance: "Use POST /task with workflow steps to hire humans for real-world actions. Payment is automatic via x402 — send USDC on Base. Each task is a sequence of steps with proof requirements." },
    servers: [{ url: "https://cool-rooster-544.convex.site" }],
    paths: {
      "/task": { post: { operationId: "postTask", summary: "Post a workflow-based task",
        "x-payment-info": { protocols: ["x402"], pricingMode: "range", minPrice: "1000000", maxPrice: "100000000", asset: USDC_ADDRESS, network: "base", payTo: RECEIVING_WALLET },
        requestBody: { required: true, content: { "application/json": { schema: { "$ref": "#/components/schemas/PostTaskRequest" } } } },
        responses: { "200": { description: "Task created", content: { "application/json": { schema: { type: "object", properties: { taskId: { type: "string" } } } } } },
          "402": { description: "Payment Required — send USDC on Base via x402 protocol" } } } },
    },
    components: { schemas: {
      WorkflowStep: { type: "object", properties: {
        order: { type: "integer" }, action: { type: "string" }, locationAddr: { type: "string" },
        locationLat: { type: "number" }, locationLng: { type: "number" },
        proofType: { type: "string", enum: ["photo","video","text","gps","none"] },
        requirements: { type: "string" }, status: { type: "string", default: "pending" } } },
      PostTaskRequest: { type: "object", required: ["title","taskType","suggestedFee","posterId"], properties: {
        title: { type: "string" }, taskType: { type: "string", enum: ["delivery","go-somewhere","interact","gather-info","physical-action","verification"] },
        category: { type: "string" }, details: { type: "string" },
        steps: { type: "array", items: { "$ref": "#/components/schemas/WorkflowStep" }, description: "Workflow steps" },
        suggestedFee: { type: "number" }, maxRunners: { type: "integer", default: 1 },
        privacyZone: { type: "integer", default: 100 }, posterId: { type: "string" },
        locationAddr: { type: "string" }, locationLat: { type: "number" }, locationLng: { type: "number" },
        action: { type: "string" }, proofType: { type: "string" },
        pickupAddr: { type: "string" }, pickupLat: { type: "number" }, pickupLng: { type: "number" },
        dropoffAddr: { type: "string" }, dropoffLat: { type: "number" }, dropoffLng: { type: "number" },
        itemCost: { type: "number" } } }
    } }
  };
  return new Response(JSON.stringify(spec, null, 2), {
    status: 200,
    headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
  });
});

// ── GET /task — x402 discovery (returns 402 with payment schema) ──
const taskDiscover = httpAction(async (_ctx, request) => {
  const origin = request.headers.get("Origin") || undefined;
  const resource = new URL("/task", request.url).toString();
  const paymentRequired = {
    x402Version: 2,
    accepts: [{
      scheme: "exact",
      network: NETWORK,
      maxAmountRequired: "1000000",
      resource,
      description: "RICO task posting — min $1 USDC",
      mimeType: "application/json",
      payTo: RECEIVING_WALLET,
      maxTimeoutSeconds: 300,
      asset: USDC_ADDRESS,
      extra: { name: "USD Coin", version: "2" },
    }],
  };
  const jsonStr = JSON.stringify(paymentRequired);
  const bytes = new TextEncoder().encode(jsonStr);
  let b64 = "";
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i], b1 = bytes[i + 1] ?? 0, b2 = bytes[i + 2] ?? 0;
    b64 += chars[b0 >> 2] + chars[((b0 & 3) << 4) | (b1 >> 4)] +
      (i + 1 < bytes.length ? chars[((b1 & 15) << 2) | (b2 >> 6)] : "=") +
      (i + 2 < bytes.length ? chars[b2 & 63] : "=");
  }
  return new Response(
    JSON.stringify({
      error: "Payment required",
      x402: true,
      description: "RICO — Agent workflows for the real world. Deliveries, moving, info gathering, verification. Pay in USDC on Base.",
      accepts: paymentRequired.accepts,
    }),
    {
      status: 402,
      headers: {
        "Content-Type": "application/json",
        "PAYMENT-REQUIRED": b64,
        ...corsHeaders(origin),
      },
    }
  );
});

// ── GET /.well-known/x402 — discovery fallback ──
const wellKnownX402 = httpAction(async (_ctx, request) => {
  const origin = request.headers.get("Origin") || undefined;
  return new Response(
    JSON.stringify({ version: 1, resources: ["POST /task"] }),
    { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders(origin) } }
  );
});

// ── SSE: Subscribe to bids for a task ──
// Polls every 3s, streams new bids as SSE events, auto-closes after ~90s.
// Clients reconnect with Last-Event-ID to resume from where they left off.
const subscribeBids = httpAction(async (ctx, request) => {
  const url = new URL(request.url);
  const taskId = url.searchParams.get("taskId");
  if (!taskId) {
    return json({ error: "Missing ?taskId= parameter" }, 400);
  }

  // Resume from last seen bid timestamp
  const lastEventId = request.headers.get("Last-Event-ID");
  let seenAfter = lastEventId ? parseFloat(lastEventId) : 0;

  const POLL_INTERVAL = 3000; // 3 seconds
  const MAX_DURATION = 90000; // 90 seconds then close (Convex has ~2min limit)
  const start = Date.now();

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      // Send initial comment to establish connection
      controller.enqueue(encoder.encode(": connected\n\n"));

      while (Date.now() - start < MAX_DURATION) {
        try {
          const bids: any[] = await ctx.runQuery(api.tasks.getBids, {
            taskId: taskId as Id<"tasks">,
          });

          // Filter to only new bids since last seen
          const newBids = bids.filter((b: any) => b.createdAt > seenAfter);

          for (const bid of newBids.reverse()) {
            const event = {
              id: bid._id,
              courierId: bid.courierId,
              courierName: bid.courierName,
              fee: bid.fee,
              comment: bid.comment,
              lat: bid.lat,
              lng: bid.lng,
              tripKm: bid.tripKm,
              courierScore: bid.courierScore,
              courierDeliveries: bid.courierDeliveries,
              createdAt: bid.createdAt,
            };
            controller.enqueue(
              encoder.encode(
                `id: ${bid.createdAt}\nevent: bid\ndata: ${JSON.stringify(event)}\n\n`
              )
            );
            seenAfter = Math.max(seenAfter, bid.createdAt);
          }

          // Also check task status — if no longer open, notify and close
          const task: any = await ctx.runQuery(api.tasks.getTask, {
            taskId: taskId as Id<"tasks">,
          });
          if (task && task.status !== "open") {
            controller.enqueue(
              encoder.encode(
                `event: status\ndata: ${JSON.stringify({ status: task.status })}\n\n`
              )
            );
            controller.close();
            return;
          }
        } catch (e: any) {
          controller.enqueue(
            encoder.encode(`event: error\ndata: ${JSON.stringify({ error: e.message })}\n\n`)
          );
        }

        // Wait before next poll
        await new Promise((r) => setTimeout(r, POLL_INTERVAL));
      }

      // Timeout — client should reconnect
      controller.enqueue(encoder.encode(`event: timeout\ndata: {}\n\n`));
      controller.close();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Last-Event-ID",
    },
  });
});

// ── Router ──
const http = httpRouter();

http.route({ path: "/task", method: "GET", handler: taskDiscover });
http.route({ path: "/task", method: "POST", handler: postTask });
http.route({ path: "/task", method: "OPTIONS", handler: corsOptions });

http.route({ path: "/accept-bid", method: "POST", handler: acceptBid });
http.route({ path: "/accept-bid", method: "OPTIONS", handler: corsOptions });

http.route({ path: "/confirm-delivery", method: "POST", handler: confirmDelivery });
http.route({ path: "/confirm-delivery", method: "OPTIONS", handler: corsOptions });

http.route({ path: "/cancel-task", method: "POST", handler: cancelTask });
http.route({ path: "/cancel-task", method: "OPTIONS", handler: corsOptions });

http.route({ path: "/subscribe/bids", method: "GET", handler: subscribeBids });
http.route({ path: "/subscribe/bids", method: "OPTIONS", handler: corsOptions });

http.route({ path: "/health", method: "GET", handler: health });
http.route({ path: "/openapi.json", method: "GET", handler: openapi });
http.route({ path: "/openapi.json", method: "OPTIONS", handler: corsOptions });
http.route({ path: "/.well-known/openapi.json", method: "GET", handler: openapi });
http.route({ path: "/.well-known/openapi.json", method: "OPTIONS", handler: corsOptions });
http.route({ path: "/.well-known/x402", method: "GET", handler: wellKnownX402 });
http.route({ path: "/.well-known/x402", method: "OPTIONS", handler: corsOptions });

export default http;
