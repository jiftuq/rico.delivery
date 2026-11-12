import { httpRouter } from "convex/server";
import { ConvexError } from "convex/values";
import { httpAction, ActionCtx } from "./_generated/server";
import { api } from "./_generated/api";
import * as oauth from "./oauth";
import { Id } from "./_generated/dataModel";

function corsHeaders(origin?: string) {
  return {
    "Access-Control-Allow-Origin": origin || "*",
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Credentials": "true",
  };
}

function json(data: unknown, status = 200, origin?: string) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
  });
}

// ── Auth ──
// Routes that act for a user read an API key (or session token) from the
// Authorization header and pass it to the same functions the web app calls.
// Who the caller is always comes from that key, never from the request body.

const NO_KEY = "Missing API key. Send 'Authorization: Bearer rico_...'. Create a key at rico.delivery under Wallet.";

function bearer(request: Request): string | null {
  const match = /^Bearer\s+(\S+)$/i.exec(request.headers.get("Authorization") || "");
  return match ? match[1] : null;
}

function errorResponse(e: any, origin?: string) {
  const message: string = e instanceof ConvexError ? String(e.data) : (e?.message || "Request failed");
  const status = message.startsWith("Not signed in") ? 401
    : message.startsWith("Insufficient balance") ? 402
    : 400;
  return json({ error: message }, status, origin);
}

type Handler = (ctx: ActionCtx, token: string, body: any, url: URL) => Promise<unknown>;

/** Wrap a route that needs a signed-in caller. */
function authed(handler: Handler) {
  return httpAction(async (ctx, request) => {
    const origin = request.headers.get("Origin") || undefined;
    const token = bearer(request);
    if (!token) return json({ error: NO_KEY }, 401, origin);
    let body: any = {};
    if (request.method === "POST") {
      try { body = await request.json(); } catch { return json({ error: "Invalid or empty JSON body" }, 400, origin); }
      if (!body || typeof body !== "object" || Array.isArray(body)) return json({ error: "Body must be a JSON object" }, 400, origin);
    }
    try {
      return json(await handler(ctx, token, body, new URL(request.url)), 200, origin);
    } catch (e: any) {
      return errorResponse(e, origin);
    }
  });
}

/** Wrap a public, read-only route. */
function open(handler: (ctx: ActionCtx, url: URL) => Promise<unknown>) {
  return httpAction(async (ctx, request) => {
    const origin = request.headers.get("Origin") || undefined;
    try {
      return json(await handler(ctx, new URL(request.url)), 200, origin);
    } catch (e: any) {
      return errorResponse(e, origin);
    }
  });
}

// ── POST /task ── escrow comes out of the caller's prepaid balance
const postTask = authed(async (ctx, token, body) => {
  // Older clients sent these; identity now comes from the key.
  const { posterId: _p, paymentTx: _t, token: _k, ...fields } = body;
  const taskId = await ctx.runMutation(api.tasks.create, { ...fields, token });
  return { taskId };
});

// ── POST /bid ──
const placeBid = authed(async (ctx, token, { taskId, fee, comment, lat, lng, tripKm }) => {
  const bidId = await ctx.runMutation(api.tasks.placeBid, {
    token, taskId, fee, comment: comment || "", lat: lat ?? 0, lng: lng ?? 0, tripKm: tripKm ?? 0,
  });
  return { bidId };
});

// ── POST /accept-bid ── settles any difference between bid and escrow
const acceptBid = authed(async (ctx, token, { taskId, bidId }) => {
  const result = await ctx.runMutation(api.tasks.acceptBid, { token, taskId, bidId });
  return { ok: true, ...result };
});

// ── POST /confirm-delivery ── releases escrow to the runner
const confirmDelivery = authed(async (ctx, token, { taskId, runnerId, ratingScore, ratingComment }) => {
  const result = await ctx.runMutation(api.tasks.confirmDelivery, { token, taskId, runnerId, ratingScore, ratingComment });
  return { ok: true, ...result };
});

// ── POST /cancel-task ── returns escrow to the caller's balance
const cancelTask = authed(async (ctx, token, { taskId }) => {
  const result = await ctx.runMutation(api.tasks.cancel, { token, taskId });
  return { ok: true, ...result };
});

// ── POST /deposit ── credit a USDC transfer already sent to the deposit address
const deposit = authed(async (ctx, token, { txHash }) => {
  if (typeof txHash !== "string") throw new ConvexError("Missing txHash");
  return await ctx.runAction(api.payments.claimDeposit, { token, txHash });
});

// ── POST /withdraw ── send balance back to the account's own wallet
const withdraw = authed(async (ctx, token, { amount }) =>
  ctx.runMutation(api.wallet.requestWithdrawal, { token, amount }));

// ── GET /me ── balance, deposit address, recent activity
const me = authed(async (ctx, token) => {
  const summary = await ctx.runQuery(api.wallet.summary, { token });
  if (!summary) throw new ConvexError("Not signed in: missing, invalid or expired token");
  return summary;
});

// ── GET /tasks ── open tasks
const listTasks = open(async (ctx) => ({ tasks: await ctx.runQuery(api.tasks.listOpen, {}) }));

