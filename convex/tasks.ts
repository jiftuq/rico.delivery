import { internalMutation, mutation, query, MutationCtx, QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { ConvexError, v } from "convex/values";
import { Doc, Id } from "./_generated/dataModel";
import { requireUser, userForToken } from "./lib/auth";
import { MIN_FEE_MICRO, MIN_WITHDRAWAL_MICRO, credit, debit, feeOn, fmt, fromMicro, toMicro } from "./lib/money";
import { bidView, clampZone, runnerView, taskView, viewerOf } from "./lib/privacy";
import { describeNeed, proofNeeded, requireProof } from "./lib/proof";
import { rateLimit } from "./lib/rateLimit";
import { bump, readStat } from "./lib/stats";
import { enqueueWithdrawal } from "./wallet";

// Every function here that acts for a user takes a session token or API key
// and works out who is calling from it. Money only moves inside these
// mutations, between prepaid balances and a task's escrow, so each step is
// atomic: a task cannot exist without its escrow, and escrow cannot be paid
// out or refunded twice.
//
// Reads go through lib/privacy.ts: the poster and accepted runners see a task
// exactly, everyone else sees the area only and no positions.
//
// A task's life:
//   open          taking bids. Multi-runner tasks stay open while slots fill;
//                 runners accepted early can already work and deliver.
//   in_progress   a runner (or every slot) is taken; work not yet delivered.
//                 Refunded if nothing is delivered within 4 hours.
//   delivered     proof is in (lib/proof.ts). The poster confirms, or opens a
//                 dispute; otherwise the runner is paid after 24 hours.
//   completed, refunded, cancelled, or disputed (held for an admin)
// Multi-runner tasks track each runner separately (taskRunners) and stop
// taking runners when the poster closes the open slots, or 72 hours after
// the first runner was accepted. Either way the money for empty slots goes
// back to the poster.

const HOUR = 60 * 60 * 1000;
/** An unconfirmed, undisputed delivery pays the runner after this long. */
const RELEASE_AFTER_MS = 24 * HOUR;
/** Accepted work that isn't delivered within this long is refunded. */
const DELIVER_WITHIN_MS = 4 * HOUR;
/** A multi-runner task stops taking runners this long after its first one. */
const FILL_SLOTS_WITHIN_MS = 72 * HOUR;
/** Tasks one account can have open at once. */
const MAX_OPEN_TASKS = 20;

// Size limits for everything a task can carry. They keep any one task small,
// so the public list can never grow past what a query may read.
const LIMITS = {
  title: 200, details: 5000, action: 5000, label: 60, proofType: 20,
  address: 300, targetPerson: 200,
  steps: 30, stepAction: 500, requirements: 200,
  items: 50, itemName: 200,
  inventory: 5000, comment: 1000, reason: 2000, proof: 5000,
};

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

/** Same as clip, for optional fields. */
function clipOpt(text: string | undefined, max: number, what: string) {
  return text === undefined ? undefined : clip(text, max, what);
}

function checkPosition(lat: number | undefined, lng: number | undefined, what: string) {
  if (lat === undefined && lng === undefined) return;
  if (typeof lat !== "number" || typeof lng !== "number" || !Number.isFinite(lat) || !Number.isFinite(lng)
    || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    throw new ConvexError(`${what} position is not a valid latitude/longitude`);
  }
}

/** Tasks posted before prepaid balances hold no verified funds. */
function requireFunded(task: Doc<"tasks">) {
  if (task.escrowMicro === undefined) {
    throw new ConvexError("This task was posted before prepaid balances and holds no funds. Cancel it and post it again.");
  }
  return task.escrowMicro;
}

async function systemNote(ctx: MutationCtx, taskId: Id<"tasks">, senderId: Id<"users">, text: string) {
  await ctx.db.insert("messages", { taskId, senderId, senderName: "System", role: "system", text, createdAt: Date.now() });
}

// ── Bids ──

/** Open bids a task holds at once: enough to fill every slot twice. */
const bidSlots = (task: Doc<"tasks">) => Math.max(20, 2 * (task.maxRunners || 1));
/** Bids a task can collect in all, counting the ones turned down. */
const maxBidRows = (task: Doc<"tasks">) => bidSlots(task) + 100;
const isOpenBid = (b: Doc<"bids">) => !b.accepted && !b.rejected;

/** More completed jobs wins; a better rating breaks ties. */
function outranks(a: { deliveries: number; score: number }, b: { deliveries: number; score: number }) {
  return a.deliveries !== b.deliveries ? a.deliveries > b.deliveries : a.score > b.score;
}

// ── Multi-runner slots ──

const SETTLED = new Set(["completed", "expired", "refunded"]);
const isSettled = (tr: Doc<"taskRunners">) => SETTLED.has(tr.status);
/** Every slot is taken, or the poster (or the timeout) closed the rest. */
const slotsFull = (task: Doc<"tasks">) => (task.acceptedCount || 0) >= (task.maxRunners || 1) || !!task.slotsClosedAt;

async function runnersOf(ctx: QueryCtx, taskId: Id<"tasks">) {
  return ctx.db.query("taskRunners").withIndex("by_task", (q) => q.eq("taskId", taskId)).take(100);
}

async function runnerEntry(ctx: QueryCtx, taskId: Id<"tasks">, runnerId: Id<"users">) {
  return ctx.db.query("taskRunners").withIndex("by_task_runner", (q) => q.eq("taskId", taskId).eq("runnerId", runnerId)).first();
}

/**
 * Every change to a task goes through here, so the status counters behind
 * getStats stay right whatever path changed the status.
 */
async function patchTask(ctx: MutationCtx, taskId: Id<"tasks">, fields: Record<string, unknown>) {
  if (typeof fields.status === "string") {
    const before = await ctx.db.get(taskId);
    if (before && before.status !== fields.status) {
      await bump(ctx, `tasks.status.${before.status}`, -1);
      await bump(ctx, `tasks.status.${fields.status}`, 1);
    }
  }
  await ctx.db.patch(taskId, fields as any);
}

async function setEscrow(ctx: MutationCtx, taskId: Id<"tasks">, escrowMicro: number, extra: Record<string, unknown> = {}) {
  if (escrowMicro < 0) throw new ConvexError("Internal error: escrow would go negative");
  await patchTask(ctx, taskId, { escrowMicro, totalEscrowed: fromMicro(escrowMicro), ...extra });
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
  await bump(ctx, "fees.micro", fee);
  if (payout > 0) {
    await credit(ctx, runnerId, payout, "payout", { taskId: task._id });
    if (payout >= MIN_WITHDRAWAL_MICRO) await enqueueWithdrawal(ctx, runnerId, payout, "payout");
  }
  return { payoutMicro: payout, feeMicro: fee, escrowLeft: escrow - gross };
}

/** Return whatever a task still holds (or `escrowMicro` of it) to its poster's balance. */
async function refundEscrow(ctx: MutationCtx, task: Doc<"tasks">, escrowMicro = task.escrowMicro ?? 0) {
  if (escrowMicro > 0) await credit(ctx, task.posterId, escrowMicro, "refund", { taskId: task._id });
  await setEscrow(ctx, task._id, (task.escrowMicro ?? 0) - escrowMicro);
  return escrowMicro;
}

async function rate(ctx: MutationCtx, taskId: Id<"tasks">, raterId: Id<"users">, runner: Doc<"users">, score?: number, comment?: string) {
  if (!score || score < 1 || score > 5) return;
  await ctx.db.insert("ratings", { taskId, raterId, ratedId: runner._id, score, comment: clip(comment || "", LIMITS.comment, "Comment"), createdAt: Date.now() });
  const newTotal = runner.totalRatings + 1;
  const newSum = runner.ratingSum + score;
  await ctx.db.patch(runner._id, { totalRatings: newTotal, ratingSum: newSum, score: Math.round((newSum / newTotal) * 10) / 10 });
}

/**
 * Bring a multi-runner task's status in line with its runners, once it has
 * stopped taking new ones: in_progress while someone still has to deliver,
 * delivered while deliveries wait to be confirmed (or disputes settled),
 * then completed or refunded, with anything left over returned to the poster.
 */
async function syncMulti(ctx: MutationCtx, taskId: Id<"tasks">, now: number) {
  const task = await ctx.db.get(taskId);
  if (!task || !slotsFull(task) || !["open", "in_progress", "delivered"].includes(task.status)) return;
  const all = await runnersOf(ctx, taskId);
  if (all.every(isSettled)) {
    await refundEscrow(ctx, task);
    await patchTask(ctx, taskId, { status: all.some((r) => r.status === "completed") ? "completed" : "refunded", completedAt: now });
    return;
  }
  const status = all.some((r) => r.status === "accepted") ? "in_progress" : "delivered";
  if (task.status === status) return;
  await patchTask(ctx, taskId, status === "delivered" ? { status, deliveredAt: now } : { status, acceptedAt: task.acceptedAt ?? now });
}

/**
 * Stop a multi-runner task taking more runners: the money held for the empty
 * slots goes back to the poster, and the task carries on with the runners it has.
 */
async function closeOpenSlots(ctx: MutationCtx, task: Doc<"tasks">, now: number, byTimeout: boolean) {
  const runners = await runnersOf(ctx, task._id);
  // What the escrow still owes the runners on the task; the rest was held for empty slots.
  const owed = runners.filter((tr) => !isSettled(tr)).reduce((sum, tr) => sum + toMicro(tr.fee), 0);
  const refund = Math.max(0, (task.escrowMicro ?? 0) - owed);
  await refundEscrow(ctx, task, refund);
  await patchTask(ctx, task._id, { slotsClosedAt: now, status: "in_progress", acceptedAt: now });
  const filled = `${task.acceptedCount || 0}/${task.maxRunners || 1} slots filled`;
  await systemNote(ctx, task._id, task.posterId, byTimeout
    ? `No more runners joined within 72 hours, so the open slots were closed (${filled}). $${fmt(refund)} USDC went back to the poster's balance.`
    : `The poster stopped looking for more runners (${filled}). $${fmt(refund)} USDC went back to their balance.`);
  await syncMulti(ctx, task._id, now);
  return refund;
}

/** Pay one runner of a multi-runner task, and close the task once everyone is settled. */
async function completeRunner(ctx: MutationCtx, task: Doc<"tasks">, tr: Doc<"taskRunners">, now: number) {
  const runnerUser = await ctx.db.get(tr.runnerId);
  if (!runnerUser) throw new ConvexError("Runner gone");
  const paid = await payRunner(ctx, task, tr.runnerId, toMicro(tr.fee));
  await ctx.db.patch(tr._id, { status: "completed", completedAt: now, autoReleaseAt: undefined });
  await ctx.db.patch(tr.runnerId, { deliveries: runnerUser.deliveries + 1 });
  const newCompleted = (task.completedCount || 0) + 1;
  await patchTask(ctx, task._id, { completedCount: newCompleted });
  await syncMulti(ctx, task._id, now);
  return { runnerUser, newCompleted, ...paid };
}

/** Pay a single-runner task's runner everything it holds. */
async function completeSingle(ctx: MutationCtx, task: Doc<"tasks">, now: number) {
  if (!task.courierId) throw new ConvexError("No runner assigned");
  const runner = await ctx.db.get(task.courierId);
  if (!runner) throw new ConvexError("Runner gone");
  const paid = await payRunner(ctx, task, task.courierId, task.escrowMicro ?? 0);
  await ctx.db.patch(task.courierId, { deliveries: runner.deliveries + 1 });
  await patchTask(ctx, task._id, { status: "completed", completedAt: now, completedCount: 1, autoReleaseAt: undefined });
  return { runner, ...paid };
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

    // ── Size limits on everything the task carries ──
    clip(args.title, LIMITS.title, "Title"); clip(args.details, LIMITS.details, "Details");
    clip(args.category, LIMITS.label, "Category");
    clipOpt(args.taskType, LIMITS.label, "Task type"); clipOpt(args.proofType, LIMITS.proofType, "Proof type");
    clipOpt(args.action, LIMITS.action, "Action"); clipOpt(args.targetPerson, LIMITS.targetPerson, "Person");
    for (const [addr, what] of [[args.locationAddr, "Location"], [args.pickupAddr, "Pickup address"], [args.dropoffAddr, "Dropoff address"]] as const) {
      clipOpt(addr, LIMITS.address, what);
    }
    checkPosition(args.locationLat, args.locationLng, "Location");
    checkPosition(args.pickupLat, args.pickupLng, "Pickup");
    checkPosition(args.dropoffLat, args.dropoffLng, "Dropoff");
    if (args.steps && args.steps.length > LIMITS.steps) throw new ConvexError(`A task can have at most ${LIMITS.steps} steps`);
    // Steps start pending; a poster can't pre-fill progress or proof.
    const steps = args.steps?.map((s, i) => {
      clip(s.action, LIMITS.stepAction, `Step ${i + 1}`);
      clipOpt(s.locationAddr, LIMITS.address, `Step ${i + 1} address`);
      clipOpt(s.requirements, LIMITS.requirements, `Step ${i + 1} requirements`);
      clipOpt(s.proofType, LIMITS.proofType, `Step ${i + 1} proof type`);
      checkPosition(s.locationLat, s.locationLng, `Step ${i + 1}`);
      return {
        order: i + 1, action: s.action, locationAddr: s.locationAddr, locationLat: s.locationLat, locationLng: s.locationLng,
        proofType: s.proofType, requirements: s.requirements, status: "pending",
      };
    });
    if (args.items && args.items.length > LIMITS.items) throw new ConvexError(`A task can list at most ${LIMITS.items} items`);
    args.items?.forEach((item) => { clip(item.name, LIMITS.itemName, "Item name"); toMicro(item.cost, "Item cost"); });
    if (args.movingDetails) {
      const m = args.movingDetails;
      clip(m.apartmentSize, LIMITS.label, "Apartment size"); clip(m.vehicleType, LIMITS.label, "Vehicle type");
      clipOpt(m.inventoryList, LIMITS.inventory, "Inventory"); clipOpt(m.moveDate, LIMITS.label, "Move date");
    }

    // ── Money ──
    const taskType = args.taskType || "delivery";
    const itemCost = args.itemCost || 0;
    const maxRunners = Math.max(1, Math.min(Math.floor(args.maxRunners || 1), 100));
    const feeMicro = toMicro(args.suggestedFee, "Fee");
    const itemMicro = toMicro(itemCost, "Item cost");
    if (feeMicro < MIN_FEE_MICRO) throw new ConvexError(`The fee must be at least ${fmt(MIN_FEE_MICRO)} USDC per runner`);
    // Multi-runner: escrow = fee * maxRunners. Single: item cost + fee.
    const totalMicro = maxRunners > 1 ? feeMicro * maxRunners : itemMicro + feeMicro;

    // ── How much one account can post ──
    const openNow = await ctx.db.query("tasks")
      .withIndex("by_poster_status", (q) => q.eq("posterId", poster._id).eq("status", "open")).take(MAX_OPEN_TASKS);
    if (openNow.length >= MAX_OPEN_TASKS) {
      throw new ConvexError(`You already have ${MAX_OPEN_TASKS} open tasks. Wait until some are taken, or cancel some, before posting more.`);
    }
    await rateLimit(ctx, "post", poster._id);

    const doc: any = {
      title: args.title, category: args.category, details: args.details,
      taskType,
      privacyZone: clampZone(args.privacyZone),
      itemCost, suggestedFee: args.suggestedFee, items: args.items,
      totalEscrowed: fromMicro(totalMicro), escrowMicro: totalMicro,
      posterId: poster._id, posterName: poster.displayName,
      maxRunners, acceptedCount: 0, completedCount: 0, bidCount: 0,
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
      if (steps) doc.steps = steps;
    } else {
      // Generic tasks need a location (unless steps provide locations)
      if (!args.locationAddr && (!steps || steps.length === 0)) throw new ConvexError("Task needs a location");
      if (args.locationAddr) {
        doc.locationAddr = args.locationAddr; doc.locationLat = args.locationLat; doc.locationLng = args.locationLng;
      }
      doc.action = args.action || args.details;
      doc.proofType = args.proofType || "photo";
      doc.targetPerson = args.targetPerson;
      if (steps) doc.steps = steps;
    }

    // Take the escrow and create the task together: if the balance cannot
    // cover it, debit throws and no task is created.
    const taskId = await ctx.db.insert("tasks", doc);
    await debit(ctx, poster._id, totalMicro, "escrow", { taskId });
    await ctx.db.patch(poster._id, { tasksPosted: poster.tasksPosted + 1 });
    await bump(ctx, "tasks.total", 1);
    await bump(ctx, "tasks.status.open", 1);
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
    clip(args.comment, LIMITS.comment, "Comment");
    checkPosition(args.lat, args.lng, "Bid");
    const existing = await ctx.db.query("bids").withIndex("by_task", q => q.eq("taskId", args.taskId)).take(maxBidRows(task) + 1);
    const mine = existing.find(b => b.courierId === runner._id);
    if (mine) throw new ConvexError(mine.rejected ? "The poster turned down your bid on this task" : "Already bid");
    if (existing.length >= maxBidRows(task)) throw new ConvexError("This task has had too many bids");
    await rateLimit(ctx, "bid", runner._id);

    // A full bid list doesn't shut experienced runners out: a runner with
    // more completed jobs (or, on a tie, a better rating) takes the place of
    // the least experienced bid, which is removed. Brand-new accounts can't
    // push each other out, so a crowd of them can't hold a task's slots.
    const open = existing.filter(isOpenBid);
    let displaced: Doc<"bids"> | null = null;
    if (open.length >= bidSlots(task)) {
      const weakest = open.reduce((w, b) =>
        outranks({ deliveries: w.courierDeliveries, score: w.courierScore }, { deliveries: b.courierDeliveries, score: b.courierScore })
          || (w.courierDeliveries === b.courierDeliveries && w.courierScore === b.courierScore && b.createdAt > w.createdAt) ? b : w);
      if (!outranks({ deliveries: runner.deliveries, score: runner.score }, { deliveries: weakest.courierDeliveries, score: weakest.courierScore })) {
        throw new ConvexError("This task has the most bids it takes. Runners with more completed jobs can still bid.");
      }
      displaced = weakest;
      await ctx.db.delete(weakest._id);
    }

    await ctx.db.patch(runner._id, { lastLat: args.lat, lastLng: args.lng });
    const bidId = await ctx.db.insert("bids", {
      taskId: args.taskId, courierId: runner._id, courierName: runner.displayName,
      fee: args.fee, comment: args.comment, lat: args.lat, lng: args.lng,
      tripKm: args.tripKm, courierScore: runner.score, courierDeliveries: runner.deliveries,
      accepted: false, createdAt: Date.now(),
    });
    const shown = existing.filter((b) => !b.rejected).length - (displaced ? 1 : 0) + 1;
    await ctx.db.patch(args.taskId, { bidCount: shown });
    return bidId;
  },
});

