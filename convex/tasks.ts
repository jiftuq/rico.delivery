import { internalMutation, mutation, query, MutationCtx } from "./_generated/server";
import { ConvexError, v } from "convex/values";
import { Doc, Id } from "./_generated/dataModel";
import { requireUser } from "./lib/auth";
import { MIN_WITHDRAWAL_MICRO, credit, debit, feeOn, fmt, fromMicro, toMicro } from "./lib/money";
import { enqueueWithdrawal } from "./wallet";

// Every function here that acts for a user takes a session token or API key
// and works out who is calling from it. Money only moves inside these
// mutations, between prepaid balances and a task's escrow, so each step is
// atomic: a task cannot exist without its escrow, and escrow cannot be paid
// out or refunded twice.

const FEE_RATE = 0.07;
const TWO_HOURS = 2 * 60 * 60 * 1000;
const FOUR_HOURS = 4 * 60 * 60 * 1000;

// Helper: get task type (defaults to "delivery" for legacy tasks)
function getTaskType(task: any): string {
  return task.taskType || "delivery";
}

// Helper: is this a delivery task?
function isDelivery(task: any): boolean {
  return getTaskType(task) === "delivery";
}

// Helper: is this a multi-runner task?
function isMultiRunner(task: any): boolean {
  return (task.maxRunners || 1) > 1;
}

function clip(text: string, max: number, what: string): string {
  if (text.length > max) throw new ConvexError(`${what} is too long (max ${max} characters)`);
  return text;
}

/** Tasks posted before prepaid balances hold no verified funds. */
function requireFunded(task: Doc<"tasks">) {
  if (task.escrowMicro === undefined) {
    throw new ConvexError("This task was posted before prepaid balances and holds no funds. Cancel it and post it again.");
  }
  return task.escrowMicro;
}

async function setEscrow(ctx: MutationCtx, taskId: Id<"tasks">, escrowMicro: number, extra: Record<string, unknown> = {}) {
  if (escrowMicro < 0) throw new ConvexError("Internal error: escrow would go negative");
  await ctx.db.patch(taskId, { escrowMicro, totalEscrowed: fromMicro(escrowMicro), ...extra });
}

/**
 * Release `grossMicro` of a task's escrow to a runner, less the platform fee.
 * The runner's share lands in their balance and, when large enough to be
 * worth a transaction, is sent on to their wallet.
 */
async function payRunner(ctx: MutationCtx, task: Doc<"tasks">, runnerId: Id<"users">, grossMicro: number) {
  const escrow = task.escrowMicro ?? 0;
  const gross = Math.min(grossMicro, escrow); // never pay out more than is held
  const fee = feeOn(gross);
  const payout = gross - fee;
  await setEscrow(ctx, task._id, escrow - gross, { feeMicro: (task.feeMicro ?? 0) + fee });
  if (payout > 0) {
    await credit(ctx, runnerId, payout, "payout", { taskId: task._id });
    if (payout >= MIN_WITHDRAWAL_MICRO) await enqueueWithdrawal(ctx, runnerId, payout, "payout");
  }
  return { payoutMicro: payout, feeMicro: fee, escrowLeft: escrow - gross };
}

/** Return whatever a task still holds to its poster's balance. */
async function refundEscrow(ctx: MutationCtx, task: Doc<"tasks">, escrowMicro = task.escrowMicro ?? 0) {
  if (escrowMicro > 0) await credit(ctx, task.posterId, escrowMicro, "refund", { taskId: task._id });
  await setEscrow(ctx, task._id, (task.escrowMicro ?? 0) - escrowMicro);
  return escrowMicro;
}

async function rate(ctx: MutationCtx, taskId: Id<"tasks">, raterId: Id<"users">, runner: Doc<"users">, score?: number, comment?: string) {
  if (!score || score < 1 || score > 5) return;
  await ctx.db.insert("ratings", { taskId, raterId, ratedId: runner._id, score, comment: clip(comment || "", 1000, "Comment"), createdAt: Date.now() });
  const newTotal = runner.totalRatings + 1;
  const newSum = runner.ratingSum + score;
  await ctx.db.patch(runner._id, { totalRatings: newTotal, ratingSum: newSum, score: Math.round((newSum / newTotal) * 10) / 10 });
}

