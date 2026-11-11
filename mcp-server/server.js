import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { readFileSync } from "node:fs";
import { z } from "zod";

// ── Config ──
const API_URL = (process.env.RICO_URL || "https://cool-rooster-544.convex.site").replace(/\/$/, "");
const VERSION = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")).version;

// MCP Apps: tools that carry _meta.ui.resourceUri render this HTML in the chat.
const TASKS_UI_URI = "ui://rico/tasks.html";
const UI_MIME_TYPE = "text/html;profile=mcp-app";
const TASKS_UI_HTML = readFileSync(new URL("./ui/tasks.html", import.meta.url), "utf8");

const NO_KEY =
  "No RICO API key configured. Create one at rico.delivery under Wallet, then set RICO_API_KEY " +
  "(local server) or add ?key=<your key> to the connector URL (remote server).";

// ── Helpers ──

/** Call the RICO HTTP API. Returns { ok, status, data }. */
async function api(method, path, { body, apiKey, auth = false } = {}) {
  if (auth && !apiKey) return { ok: false, status: 401, data: { error: NO_KEY } };
  try {
    const res = await fetch(`${API_URL}${path}`, {
      method,
      headers: {
        ...(body ? { "Content-Type": "application/json" } : {}),
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({ error: `Unexpected response (HTTP ${res.status})` }));
    return { ok: res.ok, status: res.status, data };
  } catch (e) {
    return { ok: false, status: 0, data: { error: `Could not reach RICO: ${e.message}` } };
  }
}

/** Turn an API response into a tool result, flagging failures as errors. */
function toolResult({ ok, status, data }) {
  if (ok) return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  const hint = status === 402
    ? " Add USDC to the balance at rico.delivery under Wallet, then try again."
    : "";
  return { isError: true, content: [{ type: "text", text: `${data?.error || `Request failed (HTTP ${status})`}${hint}` }] };
}

// ── MCP Server ──

/**
 * Build a RICO MCP server.
 * @param {object} [opts]
 * @param {string} [opts.apiKey] RICO API key the tools act with. Reads work without one.
 * @param {number} [opts.maxWaitSeconds=90] Upper bound for wait_for_bids.
 */
export function createRicoServer({ apiKey = process.env.RICO_API_KEY, maxWaitSeconds = 90 } = {}) {
  const server = new McpServer({ name: "rico", version: VERSION });
  const call = (method, path, body) => api(method, path, { body, apiKey, auth: true });

  // Titles and behaviour hints, so clients can tell reads from actions that
  // commit funds or cannot be undone.
  const META = {
    post_task: { title: "Post a RICO task", annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true } },
    place_bid: { title: "Bid on a RICO task", annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true } },
    accept_bid: { title: "Accept a bid", annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true } },
    confirm_delivery: { title: "Confirm delivery and pay the runner", annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true } },
    cancel_task: { title: "Cancel a RICO task", annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true } },
    health: { title: "Check RICO status", annotations: { readOnlyHint: true, openWorldHint: true } },
    wait_for_bids: { title: "Wait for bids", annotations: { readOnlyHint: true, openWorldHint: true } },
  };
  const tool = (name, description, inputSchema, handler) =>
    server.registerTool(name, { ...META[name], description, inputSchema }, handler);

  // Tool: Post a workflow-based task
  tool(
    "post_task",
    "Post a workflow-based task on RICO for a human runner. Every task is a sequence of steps. Each step has an action, optional location, proof type, and requirements. The escrow (fee x runners, plus item cost) is taken from the account's prepaid USDC balance; posting fails if the balance is too low. Always prefer using 'steps' to define the workflow.",
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
      return toolResult(await call("POST", "/task", body));
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
      const result = await api("GET", "/tasks");
      if (!result.ok) return toolResult(result);
      const tasks = (result.data.tasks || []).map(t => ({
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
      const result = await api("GET", `/task?id=${encodeURIComponent(taskId)}`);
      if (!result.ok) {
        return {
          isError: true,
          content: [{ type: "text", text: `Task "${taskId}" not found. Use list_tasks to get valid task IDs.` }],
        };
      }
      const detail = result.data;
      return {
        content: [{ type: "text", text: JSON.stringify(detail, null, 2) }],
        structuredContent: { view: "task", task: detail },
      };
    }
  );

  // Tool: Place a bid on a task
  tool(
    "place_bid",
    "Place a bid on an open task as a runner. You cannot bid on your own task.",
    {
      taskId: z.string().describe("Task ID to bid on"),
      fee: z.number().positive().describe("Your proposed fee in USDC"),
      comment: z.string().optional().describe("Why you're a good fit"),
      lat: z.number().optional().describe("Your current latitude"),
      lng: z.number().optional().describe("Your current longitude"),
      tripKm: z.number().optional().describe("Estimated trip distance in km"),
    },
    async (args) => toolResult(await call("POST", "/bid", args))
  );

  // Tool: Accept a bid (poster only)
  tool(
    "accept_bid",
    "Accept a runner's bid on your task. If the bid is above the suggested fee the difference is taken from your balance; if below, it is returned.",
    {
      taskId: z.string().describe("Task ID"),
      bidId: z.string().describe("Bid ID to accept (from get_task or wait_for_bids)"),
    },
    async (args) => toolResult(await call("POST", "/accept-bid", args))
  );

  // Tool: Confirm delivery and pay runner
  tool(
    "confirm_delivery",
    "Confirm a runner completed your task and release the escrowed USDC to them. This cannot be undone: check the proof first.",
    {
      taskId: z.string().describe("Task ID"),
      runnerId: z.string().optional().describe("Runner ID (required for multi-runner tasks)"),
      ratingScore: z.number().min(1).max(5).optional().describe("Rating 1-5"),
      ratingComment: z.string().optional().describe("Review comment"),
    },
    async (args) => toolResult(await call("POST", "/confirm-delivery", args))
  );

  // Tool: Cancel a task and get refund
  tool(
    "cancel_task",
    "Cancel one of your open tasks. The escrow returns to your RICO balance. Not possible once a runner has been accepted.",
    {
      taskId: z.string().describe("Task ID to cancel"),
    },
    async (args) => toolResult(await call("POST", "/cancel-task", args))
  );

  // Tool: Balance
  server.registerTool(
    "get_balance",
    {
      title: "Get RICO balance",
      description: "Show the account's prepaid USDC balance and recent balance activity. The balance is topped up on rico.delivery, not through this server.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => toolResult(await call("GET", "/me"))
  );

  // Tool: Check health
  tool(
    "health",
    "Check if the RICO server is running.",
    {},
    async () => {
      try {
        const res = await fetch(`${API_URL}/health`);
        const data = await res.json();
        return { content: [{ type: "text", text: JSON.stringify(data) }] };
      } catch (e) {
        return { content: [{ type: "text", text: `Error: ${e.message}` }] };
      }
    }
  );

  // Tool: Wait for bids on a task (SSE subscription)
  tool(
    "wait_for_bids",
    "Subscribe to a task and wait for runners to place bids. Returns when at least one new bid arrives or after timeout. Use this after posting a task to watch for incoming bids.",
    {
      taskId: z.string().describe("Task ID to watch for bids"),
      timeoutSeconds: z.number().optional().describe(`How long to wait (default 60, max ${maxWaitSeconds})`),
    },
    async ({ taskId, timeoutSeconds }) => {
      const timeout = Math.min(timeoutSeconds || 60, maxWaitSeconds) * 1000;
      const url = `${API_URL}/subscribe/bids?taskId=${encodeURIComponent(taskId)}`;

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