/** The poster turns a bid down: it disappears from the list, and that runner can't bid on the task again. */
export const rejectBid = mutation({
  args: { token: v.string(), taskId: v.id("tasks"), bidId: v.id("bids") },
  handler: async (ctx, { token, taskId, bidId }) => {
    const poster = await requireUser(ctx, token);
    const task = await ctx.db.get(taskId);
    if (!task || task.posterId !== poster._id) throw new ConvexError("Only the poster can turn down bids on this task");
    if (task.status !== "open") throw new ConvexError("This task is no longer taking bids");
    const bid = await ctx.db.get(bidId);
    if (!bid || bid.taskId !== taskId) throw new ConvexError("Invalid bid");
    if (bid.accepted) throw new ConvexError("This bid was already accepted");
    if (bid.rejected) return { ok: true };
    await rateLimit(ctx, "rejectBid", poster._id);
    await ctx.db.patch(bidId, { rejected: true });
    const all = await ctx.db.query("bids").withIndex("by_task", (q) => q.eq("taskId", taskId)).take(maxBidRows(task) + 1);
    await ctx.db.patch(taskId, { bidCount: all.filter((b) => !b.rejected).length });
    return { ok: true };
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
    // Multi-runner tasks stay "open" while their slots fill.
    if (task.status !== "open") throw new ConvexError("Cannot accept");
    if (multi && slotsFull(task)) throw new ConvexError(task.slotsClosedAt ? "This task has stopped taking runners" : "All runner slots filled");
    const bid = await ctx.db.get(bidId);
    if (!bid || bid.taskId !== taskId) throw new ConvexError("Invalid bid");
    if (bid.accepted) throw new ConvexError("Bid already accepted");
    if (bid.rejected) throw new ConvexError("You turned this bid down");
    const escrow = requireFunded(task);
    const bidMicro = toMicro(bid.fee, "Bid");
    await ctx.db.patch(bidId, { accepted: true });
    const now = Date.now();

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
        lat: bid.lat, lng: bid.lng, acceptedAt: now,
      });
      const newAccepted = accepted + 1;
      const allFilled = newAccepted >= maxR;
      await setEscrow(ctx, taskId, newEscrow, {
        status: allFilled ? "in_progress" : "open",
        acceptedCount: newAccepted,
        acceptedAt: allFilled ? now : task.acceptedAt,
        firstAcceptedAt: task.firstAcceptedAt ?? now,
      });
      await systemNote(ctx, taskId, posterId, `${bid.courierName} accepted as runner! (${newAccepted}/${maxR} slots filled)`);
    } else {
      await setEscrow(ctx, taskId, newEscrow, {
        status: "in_progress", courierId: bid.courierId, courierName: bid.courierName,
        acceptedFee: bid.fee, acceptedAt: now,
        acceptedCount: 1,
        courierLat: bid.lat, courierLng: bid.lng,
      });
      const runnerLabel = isDelivery(task) ? "courier" : "runner";
      await systemNote(ctx, taskId, posterId, `${bid.courierName} accepted as ${runnerLabel}! Chat open.`);
    }
    return { escrow: fromMicro(newEscrow), charged: fromMicro(delta) };
  },
});