export const create = mutation({
  args: {
    token: v.string(),
    title: v.string(), category: v.string(), details: v.string(),
    // Task type (defaults to "delivery")
    taskType: v.optional(v.string()),
    // Generic location (for non-delivery tasks)
    locationAddr: v.optional(v.string()),
    locationLat: v.optional(v.float64()),
    locationLng: v.optional(v.float64()),
    // Action + proof
    action: v.optional(v.string()),
    proofType: v.optional(v.string()),
    targetPerson: v.optional(v.string()),
    // Workflow steps
    steps: v.optional(v.array(v.object({
      order: v.number(),
      action: v.string(),
      locationAddr: v.optional(v.string()),
      locationLat: v.optional(v.float64()),
      locationLng: v.optional(v.float64()),
      proofType: v.optional(v.string()),
      proofData: v.optional(v.string()),
      requirements: v.optional(v.string()),
      status: v.optional(v.string()),
    }))),
    // Moving-specific
    movingDetails: v.optional(v.object({
      apartmentSize: v.string(),
      floorFrom: v.optional(v.number()),
      floorTo: v.optional(v.number()),
      elevatorFrom: v.optional(v.boolean()),
      elevatorTo: v.optional(v.boolean()),
      vehicleType: v.string(),
      inventoryList: v.optional(v.string()),
      moveDate: v.optional(v.string()),
    })),
    // Delivery-specific (optional)
    pickupAddr: v.optional(v.string()), pickupLat: v.optional(v.float64()), pickupLng: v.optional(v.float64()),
    dropoffAddr: v.optional(v.string()), dropoffLat: v.optional(v.float64()), dropoffLng: v.optional(v.float64()),
    privacyZone: v.optional(v.number()),
    itemCost: v.optional(v.float64()), suggestedFee: v.float64(),
    items: v.optional(v.array(v.object({ name: v.string(), cost: v.float64() }))),
    maxRunners: v.optional(v.number()),
  },
  handler: async (ctx, { token, ...args }) => {
    const poster = await requireUser(ctx, token);
    clip(args.title, 200, "Title"); clip(args.details, 5000, "Details");
    if (args.steps && args.steps.length > 30) throw new ConvexError("A task can have at most 30 steps");
    const taskType = args.taskType || "delivery";
    const itemCost = args.itemCost || 0;
    const maxRunners = Math.max(1, Math.min(Math.floor(args.maxRunners || 1), 100));
    const feeMicro = toMicro(args.suggestedFee, "Fee");
    const itemMicro = toMicro(itemCost, "Item cost");
    // Multi-runner: escrow = fee * maxRunners. Single: item cost + fee.
    const totalMicro = maxRunners > 1 ? feeMicro * maxRunners : itemMicro + feeMicro;
    if (totalMicro <= 0) throw new ConvexError("A task needs a fee above zero");

    const doc: any = {
      title: args.title, category: args.category, details: args.details,
      taskType,
      privacyZone: args.privacyZone ?? 100,
      itemCost, suggestedFee: args.suggestedFee, items: args.items,
      totalEscrowed: fromMicro(totalMicro), escrowMicro: totalMicro,
      posterId: poster._id, posterName: poster.displayName,
      maxRunners, acceptedCount: 0, completedCount: 0,
      status: "open", createdAt: Date.now(),
    };

    if (taskType === "delivery") {
      // Delivery requires pickup + dropoff
      if (!args.pickupAddr || !args.dropoffAddr) throw new ConvexError("Delivery needs pickup and dropoff");
      doc.pickupAddr = args.pickupAddr; doc.pickupLat = args.pickupLat; doc.pickupLng = args.pickupLng;
      doc.dropoffAddr = args.dropoffAddr; doc.dropoffLat = args.dropoffLat; doc.dropoffLng = args.dropoffLng;
      // Also set location to pickup for generic queries
      doc.locationAddr = args.pickupAddr; doc.locationLat = args.pickupLat; doc.locationLng = args.pickupLng;
      // Moving details
      if (args.movingDetails) doc.movingDetails = args.movingDetails;
      // Workflow steps
      if (args.steps) doc.steps = args.steps;
    } else {
      // Generic tasks need a location (unless steps provide locations)
      if (!args.locationAddr && (!args.steps || args.steps.length === 0)) throw new ConvexError("Task needs a location");
      if (args.locationAddr) {
        doc.locationAddr = args.locationAddr; doc.locationLat = args.locationLat; doc.locationLng = args.locationLng;
      }
      doc.action = args.action || args.details;
      doc.proofType = args.proofType || "photo";
      doc.targetPerson = args.targetPerson;
      if (args.steps) doc.steps = args.steps;
    }

    // Take the escrow and create the task together: if the balance cannot
    // cover it, debit throws and no task is created.
    const taskId = await ctx.db.insert("tasks", doc);
    await debit(ctx, poster._id, totalMicro, "escrow", { taskId });
    await ctx.db.patch(poster._id, { tasksPosted: poster.tasksPosted + 1 });
    return taskId;
  },
});

