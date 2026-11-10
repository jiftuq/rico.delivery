import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { createWalletClient, http, parseUnits, encodeFunctionData } from "viem";
import { base } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";

// ── Config ──
const CONVEX_SITE_URL = process.env.RICO_URL || "https://cool-rooster-544.convex.site";
// Agent's wallet private key (0x...). Set per server instance by createRicoServer,
// so a hosted endpoint can run without ever touching the wallet.
let PRIVATE_KEY;
const VERSION = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")).version;

// MCP Apps: tools that carry _meta.ui.resourceUri render this HTML in the chat.
const TASKS_UI_URI = "ui://rico/tasks.html";
const UI_MIME_TYPE = "text/html;profile=mcp-app";
const TASKS_UI_HTML = readFileSync(new URL("./ui/tasks.html", import.meta.url), "utf8");
const USDC_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const USDC_DECIMALS = 6;

// ── Helpers ──

async function apiCall(path, body) {
  const url = `${CONVEX_SITE_URL}${path}`;

  // First call — may get 402
  const res1 = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (res1.status !== 402) {
    return { status: res1.status, data: await res1.json() };
  }

  // 402 — need to pay
  if (!PRIVATE_KEY) {
    return { status: 402, data: { error: "Payment required but no RICO_PRIVATE_KEY configured" } };
  }

  const paymentInfo = await res1.json();
  const requirements = paymentInfo.accepts?.[0];
  if (!requirements) {
    return { status: 402, data: { error: "No payment requirements in 402 response" } };
  }

  // Sign x402 payment
  const paymentHeader = await signX402Payment(requirements);

  // Retry with payment
  const res2 = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Payment": paymentHeader,
    },
    body: JSON.stringify(body),
  });

  return { status: res2.status, data: await res2.json() };
}

async function signX402Payment(requirements) {
  const account = privateKeyToAccount(PRIVATE_KEY);
  const client = createWalletClient({
    account,
    chain: base,
    transport: http(),
  });

  const amount = BigInt(requirements.maxAmountRequired);
  const payTo = requirements.payTo;
  const nonce = BigInt("0x" + Array.from(crypto.getRandomValues(new Uint8Array(32))).map(b => b.toString(16).padStart(2, "0")).join(""));
  const validAfter = 0n;
  const validBefore = BigInt(Math.floor(Date.now() / 1000) + (requirements.maxTimeoutSeconds || 300));

  // EIP-712 typed data for TransferWithAuthorization (EIP-3009)
  const domain = {
    name: requirements.extra?.name || "USD Coin",
    version: requirements.extra?.version || "2",
    chainId: 8453n,
    verifyingContract: USDC_ADDRESS,
  };

  const types = {
    TransferWithAuthorization: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
      { name: "validAfter", type: "uint256" },
      { name: "validBefore", type: "uint256" },
      { name: "nonce", type: "bytes32" },
    ],
  };

  const message = {
    from: account.address,
    to: payTo,
    value: amount,
    validAfter,
    validBefore,
    nonce,
  };

  const signature = await client.signTypedData({ domain, types, primaryType: "TransferWithAuthorization", message });

  // Build x402 payment payload
  const payload = {
    x402Version: 1,
    scheme: "exact",
    network: "base",
    payload: {
      signature,
      authorization: {
        from: account.address,
        to: payTo,
        value: amount.toString(),
        validAfter: validAfter.toString(),
        validBefore: validBefore.toString(),
        nonce: nonce.toString(),
      },
    },
  };

  return btoa(JSON.stringify(payload));
}

async function convexQuery(functionName, args) {
  // Use Convex HTTP query endpoint
  const url = `${CONVEX_SITE_URL.replace(".site", ".cloud")}/api/query`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: functionName, args }),
  });
  return await res.json();
}

// ── MCP Server ──

/**
 * Build a RICO MCP server.
 * @param {object} [opts]
 * @param {boolean} [opts.allowWallet=true] Use RICO_PRIVATE_KEY to pay x402 requests.
 * @param {number} [opts.maxWaitSeconds=90] Upper bound for wait_for_bids.
 */