/** The poster of a multi-runner task stops looking for more runners and gets the money for empty slots back. */
export const closeSlots = mutation({
  args: { token: v.string(), taskId: v.id("tasks") },
  handler: async (ctx, { token, taskId }) => {
    const poster = await requireUser(ctx, token);
    const task = await ctx.db.get(taskId);
    if (!task || task.posterId !== poster._id) throw new ConvexError("Only the poster can close this task's slots");
    if (!isMultiRunner(task)) throw new ConvexError("Only tasks for more than one runner have slots to close");
    if (task.status !== "open" || slotsFull(task)) throw new ConvexError("This task isn't taking runners any more");
    if ((task.acceptedCount || 0) === 0) throw new ConvexError("No runner has been accepted yet: cancel the task instead to get everything back");
    const refund = await closeOpenSlots(ctx, task, Date.now(), false);
    const after = await ctx.db.get(taskId);
    return { refund: fromMicro(refund), runners: task.acceptedCount || 0, status: after?.status };
  },
});

export const updateCourierLoc = mutation({
  args: { token: v.string(), taskId: v.id("tasks"), lat: v.float64(), lng: v.float64() },
  handler: async (ctx, { token, taskId, lat, lng }) => {
    const user = await requireUser(ctx, token);
    const courierId = user._id;
    checkPosition(lat, lng, "Courier");
    const task = await ctx.db.get(taskId);
    if (!task || (task.status !== "in_progress" && task.status !== "open")) return;
    const multi = isMultiRunner(task);
    if (multi) {
      // Update taskRunner entry location
      const tr = await runnerEntry(ctx, taskId, courierId);
      if (!tr) return;
      await ctx.db.patch(tr._id, { lat, lng });
    } else {
      if (task.courierId !== courierId) return;
      await patchTask(ctx, taskId, { courierLat: lat, courierLng: lng });
    }
    await ctx.db.patch(courierId, { lastLat: lat, lastLng: lng });
  },
});

