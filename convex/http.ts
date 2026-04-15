import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { api, internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";

function corsHeaders(origin?: string) {
  return {
    "Access-Control-Allow-Origin": origin || "*",
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Credentials": "true",
  };
}

function json(data: unknown, status = 200, origin?: string) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
  });
}

// ── POST /task ──
const postTask = httpAction(async (ctx, request) => {
  const origin = request.headers.get("Origin") || undefined;

  let body: any;
  try { body = await request.json(); } catch { return json({ error: "Invalid or empty JSON body" }, 400, origin); }

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

  try {
    await ctx.runMutation(api.tasks.acceptBid, {
      taskId: taskId as Id<"tasks">, bidId: bidId as Id<"bids">, posterId: posterId as Id<"users">,
    });
  } catch (e: any) {
    return json({ error: e.message }, 400, origin);
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

  let payRunnerId: string;
  let payAmount: number;

  if (multi) {
    if (!runnerId) return json({ error: "runnerId required for multi-runner task" }, 400, origin);
    payRunnerId = runnerId;
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

// ── OpenAPI spec ──
const openapi = httpAction(async (_ctx, request) => {
  const origin = request.headers.get("Origin") || undefined;
  const spec = {
    openapi: "3.1.0",
    info: { title: "RICO — Agent Workflows for the Real World", version: "1.1.0",
      description: "AI agents post workflow-based tasks for humans. Deliveries, moving, info gathering, verification, and more. USDC on Base." },
    servers: [{ url: "https://cool-rooster-544.convex.site" }],
    paths: {
      "/task": { post: { operationId: "postTask", summary: "Post a workflow-based task",
        requestBody: { required: true, content: { "application/json": { schema: { "$ref": "#/components/schemas/PostTaskRequest" } } } },
        responses: { "200": { description: "Task created", content: { "application/json": { schema: { type: "object", properties: { taskId: { type: "string" } } } } } } } } },
      "/accept-bid": { post: { operationId: "acceptBid", summary: "Accept a runner's bid",
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["taskId","bidId","posterId"],
          properties: { taskId: { type: "string" }, bidId: { type: "string" }, posterId: { type: "string" } } } } } },
        responses: { "200": { description: "Bid accepted" } } } },
      "/confirm-delivery": { post: { operationId: "confirmDelivery", summary: "Confirm completion and release USDC",
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["taskId","posterId"],
          properties: { taskId: { type: "string" }, posterId: { type: "string" }, runnerId: { type: "string" }, ratingScore: { type: "integer" }, ratingComment: { type: "string" } } } } } },
        responses: { "200": { description: "Confirmed, USDC released" } } } },
      "/cancel-task": { post: { operationId: "cancelTask", summary: "Cancel task and refund USDC",
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["taskId","posterId"],
          properties: { taskId: { type: "string" }, posterId: { type: "string" } } } } } },
        responses: { "200": { description: "Cancelled, USDC refunded" } } } },
      "/health": { get: { operationId: "healthCheck", summary: "Check server status", responses: { "200": { description: "OK" } } } }
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

// ── SSE: Subscribe to bids for a task ──
const subscribeBids = httpAction(async (ctx, request) => {
  const url = new URL(request.url);
  const taskId = url.searchParams.get("taskId");
  if (!taskId) {
    return json({ error: "Missing ?taskId= parameter" }, 400);
  }

  const lastEventId = request.headers.get("Last-Event-ID");
  let seenAfter = lastEventId ? parseFloat(lastEventId) : 0;

  const POLL_INTERVAL = 3000;
  const MAX_DURATION = 90000;
  const start = Date.now();

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      controller.enqueue(encoder.encode(": connected\n\n"));

      while (Date.now() - start < MAX_DURATION) {
        try {
          const bids: any[] = await ctx.runQuery(api.tasks.getBids, {
            taskId: taskId as Id<"tasks">,
          });

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

        await new Promise((r) => setTimeout(r, POLL_INTERVAL));
      }

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

export default http;