export const placeBid = mutation({
  args: {
    token: v.string(), taskId: v.id("tasks"),
    fee: v.float64(), comment: v.string(), lat: v.float64(), lng: v.float64(),
    tripKm: v.float64(),
  },
  handler: async (ctx, { token, ...args }) => {
    const runner = await requireUser(ctx, token);
    const task = await ctx.db.get(args.taskId);
    if (!task || task.status !== "open") throw new ConvexError("Not open");
    if (task.posterId === runner._id) throw new ConvexError("Own task");
    if (toMicro(args.fee, "Bid") <= 0) throw new ConvexError("Bid must be above zero");
    clip(args.comment, 1000, "Comment");
    const existing = await ctx.db.query("bids").withIndex("by_task", q => q.eq("taskId", args.taskId)).collect();
    if (existing.some(b => b.courierId === runner._id)) throw new ConvexError("Already bid");
    if (existing.length >= 20) throw new ConvexError("Max bids");
    await ctx.db.patch(runner._id, { lastLat: args.lat, lastLng: args.lng });
    return await ctx.db.insert("bids", {
      taskId: args.taskId, courierId: runner._id, courierName: runner.displayName,
      fee: args.fee, comment: args.comment, lat: args.lat, lng: args.lng,
      tripKm: args.tripKm, courierScore: runner.score, courierDeliveries: runner.deliveries,
      accepted: false, createdAt: Date.now(),
    });
  },
});