/** A runner hands in their work. Needs the proof the task asks for (lib/proof.ts). */
export const markDelivered = mutation({
  args: { token: v.string(), taskId: v.id("tasks"), proofData: v.optional(v.string()) },
  handler: async (ctx, { token, taskId, proofData }) => {
    const user = await requireUser(ctx, token);
    const courierId = user._id;
    if (proofData) clip(proofData, LIMITS.proof, "Proof");
    const task = await ctx.db.get(taskId);
    if (!task) throw new ConvexError("Cannot mark");
    const now = Date.now();
    const releaseAt = now + RELEASE_AFTER_MS;
    const note = proofData?.trim() || undefined;

    if (isMultiRunner(task)) {
      // A multi-runner task stays "open" while slots fill, and runners
      // accepted early can already deliver.
      if (task.status !== "in_progress" && task.status !== "open") throw new ConvexError("Cannot mark");
      const runner = await runnerEntry(ctx, taskId, courierId);
      if (!runner || runner.status !== "accepted") throw new ConvexError("Not assigned to this task");
      await requireProof(ctx, task, courierId, note);
      await ctx.db.patch(runner._id, { status: "delivered", deliveredAt: now, autoReleaseAt: releaseAt, ...(note ? { proofData: note } : {}) });
      await systemNote(ctx, taskId, courierId,
        `${user.displayName || "Runner"} submitted proof. The poster has 24 hours to confirm or open a dispute; after that this runner is paid automatically.`);
      await syncMulti(ctx, taskId, now);
    } else {
      if (task.status !== "in_progress" || task.courierId !== courierId) throw new ConvexError("Cannot mark");
      await requireProof(ctx, task, courierId, note);
      await patchTask(ctx, taskId, { status: "delivered", deliveredAt: now, autoReleaseAt: releaseAt, ...(note ? { proofData: note } : {}) });
      const label = isDelivery(task) ? "Marked as delivered" : "Proof submitted";
      await systemNote(ctx, taskId, courierId,
        `${label}. The poster has 24 hours to confirm or open a dispute; after that the runner is paid automatically.`);
    }
    return { autoReleaseAt: releaseAt };
  },
});

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
    const now = Date.now();

    if (isMultiRunner(task)) {
      // Multi-runner: confirm one runner. Confirming a disputed runner settles the dispute in their favour.
      if (!runnerId) throw new ConvexError("runnerId required for multi-runner task");
      const tr = await runnerEntry(ctx, taskId, runnerId);
      if (!tr || (tr.status !== "delivered" && tr.status !== "disputed")) throw new ConvexError("Runner not delivered");
      const done = await completeRunner(ctx, task, tr, now);
      await rate(ctx, taskId, posterId, done.runnerUser, ratingScore, ratingComment);
      await systemNote(ctx, taskId, posterId, `${done.runnerUser.displayName} confirmed! $${fmt(done.payoutMicro)} paid. (${done.newCompleted}/${task.maxRunners} done)`);
      return { payout: fromMicro(done.payoutMicro), burn: fromMicro(done.feeMicro), runnerId };
    }
    // The poster may pay early, or pay despite a dispute (theirs or the runner's).
    if (!["delivered", "in_progress", "disputed"].includes(task.status)) throw new ConvexError("Cannot confirm");
    const done = await completeSingle(ctx, task, now);
    await rate(ctx, taskId, posterId, done.runner, ratingScore, ratingComment);
    await systemNote(ctx, taskId, posterId, `Confirmed! $${fmt(done.payoutMicro)} USDC released. $${fmt(done.feeMicro)} platform fee.`);
    return { payout: fromMicro(done.payoutMicro), burn: fromMicro(done.feeMicro) };
  },
});

