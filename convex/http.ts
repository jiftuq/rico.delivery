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

// ── OG image (SVG) ──
const ogImage = httpAction(async (ctx) => {
  const tasks: any[] = await ctx.runQuery(api.tasks.listOpen, {});
  const count = tasks.length;
  const top = tasks.slice(0, 3).map((t: any, i: number) =>
    `<text x="60" y="${460 + i * 32}" font-family="monospace" font-size="18" fill="#888">${t.title.slice(0, 50)} — $${t.suggestedFee}</text>`
  ).join("");

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <rect width="1200" height="630" fill="#0b0c12"/>
  <rect x="60" y="60" width="60" height="60" rx="14" fill="#ffd000"/>
  <text x="90" y="105" font-family="monospace" font-size="32" fill="#000" text-anchor="middle" font-weight="800">&#9670;</text>
  <text x="140" y="105" font-family="monospace" font-size="32" fill="#fff" font-weight="700" letter-spacing="4">RICO</text>
  <text x="60" y="260" font-family="sans-serif" font-size="56" fill="#fff" font-weight="800">Humans do what agents can't.</text>
  <text x="60" y="330" font-family="sans-serif" font-size="28" fill="#00ff87" font-weight="500">Post. Bid. Prove. — USDC on Base</text>
  <text x="60" y="400" font-family="monospace" font-size="22" fill="#ffd000">${count} open task${count !== 1 ? "s" : ""} in San Francisco</text>
  ${top}
  <text x="60" y="590" font-family="monospace" font-size="16" fill="#444">rico.delivery</text>
</svg>`;

  return new Response(svg, {
    headers: { "Content-Type": "image/svg+xml", "Cache-Control": "public, max-age=60" },
  });
});

// ── Farcaster manifest ──
const farcasterManifest = httpAction(async () => {
  const manifest = {
    accountAssociation: {
      header: "eyJmaWQiOjAsInR5cGUiOiJjdXN0b2R5Iiwia2V5IjoiMHgwMCJ9",
      payload: "eyJkb21haW4iOiJyaWNvLmRlbGl2ZXJ5In0",
      signature: "0x00",
    },
    frame: {
      version: "1",
      name: "RICO",
      iconUrl: "https://cool-rooster-544.convex.site/og.svg",
      homeUrl: "https://rico.delivery",
      splashImageUrl: "https://cool-rooster-544.convex.site/og.svg",
      splashBackgroundColor: "#0b0c12",
      webhookUrl: "https://cool-rooster-544.convex.site/frame",
    },
  };
  return new Response(JSON.stringify(manifest), {
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
  });
});

// ── Neynar frame validation ──
async function validateFrameAction(messageBytes: string): Promise<{
  valid: boolean;
  fid?: number;
  username?: string;
  displayName?: string;
  pfpUrl?: string;
  custodyAddress?: string;
  verifiedAddresses?: string[];
  buttonIndex?: number;
  inputText?: string;
} | null> {
  const apiKey = process.env.NEYNAR_API_KEY;
  if (!apiKey) return null;

  const res = await fetch("https://api.neynar.com/v2/farcaster/frame/validate", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": apiKey },
    body: JSON.stringify({ message_bytes_in_hex: messageBytes, cast_reaction_context: true }),
  });

  if (!res.ok) return null;
  const data = await res.json();
  if (!data.valid) return { valid: false };

  const action = data.action;
  return {
    valid: true,
    fid: action.interactor?.fid,
    username: action.interactor?.username,
    displayName: action.interactor?.display_name,
    pfpUrl: action.interactor?.pfp_url,
    custodyAddress: action.interactor?.custody_address,
    verifiedAddresses: action.interactor?.verified_addresses?.eth_addresses || [],
    buttonIndex: action.tapped_button?.index,
    inputText: action.input?.text,
  };
}

function esc(s: string) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function frameHtml(opts: {
  title: string;
  description: string;
  image: string;
  postUrl?: string;
  buttons: { label: string; action: "post" | "link" | "post_redirect"; target?: string }[];
}) {
  const btnMeta = opts.buttons.map((b, i) => {
    let meta = `\n<meta property="fc:frame:button:${i + 1}" content="${esc(b.label)}" />`;
    meta += `\n<meta property="fc:frame:button:${i + 1}:action" content="${b.action}" />`;
    if (b.target) meta += `\n<meta property="fc:frame:button:${i + 1}:target" content="${esc(b.target)}" />`;
    return meta;
  }).join("");

  const postMeta = opts.postUrl ? `\n<meta property="fc:frame:post_url" content="${esc(opts.postUrl)}" />` : "";

  return `<!DOCTYPE html>
<html><head>
<meta property="og:title" content="${esc(opts.title)}" />
<meta property="og:description" content="${esc(opts.description)}" />
<meta property="og:image" content="${esc(opts.image)}" />
<meta property="fc:frame" content="vNext" />
<meta property="fc:frame:image" content="${esc(opts.image)}" />
<meta property="fc:frame:image:aspect_ratio" content="1.91:1" />${postMeta}${btnMeta}
</head><body></body></html>`;
}

const CONVEX_SITE = "https://cool-rooster-544.convex.site";

// ── Per-task OG image ──
const taskOgImage = httpAction(async (ctx, request) => {
  const url = new URL(request.url);
  const taskId = url.searchParams.get("id");
  if (!taskId) return new Response("Missing id", { status: 400 });

  let task: any;
  try {
    task = await ctx.runQuery(api.tasks.getTask, { taskId: taskId as Id<"tasks"> });
  } catch {
    return new Response("Invalid task", { status: 400 });
  }
  if (!task) return new Response("Task not found", { status: 404 });

  const title = (task.title || "Task").slice(0, 60);
  const details = (task.details || "").slice(0, 120);
  const fee = task.suggestedFee || 0;
  const loc = (task.locationAddr || task.pickupAddr || "San Francisco").slice(0, 50);

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <rect width="1200" height="630" fill="#0b0c12"/>
  <rect x="60" y="60" width="60" height="60" rx="14" fill="#ffd000"/>
  <text x="90" y="105" font-family="monospace" font-size="32" fill="#000" text-anchor="middle" font-weight="800">&#9670;</text>
  <text x="140" y="105" font-family="monospace" font-size="28" fill="#fff" font-weight="700" letter-spacing="4">RICO</text>
  <text x="1140" y="105" font-family="monospace" font-size="42" fill="#00ff87" text-anchor="end" font-weight="800">$${fee}</text>
  <text x="60" y="250" font-family="sans-serif" font-size="48" fill="#fff" font-weight="800">${esc(title)}</text>
  <text x="60" y="320" font-family="sans-serif" font-size="22" fill="#999">${esc(details)}</text>
  <text x="60" y="420" font-family="monospace" font-size="18" fill="#ffd000">📍 ${esc(loc)}</text>
  <text x="60" y="460" font-family="monospace" font-size="18" fill="#0052ff">${esc((task.taskType || "").toUpperCase())}</text>
  <text x="60" y="590" font-family="monospace" font-size="16" fill="#444">rico.delivery</text>
</svg>`;

  return new Response(svg, {
    headers: { "Content-Type": "image/svg+xml", "Cache-Control": "public, max-age=30" },
  });
});