export const acceptBid = mutation({
  args: { token: v.string(), taskId: v.id("tasks"), bidId: v.id("bids") },
  handler: async (ctx, { token, taskId, bidId }) => {
    const poster = await requireUser(ctx, token);
    const posterId = poster._id;
    const task = await ctx.db.get(taskId);
    if (!task || task.posterId !== posterId) throw new ConvexError("Cannot accept");
    const maxR = task.maxRunners || 1;
    const accepted = task.acceptedCount || 0;
    const multi = maxR > 1;
    // For single-runner: must be "open". For multi: "open" or "in_progress" (still filling slots)
    if (!multi && task.status !== "open") throw new ConvexError("Cannot accept");
    if (multi && task.status !== "open" && task.status !== "in_progress") throw new ConvexError("Cannot accept");
    if (multi && accepted >= maxR) throw new ConvexError("All runner slots filled");
    const bid = await ctx.db.get(bidId);
    if (!bid || bid.taskId !== taskId) throw new ConvexError("Invalid bid");
    if (bid.accepted) throw new ConvexError("Bid already accepted");
    const escrow = requireFunded(task);
    const bidMicro = toMicro(bid.fee, "Bid");
    await ctx.db.patch(bidId, { accepted: true });

    // The escrow was sized for the suggested fee. Settle the difference with
    // the poster's balance now, so the escrow always covers what was agreed.
    const newEscrow = multi
      ? escrow + bidMicro - toMicro(task.suggestedFee)
      : toMicro(task.itemCost || 0) + bidMicro;
    const delta = newEscrow - escrow;
    if (delta > 0) await debit(ctx, posterId, delta, "escrow", { taskId });
    else if (delta < 0) await credit(ctx, posterId, -delta, "refund", { taskId });

    if (multi) {
      // Multi-runner: create taskRunner entry, increment count
      await ctx.db.insert("taskRunners", {
        taskId, runnerId: bid.courierId, runnerName: bid.courierName,
        bidId, fee: bid.fee, status: "accepted",
        lat: bid.lat, lng: bid.lng, acceptedAt: Date.now(),
      });
      const newAccepted = accepted + 1;
      const allFilled = newAccepted >= maxR;
      await setEscrow(ctx, taskId, newEscrow, {
        status: allFilled ? "in_progress" : "open",
        acceptedCount: newAccepted,
        acceptedAt: allFilled ? Date.now() : task.acceptedAt,
      });
      await ctx.db.insert("messages", {
        taskId, senderId: posterId, senderName: "System", role: "system",
        text: `${bid.courierName} accepted as runner! (${newAccepted}/${maxR} slots filled)`, createdAt: Date.now(),
      });
    } else {
      await setEscrow(ctx, taskId, newEscrow, {
        status: "in_progress", courierId: bid.courierId, courierName: bid.courierName,
        acceptedFee: bid.fee, acceptedAt: Date.now(),
        acceptedCount: 1,
        courierLat: bid.lat, courierLng: bid.lng,
      });
      const runnerLabel = isDelivery(task) ? "courier" : "runner";
      await ctx.db.insert("messages", {
        taskId, senderId: posterId, senderName: "System", role: "system",
        text: `${bid.courierName} accepted as ${runnerLabel}! Chat open.`, createdAt: Date.now(),
      });
    }
    return { escrow: fromMicro(newEscrow), charged: fromMicro(delta) };
  },
});

export const updateCourierLoc = mutation({
  args: { token: v.string(), taskId: v.id("tasks"), lat: v.float64(), lng: v.float64() },
  handler: async (ctx, { token, taskId, lat, lng }) => {
    const user = await requireUser(ctx, token);
    const courierId = user._id;
    const task = await ctx.db.get(taskId);
    if (!task || (task.status !== "in_progress" && task.status !== "open")) return;
    const multi = isMultiRunner(task);
    if (multi) {
      // Update taskRunner entry location
      const trs = await ctx.db.query("taskRunners").withIndex("by_task_runner", q => q.eq("taskId", taskId).eq("runnerId", courierId)).collect();
      if (!trs[0]) return;
      await ctx.db.patch(trs[0]._id, { lat, lng });
    } else {
      if (task.courierId !== courierId) return;
      await ctx.db.patch(taskId, { courierLat: lat, courierLng: lng });
    }
    await ctx.db.patch(courierId, { lastLat: lat, lastLng: lng });
  },
});

export const markDelivered = mutation({
  args: { token: v.string(), taskId: v.id("tasks"), proofData: v.optional(v.string()) },
  handler: async (ctx, { token, taskId, proofData }) => {
    const user = await requireUser(ctx, token);
    const courierId = user._id;
    if (proofData) clip(proofData, 5000, "Proof");
    const task = await ctx.db.get(taskId);
    if (!task) throw new ConvexError("Cannot mark");
    const multi = isMultiRunner(task);

    if (multi) {
      // A multi-runner task stays "open" until every slot is filled, and
      // runners accepted early can already deliver.
      if (task.status !== "in_progress" && task.status !== "open") throw new ConvexError("Cannot mark");
      const runners = await ctx.db.query("taskRunners").withIndex("by_task_runner", q => q.eq("taskId", taskId).eq("runnerId", courierId)).collect();
      const runner = runners[0];
      if (!runner || runner.status !== "accepted") throw new ConvexError("Not assigned to this task");
      const patch: any = { status: "delivered", deliveredAt: Date.now() };
      if (proofData) patch.proofData = proofData;
      await ctx.db.patch(runner._id, patch);
      await ctx.db.insert("messages", {
        taskId, senderId: courierId, senderName: "System", role: "system",
        text: `${user.displayName || "Runner"} submitted proof. Waiting for confirmation.`, createdAt: Date.now(),
      });
      // Check if ALL runners delivered → move task to "delivered"
      const allRunners = await ctx.db.query("taskRunners").withIndex("by_task", q => q.eq("taskId", taskId)).collect();
      const allFilled = (task.acceptedCount || 0) >= (task.maxRunners || 1);
      if (allFilled && allRunners.every(r => r.status === "delivered" || r.status === "completed" || r.status === "expired")) {
        await ctx.db.patch(taskId, { status: "delivered", deliveredAt: Date.now() });
      }
    } else {
      if (task.status !== "in_progress" || task.courierId !== courierId) throw new ConvexError("Cannot mark");
      const patch: any = { status: "delivered", deliveredAt: Date.now() };
      if (proofData) patch.proofData = proofData;
      await ctx.db.patch(taskId, patch);
      const label = isDelivery(task) ? "Marked as delivered" : "Proof submitted";
      await ctx.db.insert("messages", {
        taskId, senderId: courierId, senderName: "System", role: "system",
        text: `${label}. Waiting for confirmation. Auto-releases in 2 hours.`, createdAt: Date.now(),
      });
    }
  },
});