export const cancel = mutation({
  args: { token: v.string(), taskId: v.id("tasks") },
  handler: async (ctx, { token, taskId }) => {
    const poster = await requireUser(ctx, token);
    const task = await ctx.db.get(taskId);
    if (!task || task.status !== "open" || task.posterId !== poster._id) throw new ConvexError("Cannot cancel");
    if ((task.acceptedCount || 0) > 0) {
      throw new ConvexError("Cannot cancel: a runner has already been accepted. Close the open slots instead to get the money for them back.");
    }
    const refunded = await refundEscrow(ctx, task);
    await patchTask(ctx, taskId, { status: "cancelled" });
    return { refund: fromMicro(refunded) };
  },
});

// ── Dispute ──
// Holds the money until an admin settles it (resolveDispute). On a
// multi-runner task a dispute is about one runner's part: the poster names
// the runner, a runner disputes their own.
export const openDispute = mutation({
  args: { token: v.string(), taskId: v.id("tasks"), reason: v.string(), runnerId: v.optional(v.id("users")) },
  handler: async (ctx, { token, taskId, reason, runnerId }) => {
    const user = await requireUser(ctx, token);
    const userId = user._id;
    clip(reason, LIMITS.reason, "Reason");
    if (!reason.trim()) throw new ConvexError("Say what went wrong");
    const task = await ctx.db.get(taskId);
    if (!task) throw new ConvexError("Task not found");
    const now = Date.now();

    if (isMultiRunner(task)) {
      const role = task.posterId === userId ? "poster" : "runner";
      const target = role === "poster" ? runnerId : userId;
      if (!target) throw new ConvexError("Name the runner whose part you dispute (runnerId)");
      const tr = await runnerEntry(ctx, taskId, target);
      if (!tr) throw new ConvexError(role === "poster" ? "That runner isn't on this task" : "Unauthorized");
      if (tr.status !== "accepted" && tr.status !== "delivered") throw new ConvexError("Cannot dispute");
      await rateLimit(ctx, "dispute", userId);
      await ctx.db.patch(tr._id, { status: "disputed", disputeReason: reason, disputeBy: role, disputedAt: now, autoReleaseAt: undefined });
      await systemNote(ctx, taskId, userId, `⚠️ Dispute opened by ${role} (${user.displayName}) about ${tr.runnerName}'s part: "${reason}". That payment is held until resolved.`);
      await syncMulti(ctx, taskId, now);
      return { disputed: tr.runnerId };
    }

    if (task.status !== "in_progress" && task.status !== "delivered") throw new ConvexError("Cannot dispute");
    if (task.posterId !== userId && task.courierId !== userId) throw new ConvexError("Unauthorized");
    await rateLimit(ctx, "dispute", userId);
    const role = task.posterId === userId ? "poster" : "runner";
    await patchTask(ctx, taskId, { status: "disputed", disputeReason: reason, disputeBy: role, disputedAt: now, autoReleaseAt: undefined });
    await systemNote(ctx, taskId, userId, `⚠️ Dispute opened by ${role} (${user.displayName}): "${reason}". Funds held until resolved.`);
    return { disputed: task.courierId };
  },
});