export function createRicoServer({ allowWallet = true, maxWaitSeconds = 90 } = {}) {

  const server = new McpServer({ name: "rico", version: VERSION });
  PRIVATE_KEY = allowWallet ? process.env.RICO_PRIVATE_KEY : undefined;

  // Tool: Post a workflow-based task
  server.tool(
    "post_task",
    "Post a workflow-based task on RICO. Every task is a sequence of steps. Each step has an action, optional location, proof type, and requirements. Payment in USDC on Base via x402. Always prefer using 'steps' to define the workflow.",
    {
      title: z.string().describe("Short task title"),
      // Workflow steps (preferred way to define tasks)
      steps: z.array(z.object({
        action: z.string().describe("What the runner does at this step"),
        locationAddr: z.string().optional().describe("Address for this step"),
        locationLat: z.number().optional(),
        locationLng: z.number().optional(),
        proofType: z.enum(["photo", "video", "text", "gps", "none"]).optional().describe("Proof required at this step"),
        requirements: z.string().optional().describe("Equipment: van, camera, ID, etc."),
      })).optional().describe("Workflow steps (ordered). Example: [{action:'Go to store',proofType:'gps'},{action:'Buy items',proofType:'photo'},{action:'Deliver',locationAddr:'...',proofType:'photo'}]"),
      taskType: z.enum(["delivery", "go-somewhere", "interact", "gather-info", "physical-action", "verification"]).describe("Type of task"),
      category: z.string().optional().describe("Category: delivery, food, grocery, moving, errand, social, info, verification, custom"),
      details: z.string().optional().describe("Additional instructions (auto-generated from steps if omitted)"),
      // Legacy flat fields (use steps instead)
      locationAddr: z.string().optional().describe("Single location (use steps instead)"),
      locationLat: z.number().optional(),
      locationLng: z.number().optional(),
      action: z.string().optional().describe("Single action (use steps instead)"),
      proofType: z.enum(["photo", "video", "text", "gps", "none"]).optional(),
      targetPerson: z.string().optional(),
      pickupAddr: z.string().optional().describe("Pickup address (delivery without steps)"),
      pickupLat: z.number().optional(),
      pickupLng: z.number().optional(),
      dropoffAddr: z.string().optional().describe("Dropoff address (delivery without steps)"),
      dropoffLat: z.number().optional(),
      dropoffLng: z.number().optional(),
      itemCost: z.number().optional(),
      // Pricing
      suggestedFee: z.number().describe("Fee per runner in USDC"),
      maxRunners: z.number().optional().describe("Number of runners needed (default 1, max 100)"),
      privacyZone: z.number().optional().describe("Privacy zone radius in meters (100-500)"),
      posterId: z.string().describe("Convex user ID of the poster"),
    },
    async (args) => {
      const body = { ...args, category: args.category || args.taskType };
      // Add order and status to steps
      if (body.steps) {
        body.steps = body.steps.map((s, i) => ({ ...s, order: i + 1, status: "pending" }));
        // Auto-generate details from steps if not provided
        if (!body.details) {
          body.details = body.steps.map((s, i) => `${i + 1}. ${s.action}`).join(" → ");
        }
        // Derive locations from steps for delivery tasks
        const locs = body.steps.filter(s => s.locationAddr);
        if (locs.length >= 2 && body.taskType === "delivery") {
          body.pickupAddr = body.pickupAddr || locs[0].locationAddr;
          body.pickupLat = body.pickupLat || locs[0].locationLat || 50.85;
          body.pickupLng = body.pickupLng || locs[0].locationLng || 4.35;
          body.dropoffAddr = body.dropoffAddr || locs[locs.length - 1].locationAddr;
          body.dropoffLat = body.dropoffLat || locs[locs.length - 1].locationLat || 50.85;
          body.dropoffLng = body.dropoffLng || locs[locs.length - 1].locationLng || 4.35;
          body.itemCost = body.itemCost || 0;
        } else if (locs.length > 0) {
          body.locationAddr = body.locationAddr || locs[0].locationAddr;
          body.locationLat = body.locationLat || locs[0].locationLat || 50.85;
          body.locationLng = body.locationLng || locs[0].locationLng || 4.35;
        }
      }
      const result = await apiCall("/task", body);
      return {
        content: [{ type: "text", text: JSON.stringify(result.data, null, 2) }],
      };
    }
  );

  // UI resource rendered in the chat for list_tasks / get_task (MCP Apps)
  server.registerResource(
    "rico-tasks-ui",
    TASKS_UI_URI,
    { title: "RICO task board", description: "Interactive board of open RICO tasks", mimeType: UI_MIME_TYPE },
    async (uri) => ({
      contents: [{
        uri: uri.href,
        mimeType: UI_MIME_TYPE,
        text: TASKS_UI_HTML,
        _meta: { ui: { prefersBorder: true } },
      }],
    })
  );
  const tasksUiMeta = { ui: { resourceUri: TASKS_UI_URI }, "ui/resourceUri": TASKS_UI_URI };

  // Tool: List open tasks
  server.registerTool(
    "list_tasks",
    {
      title: "List open RICO tasks",
      description: "List currently open tasks on RICO that runners can bid on. In clients that support MCP Apps this also shows an interactive task board.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
      _meta: tasksUiMeta,
    },
    async () => {
      const result = await convexQuery("tasks:listOpen", {});
      if (result.status === "error") {
        return { isError: true, content: [{ type: "text", text: `Could not list tasks: ${result.errorMessage}` }] };
      }
      const tasks = (result.value || []).map(t => ({
        id: t._id,
        title: t.title,
        type: t.taskType || "delivery",
        category: t.category,
        fee: t.suggestedFee,
        itemCost: t.itemCost || undefined,
        maxRunners: t.maxRunners || 1,
        accepted: t.acceptedCount || 0,
        bidCount: t.bidCount || 0,
        location: t.locationAddr || t.pickupAddr,
        dropoff: t.dropoffAddr,
        poster: t.posterName,
        createdAt: t.createdAt,
        steps: t.steps ? t.steps.map(s => ({ action: s.action, proof: s.proofType, status: s.status })) : undefined,
        action: t.action,
        proofType: t.proofType,
      }));
      return {
        content: [{ type: "text", text: JSON.stringify(tasks, null, 2) }],
        structuredContent: { view: "list", tasks },
      };
    }
  );

  // Tool: Get task details
  server.registerTool(
    "get_task",
    {
      title: "Get RICO task",
      description: "Get full details of a specific task including its bids.",
      inputSchema: { taskId: z.string().describe("Convex task ID") },
      annotations: { readOnlyHint: true, openWorldHint: true },
      _meta: tasksUiMeta,
    },
    async ({ taskId }) => {
      const [task, bids] = await Promise.all([
        convexQuery("tasks:getTask", { taskId }),
        convexQuery("tasks:getBids", { taskId }),
      ]);
      if (task.status === "error" || !task.value) {
        return {
          isError: true,
          content: [{ type: "text", text: `Task "${taskId}" not found. Use list_tasks to get valid task IDs.` }],
        };
      }
      const detail = { ...task.value, bids: bids.value || [] };
      return {
        content: [{ type: "text", text: JSON.stringify(detail, null, 2) }],
        structuredContent: { view: "task", task: detail },
      };
    }
  );

  // Tool: Place a bid on a task
  server.tool(
    "place_bid",
    "Place a bid on an open task as a runner.",
    {
      taskId: z.string().describe("Task ID to bid on"),
      courierId: z.string().describe("Your Convex user ID"),
      fee: z.number().describe("Your proposed fee in USDC"),
      comment: z.string().optional().describe("Why you're a good fit"),
      lat: z.number().describe("Your current latitude"),
      lng: z.number().describe("Your current longitude"),
      tripKm: z.number().describe("Estimated trip distance in km"),
    },
    async (args) => {
      // placeBid is a mutation, call it via the HTTP action would be complex
      // For now, return instructions
      return {
        content: [{
          type: "text",
          text: `To place a bid, the runner needs to use the RICO web UI or call the Convex mutation directly.\n\nBid details:\n${JSON.stringify(args, null, 2)}`
        }],
      };
    }
  );

  // Tool: Accept a bid (poster only)
  server.tool(
    "accept_bid",
    "Accept a runner's bid on your task. May require additional USDC payment if bid exceeds original escrow.",
    {
      taskId: z.string().describe("Task ID"),
      bidId: z.string().describe("Bid ID to accept"),
      posterId: z.string().describe("Your Convex user ID (must be the poster)"),
    },
    async (args) => {
      const result = await apiCall("/accept-bid", args);
      return {
        content: [{ type: "text", text: JSON.stringify(result.data, null, 2) }],
      };
    }
  );

  // Tool: Confirm delivery and pay runner
  server.tool(
    "confirm_delivery",
    "Confirm a runner completed the task and release USDC payment.",
    {
      taskId: z.string().describe("Task ID"),
      posterId: z.string().describe("Your Convex user ID"),
      runnerId: z.string().optional().describe("Runner ID (required for multi-runner tasks)"),
      ratingScore: z.number().min(1).max(5).optional().describe("Rating 1-5"),
      ratingComment: z.string().optional().describe("Review comment"),
    },
    async (args) => {
      const result = await apiCall("/confirm-delivery", args);
      return {
        content: [{ type: "text", text: JSON.stringify(result.data, null, 2) }],
      };
    }
  );

  // Tool: Cancel a task and get refund
  server.tool(
    "cancel_task",
    "Cancel an open task and get escrowed USDC refunded.",
    {
      taskId: z.string().describe("Task ID to cancel"),
      posterId: z.string().describe("Your Convex user ID"),
    },
    async (args) => {
      const result = await apiCall("/cancel-task", args);
      return {
        content: [{ type: "text", text: JSON.stringify(result.data, null, 2) }],
      };
    }
  );

  // Tool: Check health
  server.tool(
    "health",
    "Check if the RICO server is running.",
    {},
    async () => {
      try {
        const res = await fetch(`${CONVEX_SITE_URL}/health`);
        const data = await res.json();
        return { content: [{ type: "text", text: JSON.stringify(data) }] };
      } catch (e) {
        return { content: [{ type: "text", text: `Error: ${e.message}` }] };
      }
    }
  );

  // Tool: Wait for bids on a task (SSE subscription)
  server.tool(
    "wait_for_bids",
    "Subscribe to a task and wait for runners to place bids. Returns when at least one new bid arrives or after timeout. Use this after posting a task to watch for incoming bids.",
    {
      taskId: z.string().describe("Task ID to watch for bids"),
      timeoutSeconds: z.number().optional().describe(`How long to wait (default 60, max ${maxWaitSeconds})`),
    },
    async ({ taskId, timeoutSeconds }) => {
      const timeout = Math.min(timeoutSeconds || 60, maxWaitSeconds) * 1000;
      const url = `${CONVEX_SITE_URL}/subscribe/bids?taskId=${encodeURIComponent(taskId)}`;

      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeout);

        const res = await fetch(url, {
          headers: { Accept: "text/event-stream" },
          signal: controller.signal,
        });

        if (!res.ok) {
          clearTimeout(timer);
          const err = await res.text();
          return { content: [{ type: "text", text: `Error: ${res.status} ${err}` }] };
        }

        const bids = [];
        let taskStatus = null;

        // Read SSE stream
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop(); // keep incomplete line

          let currentEvent = null;
          for (const line of lines) {
            if (line.startsWith("event: ")) {
              currentEvent = line.slice(7).trim();
            } else if (line.startsWith("data: ") && currentEvent) {
              try {
                const data = JSON.parse(line.slice(6));
                if (currentEvent === "bid") {
                  bids.push(data);
                } else if (currentEvent === "status") {
                  taskStatus = data.status;
                } else if (currentEvent === "timeout") {
                  // Server-side timeout, stop reading
                  reader.cancel();
                }
              } catch {}
              currentEvent = null;
            } else if (line === "") {
              currentEvent = null;
            }
          }

          // If we got bids, return them
          if (bids.length > 0) {
            clearTimeout(timer);
            reader.cancel();
            break;
          }

          // If task status changed (no longer open), stop
          if (taskStatus && taskStatus !== "open") {
            clearTimeout(timer);
            reader.cancel();
            break;
          }
        }

        clearTimeout(timer);

        if (bids.length > 0) {
          return {
            content: [{
              type: "text",
              text: `${bids.length} new bid(s) received:\n${JSON.stringify(bids, null, 2)}`
            }],
          };
        }

        if (taskStatus) {
          return {
            content: [{ type: "text", text: `Task status changed to "${taskStatus}". No longer accepting bids.` }],
          };
        }

        return {
          content: [{ type: "text", text: "No bids received within timeout. You can call wait_for_bids again to keep waiting." }],
        };
      } catch (e) {
        if (e.name === "AbortError") {
          return {
            content: [{ type: "text", text: "No bids received within timeout. You can call wait_for_bids again to keep waiting." }],
          };
        }
        return { content: [{ type: "text", text: `Error: ${e.message}` }] };
      }
    }
  );

  return server;
}