/** Pay one runner of a multi-runner task and close the task once all are done. */
async function completeRunner(ctx: MutationCtx, task: Doc<"tasks">, tr: Doc<"taskRunners">, now: number) {
  const runnerUser = await ctx.db.get(tr.runnerId);
  if (!runnerUser) throw new ConvexError("Runner gone");
  const paid = await payRunner(ctx, task, tr.runnerId, toMicro(tr.fee));
  await ctx.db.patch(tr._id, { status: "completed", completedAt: now });
  await ctx.db.patch(tr.runnerId, { deliveries: runnerUser.deliveries + 1 });
  const newCompleted = (task.completedCount || 0) + 1;
  await ctx.db.patch(task._id, { completedCount: newCompleted });
  await closeMultiIfDone(ctx, task._id, now);
  return { runnerUser, newCompleted, ...paid };
}

/** A multi-runner task is finished when every slot is filled and settled. */
async function closeMultiIfDone(ctx: MutationCtx, taskId: Id<"tasks">, now: number) {
  const task = await ctx.db.get(taskId);
  if (!task) return;
  const all = await ctx.db.query("taskRunners").withIndex("by_task", q => q.eq("taskId", taskId)).collect();
  const allFilled = (task.acceptedCount || 0) >= (task.maxRunners || 1);
  if (!allFilled || !all.every(r => r.status === "completed" || r.status === "expired")) return;
  await refundEscrow(ctx, task); // anything left over goes back to the poster
  const anyDone = all.some(r => r.status === "completed");
  await ctx.db.patch(taskId, { status: anyDone ? "completed" : "refunded", completedAt: now });
}