// ── Farcaster Frame endpoint ──
const frameHandler = httpAction(async (ctx, request) => {
  const origin = request.headers.get("Origin") || undefined;
  const url = new URL(request.url);
  const action = url.searchParams.get("a") || "home";
  const idx = parseInt(url.searchParams.get("i") || "0", 10);

  const tasks: any[] = await ctx.runQuery(api.tasks.listOpen, {});
  const count = tasks.length;

  if (request.method === "GET") {
    const html = frameHtml({
      title: `RICO — ${count} open tasks in SF`,
      description: count > 0
        ? tasks.slice(0, 3).map((t: any) => `${t.title} — $${t.suggestedFee}`).join(" | ")
        : "No open tasks. Be the first to post!",
      image: `${CONVEX_SITE}/og.svg`,
      postUrl: `${CONVEX_SITE}/frame?a=browse&i=0`,
      buttons: [
        { label: count > 0 ? `Browse ${count} Tasks →` : "Post a Task", action: "post" },
        { label: "Open App", action: "link", target: "https://rico.delivery" },
      ],
    });

    return new Response(html, {
      headers: { "Content-Type": "text/html", ...corsHeaders(origin) },
    });
  }

  // POST — validate via Neynar
  let body: any;
  try { body = await request.json(); } catch { return json({ error: "Invalid body" }, 400, origin); }

  const messageBytes = body.trustedData?.messageBytes;
  let user = messageBytes ? await validateFrameAction(messageBytes) : null;

  // Fall back to untrustedData if Neynar key not set (dev only)
  if (!user && !process.env.NEYNAR_API_KEY) {
    user = {
      valid: true,
      fid: body.untrustedData?.fid,
      buttonIndex: body.untrustedData?.buttonIndex,
      verifiedAddresses: [],
    };
  }

  if (!user || !user.valid) {
    return new Response(frameHtml({
      title: "RICO — Error",
      description: "Invalid frame action",
      image: `${CONVEX_SITE}/og.svg`,
      postUrl: `${CONVEX_SITE}/frame`,
      buttons: [{ label: "← Back", action: "post" }],
    }), { headers: { "Content-Type": "text/html", ...corsHeaders(origin) } });
  }

  console.log(`Frame action from @${user.username || user.fid} (FID: ${user.fid}), button: ${user.buttonIndex}, a=${action}`);

  const btn = user.buttonIndex || 1;

  // Navigation logic
  let nextAction = action;
  let nextIdx = idx;

  if (action === "home") {
    if (btn === 1) { nextAction = count > 0 ? "browse" : "home"; nextIdx = 0; }
  } else if (action === "browse") {
    if (btn === 1) nextIdx = (idx - 1 + count) % count; // prev
    if (btn === 2) nextIdx = (idx + 1) % count;         // next
    if (btn === 3) {
      // "Open" → redirect to web app
      return new Response(frameHtml({
        title: "RICO",
        description: "Opening task",
        image: `${CONVEX_SITE}/og.svg`,
        buttons: [{ label: "Go to Task", action: "link", target: `https://rico.delivery` }],
      }), { headers: { "Content-Type": "text/html", ...corsHeaders(origin) } });
    }
  }

  // Render current state
  if (nextAction === "browse" && count > 0) {
    const task = tasks[nextIdx];
    const html = frameHtml({
      title: `${task.title} — $${task.suggestedFee}`,
      description: (task.details || "").slice(0, 140),
      image: `${CONVEX_SITE}/task-og?id=${task._id}`,
      postUrl: `${CONVEX_SITE}/frame?a=browse&i=${nextIdx}`,
      buttons: [
        { label: "← Prev", action: "post" },
        { label: "Next →", action: "post" },
        { label: `Bid $${task.suggestedFee}`, action: "link", target: "https://rico.delivery" },
      ],
    });
    return new Response(html, { headers: { "Content-Type": "text/html", ...corsHeaders(origin) } });
  }

  // Default: back to home
  const html = frameHtml({
    title: `RICO — ${count} open tasks`,
    description: "Humans do what agents can't.",
    image: `${CONVEX_SITE}/og.svg`,
    postUrl: `${CONVEX_SITE}/frame?a=home`,
    buttons: [
      { label: count > 0 ? `Browse ${count} Tasks →` : "Open App", action: count > 0 ? "post" : "link", target: count > 0 ? undefined : "https://rico.delivery" },
      { label: "Open App", action: "link", target: "https://rico.delivery" },
    ],
  });
  return new Response(html, { headers: { "Content-Type": "text/html", ...corsHeaders(origin) } });
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

http.route({ path: "/og.svg", method: "GET", handler: ogImage });
http.route({ path: "/task-og", method: "GET", handler: taskOgImage });
http.route({ path: "/.well-known/farcaster.json", method: "GET", handler: farcasterManifest });
http.route({ path: "/frame", method: "GET", handler: frameHandler });
http.route({ path: "/frame", method: "POST", handler: frameHandler });
http.route({ path: "/frame", method: "OPTIONS", handler: corsOptions });

export default http;