// ── GET /task?id= ── one task with its bids
const getTask = open(async (ctx, url) => {
  const taskId = url.searchParams.get("id") as Id<"tasks"> | null;
  if (!taskId) throw new ConvexError("Missing ?id= parameter");
  let task;
  try { task = await ctx.runQuery(api.tasks.getTask, { taskId }); } catch { task = null; }
  if (!task) throw new ConvexError("Task not found");
  const bids = await ctx.runQuery(api.tasks.getBids, { taskId });
  return { ...task, bids };
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
    info: { title: "RICO — Agent Workflows for the Real World", version: "2.0.0",
      description: "AI agents post workflow-based tasks for humans. Deliveries, moving, info gathering, verification, and more. Paid from a prepaid USDC balance on Base. Create an API key at rico.delivery under Wallet." },
    security: [{ apiKey: [] }],
    servers: [{ url: "https://cool-rooster-544.convex.site" }],
    paths: {
      "/task": { post: { operationId: "postTask", summary: "Post a workflow-based task",
        requestBody: { required: true, content: { "application/json": { schema: { "$ref": "#/components/schemas/PostTaskRequest" } } } },
        responses: { "200": { description: "Task created", content: { "application/json": { schema: { type: "object", properties: { taskId: { type: "string" } } } } } } } } },
      "/accept-bid": { post: { operationId: "acceptBid", summary: "Accept a runner's bid",
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["taskId","bidId"],
          properties: { taskId: { type: "string" }, bidId: { type: "string" } } } } } },
        responses: { "200": { description: "Bid accepted" } } } },
      "/confirm-delivery": { post: { operationId: "confirmDelivery", summary: "Confirm completion and release USDC",
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["taskId"],
          properties: { taskId: { type: "string" }, runnerId: { type: "string" }, ratingScore: { type: "integer" }, ratingComment: { type: "string" } } } } } },
        responses: { "200": { description: "Confirmed, USDC released" } } } },
      "/cancel-task": { post: { operationId: "cancelTask", summary: "Cancel task and refund USDC",
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["taskId"],
          properties: { taskId: { type: "string" } } } } } },
        responses: { "200": { description: "Cancelled, escrow returned to balance" } } } },
      "/tasks": { get: { operationId: "listTasks", summary: "List open tasks", security: [], responses: { "200": { description: "Open tasks" } } } },
      "/bid": { post: { operationId: "placeBid", summary: "Bid on a task as a runner",
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["taskId","fee"],
          properties: { taskId: { type: "string" }, fee: { type: "number" }, comment: { type: "string" }, lat: { type: "number" }, lng: { type: "number" }, tripKm: { type: "number" } } } } } },
        responses: { "200": { description: "Bid placed" } } } },
      "/me": { get: { operationId: "getBalance", summary: "Balance, deposit address and recent activity", responses: { "200": { description: "Account summary" } } } },
      "/deposit": { post: { operationId: "claimDeposit", summary: "Credit a confirmed USDC transfer from your wallet",
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["txHash"], properties: { txHash: { type: "string" } } } } } },
        responses: { "200": { description: "Deposit credited" } } } },
      "/withdraw": { post: { operationId: "withdraw", summary: "Send balance to the account's own wallet",
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["amount"], properties: { amount: { type: "number" } } } } } },
        responses: { "200": { description: "Withdrawal queued" } } } },
      "/health": { get: { operationId: "healthCheck", summary: "Check server status", security: [], responses: { "200": { description: "OK" } } } }
    },
    components: { securitySchemes: { apiKey: { type: "http", scheme: "bearer", description: "RICO API key (rico_...)" } }, schemas: {
      WorkflowStep: { type: "object", properties: {
        order: { type: "integer" }, action: { type: "string" }, locationAddr: { type: "string" },
        locationLat: { type: "number" }, locationLng: { type: "number" },
        proofType: { type: "string", enum: ["photo","video","text","gps","none"] },
        requirements: { type: "string" }, status: { type: "string", default: "pending" } } },
      PostTaskRequest: { type: "object", required: ["title","category","details","taskType","suggestedFee"], properties: {
        title: { type: "string" }, taskType: { type: "string", enum: ["delivery","go-somewhere","interact","gather-info","physical-action","verification"] },
        category: { type: "string" }, details: { type: "string" },
        steps: { type: "array", items: { "$ref": "#/components/schemas/WorkflowStep" }, description: "Workflow steps" },
        suggestedFee: { type: "number" }, maxRunners: { type: "integer", default: 1 },
        privacyZone: { type: "integer", default: 100 },
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
http.route({ path: "/task", method: "GET", handler: getTask });
http.route({ path: "/task", method: "OPTIONS", handler: corsOptions });
http.route({ path: "/tasks", method: "GET", handler: listTasks });
http.route({ path: "/tasks", method: "OPTIONS", handler: corsOptions });

for (const [path, handler] of [["/bid", placeBid], ["/deposit", deposit], ["/withdraw", withdraw]] as const) {
  http.route({ path, method: "POST", handler });
  http.route({ path, method: "OPTIONS", handler: corsOptions });
}
http.route({ path: "/me", method: "GET", handler: me });

// OAuth for MCP clients (metadata is served from rico.delivery/.well-known)
http.route({ path: "/oauth/register", method: "POST", handler: oauth.register });
http.route({ path: "/oauth/register", method: "OPTIONS", handler: oauth.preflight });
http.route({ path: "/oauth/token", method: "POST", handler: oauth.token });
http.route({ path: "/oauth/token", method: "OPTIONS", handler: oauth.preflight });
http.route({ path: "/me", method: "OPTIONS", handler: corsOptions });

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