export const confirmDelivery = mutation({
  args: {
    token: v.string(), taskId: v.id("tasks"),
    runnerId: v.optional(v.id("users")), // required for multi-runner
    ratingScore: v.optional(v.number()), ratingComment: v.optional(v.string()),
  },
  handler: async (ctx, { token, taskId, runnerId, ratingScore, ratingComment }) => {
    const poster = await requireUser(ctx, token);
    const posterId = poster._id;
    const task = await ctx.db.get(taskId);
    if (!task) throw new ConvexError("Task not found");
    if (task.posterId !== posterId) throw new ConvexError("Unauthorized");
    const multi = isMultiRunner(task);
    const now = Date.now();

    if (multi) {
      // Multi-runner: confirm individual runner
      if (!runnerId) throw new ConvexError("runnerId required for multi-runner task");
      const trs = await ctx.db.query("taskRunners").withIndex("by_task_runner", q => q.eq("taskId", taskId).eq("runnerId", runnerId)).collect();
      const tr = trs[0];
      if (!tr || tr.status !== "delivered") throw new ConvexError("Runner not delivered");
      const done = await completeRunner(ctx, task, tr, now);
      await rate(ctx, taskId, posterId, done.runnerUser, ratingScore, ratingComment);
      await ctx.db.insert("messages", {
        taskId, senderId: posterId, senderName: "System", role: "system",
        text: `${done.runnerUser.displayName} confirmed! $${fmt(done.payoutMicro)} paid. (${done.newCompleted}/${task.maxRunners} done)`, createdAt: now,
      });
      return { payout: fromMicro(done.payoutMicro), burn: fromMicro(done.feeMicro), runnerId };
    } else {
      if (task.status !== "delivered" && task.status !== "in_progress") throw new ConvexError("Cannot confirm");
      if (!task.courierId) throw new ConvexError("No runner assigned");
      const runner = await ctx.db.get(task.courierId);
      if (!runner) throw new ConvexError("Runner gone");
      const paid = await payRunner(ctx, task, task.courierId, task.escrowMicro ?? 0);
      await ctx.db.patch(task.courierId, { deliveries: runner.deliveries + 1 });
      await ctx.db.patch(taskId, { status: "completed", completedAt: now, completedCount: 1 });
      await rate(ctx, taskId, posterId, runner, ratingScore, ratingComment);
      await ctx.db.insert("messages", {
        taskId, senderId: posterId, senderName: "System", role: "system",
        text: `Confirmed! $${fmt(paid.payoutMicro)} USDC released. $${fmt(paid.feeMicro)} platform fee.`, createdAt: now,
      });
      return { payout: fromMicro(paid.payoutMicro), burn: fromMicro(paid.feeMicro) };
    }
  },
});

export const cancel = mutation({
  args: { token: v.string(), taskId: v.id("tasks") },
  handler: async (ctx, { token, taskId }) => {
    const poster = await requireUser(ctx, token);
    const task = await ctx.db.get(taskId);
    if (!task || task.status !== "open" || task.posterId !== poster._id) throw new ConvexError("Cannot cancel");
    if ((task.acceptedCount || 0) > 0) throw new ConvexError("Cannot cancel: a runner has already been accepted");
    const refunded = await refundEscrow(ctx, task);
    await ctx.db.patch(taskId, { status: "cancelled" });
    return { refund: fromMicro(refunded) };
  },
});

// ── Dispute ──
export const openDispute = mutation({
  args: { token: v.string(), taskId: v.id("tasks"), reason: v.string() },
  handler: async (ctx, { token, taskId, reason }) => {
    const user = await requireUser(ctx, token);
    const userId = user._id;
    clip(reason, 2000, "Reason");
    const task = await ctx.db.get(taskId);
    if (!task) throw new ConvexError("Task not found");
    if (task.status !== "in_progress" && task.status !== "delivered") throw new ConvexError("Cannot dispute");
    if (task.posterId !== userId && task.courierId !== userId) throw new ConvexError("Unauthorized");
    const role = task.posterId === userId ? "poster" : "runner";
    await ctx.db.patch(taskId, { status: "disputed", disputeReason: reason, disputeBy: role, disputedAt: Date.now() });
    await ctx.db.insert("messages", {
      taskId, senderId: userId, senderName: "System", role: "system",
      text: `\u26a0\ufe0f Dispute opened by ${role} (${user.displayName}): "${reason}". Funds held until resolved.`, createdAt: Date.now(),
    });
  },
});

/** Admin (run from the Convex dashboard): settle a disputed task. */
export const resolveDispute = internalMutation({
  args: { taskId: v.id("tasks"), resolution: v.union(v.literal("courier"), v.literal("poster")) },
  handler: async (ctx, { taskId, resolution }) => {
    const task = await ctx.db.get(taskId);
    if (!task || task.status !== "disputed") throw new ConvexError("Not disputed");
    if (resolution === "courier") {
      if (!task.courierId) throw new ConvexError("No runner assigned");
      const runner = await ctx.db.get(task.courierId);
      if (runner) await ctx.db.patch(task.courierId, { deliveries: runner.deliveries + 1 });
      const paid = await payRunner(ctx, task, task.courierId, task.escrowMicro ?? 0);
      await ctx.db.patch(taskId, { status: "completed", completedAt: Date.now() });
      return { payTo: "runner", amount: fromMicro(paid.payoutMicro) };
    }
    const refunded = await refundEscrow(ctx, task);
    await ctx.db.patch(taskId, { status: "refunded" });
    return { payTo: "poster", amount: fromMicro(refunded) };
  },
});