/** Admin (run from the Convex dashboard): settle a dispute. Multi-runner tasks: name the runner. */
export const resolveDispute = internalMutation({
  args: {
    taskId: v.id("tasks"),
    resolution: v.union(v.literal("courier"), v.literal("poster")),
    runnerId: v.optional(v.id("users")),
  },
  handler: async (ctx, { taskId, resolution, runnerId }) => {
    const task = await ctx.db.get(taskId);
    if (!task) throw new ConvexError("Task not found");
    const now = Date.now();
    if (isMultiRunner(task)) {
      if (!runnerId) throw new ConvexError("runnerId required for multi-runner task");
      const tr = await runnerEntry(ctx, taskId, runnerId);
      if (!tr || tr.status !== "disputed") throw new ConvexError("Not disputed");
      if (resolution === "courier") {
        const done = await completeRunner(ctx, task, tr, now);
        return { payTo: "runner", amount: fromMicro(done.payoutMicro) };
      }
      const refunded = await refundEscrow(ctx, task, Math.min(toMicro(tr.fee), task.escrowMicro ?? 0));
      await ctx.db.patch(tr._id, { status: "refunded", completedAt: now });
      await syncMulti(ctx, taskId, now);
      return { payTo: "poster", amount: fromMicro(refunded) };
    }
    if (task.status !== "disputed") throw new ConvexError("Not disputed");
    if (resolution === "courier") {
      const done = await completeSingle(ctx, task, now);
      return { payTo: "runner", amount: fromMicro(done.payoutMicro) };
    }
    const refunded = await refundEscrow(ctx, task);
    await patchTask(ctx, taskId, { status: "refunded" });
    return { payTo: "poster", amount: fromMicro(refunded) };
  },
});

// The crons below take an optional `now` so an admin (or the end-to-end
// tests) can run what would be due at a later time. Internal only.
const later = { now: v.optional(v.number()) };

// ── Cron: pay runners whose delivery went unconfirmed and undisputed for 24 hours ──
// Reads only what is due (by_auto_release), so a backlog can't hide newer work.
export const autoRelease = internalMutation({
  args: later,
  handler: async (ctx, args) => {
    const now = args.now ?? Date.now();
    const due = await ctx.db.query("tasks").withIndex("by_auto_release", q => q.gt("autoReleaseAt", 0).lte("autoReleaseAt", now)).take(100);
    for (const task of due) {
      if (task.status !== "delivered" || isMultiRunner(task) || !task.courierId) {
        await ctx.db.patch(task._id, { autoReleaseAt: undefined });
        continue;
      }
      const done = await completeSingle(ctx, task, now);
      await systemNote(ctx, task._id, task.courierId,
        `Auto-released! $${fmt(done.payoutMicro)} USDC paid to the runner (not confirmed or disputed within 24 hours).`);
    }
    const runners = await ctx.db.query("taskRunners").withIndex("by_auto_release", q => q.gt("autoReleaseAt", 0).lte("autoReleaseAt", now)).take(100);
    for (const tr of runners) {
      const task = await ctx.db.get(tr.taskId);
      if (tr.status !== "delivered" || !task || task.status === "disputed") {
        await ctx.db.patch(tr._id, { autoReleaseAt: undefined });
        continue;
      }
      const done = await completeRunner(ctx, task, tr, now);
      await systemNote(ctx, task._id, tr.runnerId, `Auto-released! $${fmt(done.payoutMicro)} USDC paid to ${done.runnerUser.displayName}.`);
    }
    if (due.length === 100 || runners.length === 100) await ctx.scheduler.runAfter(0, internal.tasks.autoRelease, { now: args.now });
  },
});

