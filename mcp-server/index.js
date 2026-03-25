#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createWalletClient, http, parseUnits, encodeFunctionData } from "viem";
import { base } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";

// ── Config ──
const CONVEX_SITE_URL = process.env.RICO_URL || "https://cool-rooster-544.convex.site";
const PRIVATE_KEY = process.env.RICO_PRIVATE_KEY; // Agent's wallet private key (0x...)
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

const server = new McpServer({
  name: "rico",
  version: "1.0.0",
});

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

// Tool: List open tasks
server.tool(
  "list_tasks",
  "List currently open tasks on RICO that runners can bid on.",
  {},
  async () => {
    const result = await convexQuery("tasks:listOpen", {});
    const tasks = result.value || [];
    const summary = tasks.map(t => ({
      id: t._id,
      title: t.title,
      type: t.taskType || "delivery",
      category: t.category,
      fee: t.suggestedFee,
      maxRunners: t.maxRunners || 1,
      accepted: t.acceptedCount || 0,
      location: t.locationAddr || t.pickupAddr,
      steps: t.steps ? t.steps.map(s => ({ action: s.action, proof: s.proofType, status: s.status })) : undefined,
      action: t.action,
      proofType: t.proofType,
    }));
    return {
      content: [{ type: "text", text: JSON.stringify(summary, null, 2) }],
    };
  }
);

// Tool: Get task details
server.tool(
  "get_task",
  "Get full details of a specific task including bids.",
  {
    taskId: z.string().describe("Convex task ID"),
  },
  async ({ taskId }) => {
    const task = await convexQuery("tasks:getTask", { taskId });
    return {
      content: [{ type: "text", text: JSON.stringify(task.value, null, 2) }],
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

// ── Start ──
const transport = new StdioServerTransport();
await server.connect(transport);