// ── Cron: pay runners whose delivery went unconfirmed for 2 hours ──
export const autoRelease = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const delivered = await ctx.db.query("tasks").withIndex("by_status", q => q.eq("status", "delivered")).take(100);
    for (const task of delivered) {
      if (isMultiRunner(task) || !task.courierId || !task.deliveredAt || now - task.deliveredAt <= TWO_HOURS) continue;
      const runner = await ctx.db.get(task.courierId);
      if (!runner) continue;
      const paid = await payRunner(ctx, task, task.courierId, task.escrowMicro ?? 0);
      await ctx.db.patch(task.courierId, { deliveries: runner.deliveries + 1 });
      await ctx.db.patch(task._id, { status: "completed", completedAt: now });
      await ctx.db.insert("messages", {
        taskId: task._id, senderId: task.courierId, senderName: "System", role: "system",
        text: `Auto-released! $${fmt(paid.payoutMicro)} USDC paid to runner (requester did not confirm within 2 hours).`, createdAt: now,
      });
    }
    const runners = await ctx.db.query("taskRunners").withIndex("by_status", q => q.eq("status", "delivered")).take(100);
    for (const tr of runners) {
      if (!tr.deliveredAt || now - tr.deliveredAt <= TWO_HOURS) continue;
      const task = await ctx.db.get(tr.taskId);
      if (!task || task.status === "disputed") continue;
      const done = await completeRunner(ctx, task, tr, now);
      await ctx.db.insert("messages", {
        taskId: task._id, senderId: tr.runnerId, senderName: "System", role: "system",
        text: `Auto-released! $${fmt(done.payoutMicro)} USDC paid to ${done.runnerUser.displayName}.`, createdAt: now,
      });
    }
  },
});

// ── Cron: refund work that was accepted but not delivered within 4 hours ──
export const refundStuck = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const stuck = await ctx.db.query("tasks").withIndex("by_status", q => q.eq("status", "in_progress")).take(100);
    for (const task of stuck) {
      if (!task.acceptedAt || now - task.acceptedAt <= FOUR_HOURS) continue;
      if (!isMultiRunner(task)) {
        await refundEscrow(ctx, task);
        await ctx.db.patch(task._id, { status: "refunded" });
        continue;
      }
      // Multi-runner: only runners who never delivered lose their slot.
      const all = await ctx.db.query("taskRunners").withIndex("by_task", q => q.eq("taskId", task._id)).collect();
      let refund = 0;
      for (const tr of all) {
        if (tr.status !== "accepted") continue;
        await ctx.db.patch(tr._id, { status: "expired" });
        refund += toMicro(tr.fee);
      }
      const fresh = await ctx.db.get(task._id);
      if (!fresh) continue;
      await refundEscrow(ctx, fresh, Math.min(refund, fresh.escrowMicro ?? 0));
      if (all.some(tr => tr.status === "delivered")) {
        await ctx.db.patch(task._id, { status: "delivered", deliveredAt: now });
      } else {
        await closeMultiIfDone(ctx, task._id, now);
      }
    }
  },
});

// ── Queries ──

export const listOpen = query({
  args: {},
  handler: async (ctx) => {
    const tasks = await ctx.db.query("tasks").withIndex("by_status", q => q.eq("status", "open")).order("desc").take(50);
    return await Promise.all(tasks.map(async t => {
      const bids = await ctx.db.query("bids").withIndex("by_task", q => q.eq("taskId", t._id)).collect();
      return { ...t, bidCount: bids.length };
    }));
  },
});