// ── Cron: refund work that was accepted but not delivered within 4 hours ──
export const refundStuck = internalMutation({
  args: later,
  handler: async (ctx, args) => {
    const now = args.now ?? Date.now();
    const stuck = await ctx.db.query("tasks")
      .withIndex("by_status_accepted", q => q.eq("status", "in_progress").gt("acceptedAt", 0).lte("acceptedAt", now - DELIVER_WITHIN_MS)).take(100);
    for (const task of stuck) {
      if (!isMultiRunner(task)) {
        const refunded = await refundEscrow(ctx, task);
        await patchTask(ctx, task._id, { status: "refunded" });
        await systemNote(ctx, task._id, task.posterId, `Refunded: nothing was delivered within 4 hours. $${fmt(refunded)} USDC went back to the poster's balance.`);
        continue;
      }
      // Multi-runner: only runners who never delivered lose their slot.
      let refund = 0;
      for (const tr of await runnersOf(ctx, task._id)) {
        if (tr.status !== "accepted") continue;
        await ctx.db.patch(tr._id, { status: "expired" });
        refund += toMicro(tr.fee);
      }
      const fresh = await ctx.db.get(task._id);
      if (!fresh) continue;
      await refundEscrow(ctx, fresh, Math.min(refund, fresh.escrowMicro ?? 0));
      // Tasks from before slots could be closed went in progress with slots
      // still empty; close them so syncMulti can settle the task.
      if (!slotsFull(fresh)) await ctx.db.patch(task._id, { slotsClosedAt: now });
      // Nobody is left "accepted", so this moves the task to delivered or settles it.
      await syncMulti(ctx, task._id, now);
    }
    if (stuck.length === 100) await ctx.scheduler.runAfter(0, internal.tasks.refundStuck, { now: args.now });
  },
});

// ── Cron: multi-runner tasks stop taking runners 72 hours after the first one ──
export const closeStaleSlots = internalMutation({
  args: later,
  handler: async (ctx, args) => {
    const now = args.now ?? Date.now();
    const stale = await ctx.db.query("tasks")
      .withIndex("by_status_first_accepted", q => q.eq("status", "open").gt("firstAcceptedAt", 0).lte("firstAcceptedAt", now - FILL_SLOTS_WITHIN_MS)).take(50);
    for (const task of stale) {
      if (isMultiRunner(task) && !task.slotsClosedAt && (task.acceptedCount || 0) > 0) await closeOpenSlots(ctx, task, now, true);
      else await ctx.db.patch(task._id, { firstAcceptedAt: undefined });
    }
    if (stale.length === 50) await ctx.scheduler.runAfter(0, internal.tasks.closeStaleSlots, { now: args.now });
  },
});

// ── Queries ──
// Each takes the caller's token when there is one, and returns what that
// caller may see (lib/privacy.ts). Older web app builds sent a user ID
// instead; it is accepted and ignored so they degrade instead of erroring
// while a deploy is in flight.

async function caller(ctx: QueryCtx, token?: string) {
  return token ? await userForToken(ctx, token) : null;
}

/** Bids shown for a task: not the ones the poster turned down, except to the runner who made them. */
async function visibleBids(ctx: QueryCtx, task: Doc<"tasks">, userId?: Id<"users">) {
  const bids = await ctx.db.query("bids").withIndex("by_task", q => q.eq("taskId", task._id)).order("desc").take(maxBidRows(task));
  return bids.filter((b) => !b.rejected || b.courierId === userId);
}

export const listOpen = query({
  args: { token: v.optional(v.string()) },
  handler: async (ctx, { token }) => {
    const user = await caller(ctx, token);
    const tasks = await ctx.db.query("tasks").withIndex("by_status", q => q.eq("status", "open")).order("desc").take(50);
    return await Promise.all(tasks.map(async t => {
      // Tasks from before the counter: count (up to 21, shown as "20+").
      const bidCount = t.bidCount ?? (await ctx.db.query("bids").withIndex("by_task", q => q.eq("taskId", t._id)).take(21)).filter((b) => !b.rejected).length;
      return { ...taskView(t, await viewerOf(ctx, t, user?._id)), bidCount };
    }));
  },
});

const ACTIVE = ["open", "in_progress", "delivered", "disputed"];

/** The tasks a user posted or is running that aren't finished yet. */
async function activeTasksOf(ctx: QueryCtx, userId: Id<"users">) {
  const posted = (await Promise.all(ACTIVE.map((status) => ctx.db.query("tasks")
    .withIndex("by_poster_status", q => q.eq("posterId", userId).eq("status", status)).order("desc").take(20)))).flat();
  const running = (await ctx.db.query("tasks").withIndex("by_courier", q => q.eq("courierId", userId)).order("desc").take(20))
    .filter((t) => ACTIVE.includes(t.status));
  // Multi-runner tasks where the user is one of the runners
  const trEntries = await ctx.db.query("taskRunners").withIndex("by_runner", q => q.eq("runnerId", userId)).order("desc").take(50);
  const trTasks = (await Promise.all(trEntries.filter((tr) => !isSettled(tr)).map((tr) => ctx.db.get(tr.taskId))))
    .filter((t): t is Doc<"tasks"> => !!t && ACTIVE.includes(t.status));
  const all = [...posted, ...running, ...trTasks];
  return all.filter((t, i, a) => a.findIndex(x => x._id === t._id) === i).sort((a, b) => b.createdAt - a.createdAt);
}

/** The caller's own tasks that are still going: posted, or being run. */
export const getActive = query({
  args: { token: v.optional(v.string()), userId: v.optional(v.id("users")) },
  handler: async (ctx, { token }) => {
    const user = await caller(ctx, token);
    if (!user) return [];
    const tasks = await activeTasksOf(ctx, user._id);
    return await Promise.all(tasks.map(async t => taskView(t, await viewerOf(ctx, t, user._id))));
  },
});

/**
 * The caller's unfinished tasks in brief, with what is waiting on whom:
 * deliveries the poster should check (and when they pay out on their own),
 * and where the caller's own work stands. For agents (GET /my-tasks) and the
 * web app's reminder.
 */
export const myTasks = query({
  args: { token: v.optional(v.string()) },
  handler: async (ctx, { token }) => {
    const user = await caller(ctx, token);
    if (!user) return [];
    const out = [];
    for (const t of await activeTasksOf(ctx, user._id)) {
      const role = await viewerOf(ctx, t, user._id);
      if (role === "public") continue;
      const multi = isMultiRunner(t);
      const runners = multi ? await runnersOf(ctx, t._id) : [];
      const delivered = multi
        ? runners.filter((r) => r.status === "delivered").map((r) => ({ runnerId: r.runnerId, runnerName: r.runnerName, deliveredAt: r.deliveredAt, autoReleaseAt: r.autoReleaseAt }))
        : t.status === "delivered" && t.courierId ? [{ runnerId: t.courierId, runnerName: t.courierName, deliveredAt: t.deliveredAt, autoReleaseAt: t.autoReleaseAt }] : [];
      const mine = multi ? runners.find((r) => r.runnerId === user._id) : undefined;
      const need = describeNeed(proofNeeded(t));
      out.push({
        taskId: t._id, title: t.title, status: t.status, role,
        taskType: getTaskType(t), createdAt: t.createdAt,
        fee: t.acceptedFee ?? t.suggestedFee, escrow: fromMicro(t.escrowMicro ?? 0),
        maxRunners: t.maxRunners || 1, acceptedCount: t.acceptedCount || 0, bidCount: t.bidCount,
        proofNeeded: need,
        ...(role === "poster" ? {
          awaitingConfirmation: delivered,
          disputedRunners: multi ? runners.filter((r) => r.status === "disputed").map((r) => r.runnerId) : undefined,
          canCloseSlots: multi && t.status === "open" && !slotsFull(t) && (t.acceptedCount || 0) > 0,
        } : {
          myStatus: multi ? mine?.status : t.status,
          autoReleaseAt: multi ? mine?.autoReleaseAt : t.autoReleaseAt,
        }),
      });
    }
    return out;
  },
});

export const getTask = query({
  args: { taskId: v.id("tasks"), token: v.optional(v.string()) },
  handler: async (ctx, { taskId, token }) => {
    const task = await ctx.db.get(taskId);
    if (!task) return null;
    const user = await caller(ctx, token);
    return taskView(task, await viewerOf(ctx, task, user?._id));
  },
});

export const getBid = query({
  args: { bidId: v.id("bids"), token: v.optional(v.string()) },
  handler: async (ctx, { bidId, token }) => {
    const bid = await ctx.db.get(bidId);
    if (!bid) return null;
    const task = await ctx.db.get(bid.taskId);
    const user = await caller(ctx, token);
    return bidView(bid, task ? await viewerOf(ctx, task, user?._id) : "public", user?._id);
  },
});

export const getBids = query({
  args: { taskId: v.id("tasks"), token: v.optional(v.string()) },
  handler: async (ctx, { taskId, token }) => {
    const task = await ctx.db.get(taskId);
    if (!task) return [];
    const user = await caller(ctx, token);
    const viewer = await viewerOf(ctx, task, user?._id);
    return (await visibleBids(ctx, task, user?._id)).map(b => bidView(b, viewer, user?._id));
  },
});

export const getTaskRunners = query({
  args: { taskId: v.id("tasks"), token: v.optional(v.string()) },
  handler: async (ctx, { taskId, token }) => {
    const task = await ctx.db.get(taskId);
    if (!task) return [];
    const user = await caller(ctx, token);
    const viewer = await viewerOf(ctx, task, user?._id);
    return (await runnersOf(ctx, taskId)).map(tr => runnerView(tr, viewer));
  },
});

// ── History: the caller's own finished tasks ──

export const getCourierHistory = query({
  args: { token: v.optional(v.string()), courierId: v.optional(v.id("users")) },
  handler: async (ctx, { token }) => {
    const user = await caller(ctx, token);
    if (!user) return [];
    const courierId = user._id;
    const tasks = await ctx.db.query("tasks").withIndex("by_courier", q => q.eq("courierId", courierId)).order("desc").take(50);
    const done = tasks.filter(t => t.status === "completed" || t.status === "cancelled" || t.status === "refunded");
    return await Promise.all(done.map(async t => {
      const bid = await ctx.db.query("bids").withIndex("by_task", q => q.eq("taskId", t._id)).take(50);
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
  args: { token: v.optional(v.string()), posterId: v.optional(v.id("users")) },
  handler: async (ctx, { token }) => {
    const user = await caller(ctx, token);
    if (!user) return [];
    const tasks = await ctx.db.query("tasks").withIndex("by_poster", q => q.eq("posterId", user._id)).order("desc").take(50);
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

/** Public totals, from running counters (lib/stats.ts): never reads the tasks themselves. */
export const getStats = query({
  args: {},
  handler: async (ctx) => {
    const [total, open, completed, feeMicro] = await Promise.all([
      readStat(ctx, "tasks.total"), readStat(ctx, "tasks.status.open"),
      readStat(ctx, "tasks.status.completed"), readStat(ctx, "fees.micro"),
    ]);
    return { total, open, completed, burned: Math.round(feeMicro / 1e4) / 100 };
  },
});

/**
 * Admin (run from the Convex dashboard): recount the stats from the tasks,
 * a page at a time. Run once after deploying the counters, or if they drift.
 */
export const rebuildStats = internalMutation({
  args: { cursor: v.optional(v.union(v.string(), v.null())) },
  handler: async (ctx, { cursor }) => {
    if (!cursor) {
      for (const row of await ctx.db.query("stats").take(1000)) await ctx.db.delete(row._id);
    }
    const page = await ctx.db.query("tasks").paginate({ numItems: 50, cursor: cursor ?? null });
    for (const t of page.page) {
      await bump(ctx, "tasks.total", 1);
      await bump(ctx, `tasks.status.${t.status}`, 1);
      await bump(ctx, "fees.micro", t.feeMicro ?? 0);
    }
    if (!page.isDone) await ctx.scheduler.runAfter(0, internal.tasks.rebuildStats, { cursor: page.continueCursor });
    return { counted: page.page.length, done: page.isDone };
  },
});