export const getActive = query({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }) => {
    const posted = await ctx.db.query("tasks").withIndex("by_poster", q => q.eq("posterId", userId)).order("desc").take(20);
    const running = await ctx.db.query("tasks").withIndex("by_courier", q => q.eq("courierId", userId)).order("desc").take(20);
    // Also find multi-runner tasks where user is a taskRunner
    const trEntries = await ctx.db.query("taskRunners").withIndex("by_runner", q => q.eq("runnerId", userId)).collect();
    const trTaskIds = trEntries.filter(tr => tr.status !== "completed").map(tr => tr.taskId);
    const trTasks = await Promise.all(trTaskIds.map(id => ctx.db.get(id)));
    const all = [...posted, ...running, ...trTasks.filter(Boolean) as any[]];
    const unique = all.filter((t, i, a) => a.findIndex(x => x._id === t._id) === i);
    const active = unique.filter(t => !["completed", "cancelled", "refunded"].includes(t.status));
    return active.sort((a, b) => b.createdAt - a.createdAt);
  },
});

export const getTask = query({
  args: { taskId: v.id("tasks") },
  handler: async (ctx, { taskId }) => ctx.db.get(taskId),
});

export const getBid = query({
  args: { bidId: v.id("bids") },
  handler: async (ctx, { bidId }) => ctx.db.get(bidId),
});

export const getBids = query({
  args: { taskId: v.id("tasks") },
  handler: async (ctx, { taskId }) =>
    ctx.db.query("bids").withIndex("by_task", q => q.eq("taskId", taskId)).order("desc").collect(),
});

export const getTaskRunners = query({
  args: { taskId: v.id("tasks") },
  handler: async (ctx, { taskId }) =>
    ctx.db.query("taskRunners").withIndex("by_task", q => q.eq("taskId", taskId)).collect(),
});

// ── History queries ──

export const getCourierHistory = query({
  args: { courierId: v.id("users") },
  handler: async (ctx, { courierId }) => {
    const tasks = await ctx.db.query("tasks").withIndex("by_courier", q => q.eq("courierId", courierId)).order("desc").take(50);
    const done = tasks.filter(t => t.status === "completed" || t.status === "cancelled" || t.status === "refunded");
    return await Promise.all(done.map(async t => {
      const bid = await ctx.db.query("bids").withIndex("by_task", q => q.eq("taskId", t._id)).collect();
      const accepted = bid.find(b => b.courierId === courierId && b.accepted);
      return {
        _id: t._id, status: t.status, category: t.category, title: t.title,
        taskType: t.taskType || "delivery",
        acceptedFee: t.acceptedFee ?? 0, totalEscrowed: t.totalEscrowed,
        tripKm: accepted?.tripKm ?? 0, completedAt: t.completedAt, createdAt: t.createdAt,
        pickupAddr: t.pickupAddr, dropoffAddr: t.dropoffAddr,
        locationAddr: t.locationAddr, action: t.action,
        itemCost: t.itemCost, items: t.items, details: t.details,
      };
    }));
  },
});

export const getPosterHistory = query({
  args: { posterId: v.id("users") },
  handler: async (ctx, { posterId }) => {
    const tasks = await ctx.db.query("tasks").withIndex("by_poster", q => q.eq("posterId", posterId)).order("desc").take(50);
    const done = tasks.filter(t => t.status === "completed" || t.status === "cancelled" || t.status === "refunded");
    return done.map(t => ({
      _id: t._id, status: t.status, category: t.category, title: t.title,
      taskType: t.taskType || "delivery",
      totalEscrowed: t.totalEscrowed, acceptedFee: t.acceptedFee,
      courierName: t.courierName, completedAt: t.completedAt, createdAt: t.createdAt,
      pickupAddr: t.pickupAddr, dropoffAddr: t.dropoffAddr,
      locationAddr: t.locationAddr, action: t.action,
      itemCost: t.itemCost, suggestedFee: t.suggestedFee, items: t.items, details: t.details,
    }));
  },
});

export const getStats = query({
  args: {},
  handler: async (ctx) => {
    const all = await ctx.db.query("tasks").collect();
    const completed = all.filter(t => t.status === "completed");
    const burned = completed.reduce((s, t) => s + t.totalEscrowed * FEE_RATE, 0);
    return { total: all.length, open: all.filter(t => t.status === "open").length, completed: completed.length, burned: Math.round(burned * 100) / 100 };
  },
});
