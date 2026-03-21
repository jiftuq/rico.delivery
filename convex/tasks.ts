import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

const FEE_RATE = 0.07;

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

export const create = mutation({
  args: {
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
    posterId: v.id("users"),
  },
  handler: async (ctx, args) => {
    const poster = await ctx.db.get(args.posterId);
    if (!poster) throw new Error("User not found");
    const taskType = args.taskType || "delivery";
    const itemCost = args.itemCost || 0;
    const maxRunners = Math.max(1, Math.min(args.maxRunners || 1, 100));
    // Multi-runner: escrow = (itemCost + fee) * maxRunners
    const total = maxRunners > 1 ? args.suggestedFee * maxRunners : itemCost + args.suggestedFee;
    await ctx.db.patch(args.posterId, { tasksPosted: poster.tasksPosted + 1 });

    const doc: any = {
      title: args.title, category: args.category, details: args.details,
      taskType,
      privacyZone: args.privacyZone ?? 100,
      itemCost, suggestedFee: args.suggestedFee, items: args.items,
      totalEscrowed: total, posterId: args.posterId, posterName: poster.displayName,
      maxRunners, acceptedCount: 0, completedCount: 0,
      status: "open", createdAt: Date.now(),
    };

    if (taskType === "delivery") {
      // Delivery requires pickup + dropoff
      if (!args.pickupAddr || !args.dropoffAddr) throw new Error("Delivery needs pickup and dropoff");
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
      if (!args.locationAddr && (!args.steps || args.steps.length === 0)) throw new Error("Task needs a location");
      if (args.locationAddr) {
        doc.locationAddr = args.locationAddr; doc.locationLat = args.locationLat; doc.locationLng = args.locationLng;
      }
      doc.action = args.action || args.details;
      doc.proofType = args.proofType || "photo";
      doc.targetPerson = args.targetPerson;
      if (args.steps) doc.steps = args.steps;
    }

    return await ctx.db.insert("tasks", doc);
  },
});

export const placeBid = mutation({
  args: {
    taskId: v.id("tasks"), courierId: v.id("users"),
    fee: v.float64(), comment: v.string(), lat: v.float64(), lng: v.float64(),
    tripKm: v.float64(),
  },
  handler: async (ctx, args) => {
    const task = await ctx.db.get(args.taskId);
    if (!task || task.status !== "open") throw new Error("Not open");
    if (task.posterId === args.courierId) throw new Error("Own task");
    const runner = await ctx.db.get(args.courierId);
    if (!runner) throw new Error("Not found");
    const existing = await ctx.db.query("bids").withIndex("by_task", q => q.eq("taskId", args.taskId)).collect();
    if (existing.some(b => b.courierId === args.courierId)) throw new Error("Already bid");
    if (existing.length >= 20) throw new Error("Max bids");
    await ctx.db.patch(args.courierId, { lastLat: args.lat, lastLng: args.lng });
    return await ctx.db.insert("bids", {
      taskId: args.taskId, courierId: args.courierId, courierName: runner.displayName,
      fee: args.fee, comment: args.comment, lat: args.lat, lng: args.lng,
      tripKm: args.tripKm, courierScore: runner.score, courierDeliveries: runner.deliveries,
      accepted: false, createdAt: Date.now(),
    });
  },
});

export const acceptBid = mutation({
  args: { taskId: v.id("tasks"), bidId: v.id("bids"), posterId: v.id("users") },
  handler: async (ctx, { taskId, bidId, posterId }) => {
    const task = await ctx.db.get(taskId);
    if (!task || task.posterId !== posterId) throw new Error("Cannot accept");
    const maxR = task.maxRunners || 1;
    const accepted = task.acceptedCount || 0;
    const multi = maxR > 1;
    // For single-runner: must be "open". For multi: "open" or "in_progress" (still filling slots)
    if (!multi && task.status !== "open") throw new Error("Cannot accept");
    if (multi && task.status !== "open" && task.status !== "in_progress") throw new Error("Cannot accept");
    if (multi && accepted >= maxR) throw new Error("All runner slots filled");
    const bid = await ctx.db.get(bidId);
    if (!bid || bid.taskId !== taskId) throw new Error("Invalid bid");
    if (bid.accepted) throw new Error("Bid already accepted");
    const poster = await ctx.db.get(posterId);
    if (!poster) throw new Error("Not found");
    await ctx.db.patch(bidId, { accepted: true });

    if (multi) {
      // Multi-runner: create taskRunner entry, increment count
      await ctx.db.insert("taskRunners", {
        taskId, runnerId: bid.courierId, runnerName: bid.courierName,
        bidId, fee: bid.fee, status: "accepted",
        lat: bid.lat, lng: bid.lng, acceptedAt: Date.now(),
      });
      const newAccepted = accepted + 1;
      const allFilled = newAccepted >= maxR;
      await ctx.db.patch(taskId, {
        status: allFilled ? "in_progress" : "open",
        acceptedCount: newAccepted,
        acceptedAt: allFilled ? Date.now() : task.acceptedAt,
      });
      await ctx.db.insert("messages", {
        taskId, senderId: posterId, senderName: "System", role: "system",
        text: `${bid.courierName} accepted as runner! (${newAccepted}/${maxR} slots filled)`, createdAt: Date.now(),
      });
    } else {
      // Single-runner: original logic
      const newTotal = (task.itemCost || 0) + bid.fee;
      await ctx.db.patch(taskId, {
        status: "in_progress", courierId: bid.courierId, courierName: bid.courierName,
        acceptedFee: bid.fee, totalEscrowed: newTotal, acceptedAt: Date.now(),
        acceptedCount: 1,
        courierLat: bid.lat, courierLng: bid.lng,
      });
      const runnerLabel = isDelivery(task) ? "courier" : "runner";
      await ctx.db.insert("messages", {
        taskId, senderId: posterId, senderName: "System", role: "system",
        text: `${bid.courierName} accepted as ${runnerLabel}! Chat open.`, createdAt: Date.now(),
      });
    }
  },
});

export const updateCourierLoc = mutation({
  args: { taskId: v.id("tasks"), courierId: v.id("users"), lat: v.float64(), lng: v.float64() },
  handler: async (ctx, { taskId, courierId, lat, lng }) => {
    const task = await ctx.db.get(taskId);
    if (!task || (task.status !== "in_progress" && task.status !== "open")) return;
    const multi = isMultiRunner(task);
    if (multi) {
      // Update taskRunner entry location
      const trs = await ctx.db.query("taskRunners").withIndex("by_task_runner", q => q.eq("taskId", taskId).eq("runnerId", courierId)).collect();
      if (trs[0]) await ctx.db.patch(trs[0]._id, { lat, lng });
    } else {
      if (task.courierId !== courierId) return;
      await ctx.db.patch(taskId, { courierLat: lat, courierLng: lng });
    }
    await ctx.db.patch(courierId, { lastLat: lat, lastLng: lng });
  },
});

export const markDelivered = mutation({
  args: {
    taskId: v.id("tasks"), courierId: v.id("users"),
    proofData: v.optional(v.string()),
  },
  handler: async (ctx, { taskId, courierId, proofData }) => {
    const task = await ctx.db.get(taskId);
    if (!task || task.status !== "in_progress") throw new Error("Cannot mark");
    const multi = isMultiRunner(task);

    if (multi) {
      // Multi-runner: mark individual runner as delivered
      const runners = await ctx.db.query("taskRunners").withIndex("by_task_runner", q => q.eq("taskId", taskId).eq("runnerId", courierId)).collect();
      const runner = runners[0];
      if (!runner || runner.status !== "accepted") throw new Error("Not assigned to this task");
      const patch: any = { status: "delivered", deliveredAt: Date.now() };
      if (proofData) patch.proofData = proofData;
      await ctx.db.patch(runner._id, patch);
      const user = await ctx.db.get(courierId);
      await ctx.db.insert("messages", {
        taskId, senderId: courierId, senderName: "System", role: "system",
        text: `${user?.displayName || "Runner"} submitted proof. Waiting for confirmation.`, createdAt: Date.now(),
      });
      // Check if ALL runners delivered → move task to "delivered"
      const allRunners = await ctx.db.query("taskRunners").withIndex("by_task", q => q.eq("taskId", taskId)).collect();
      if (allRunners.every(r => r.status === "delivered" || r.status === "completed")) {
        await ctx.db.patch(taskId, { status: "delivered", deliveredAt: Date.now() });
      }
    } else {
      // Single-runner: original logic
      if (task.courierId !== courierId) throw new Error("Cannot mark");
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

export const confirmDelivery = mutation({
  args: {
    taskId: v.id("tasks"), posterId: v.id("users"),
    runnerId: v.optional(v.id("users")), // required for multi-runner
    ratingScore: v.optional(v.number()), ratingComment: v.optional(v.string()),
  },
  handler: async (ctx, { taskId, posterId, runnerId, ratingScore, ratingComment }) => {
    const task = await ctx.db.get(taskId);
    if (!task) throw new Error("Task not found");
    if (task.posterId !== posterId) throw new Error("Unauthorized");
    const multi = isMultiRunner(task);
    const now = Date.now();

    if (multi) {
      // Multi-runner: confirm individual runner
      if (!runnerId) throw new Error("runnerId required for multi-runner task");
      const trs = await ctx.db.query("taskRunners").withIndex("by_task_runner", q => q.eq("taskId", taskId).eq("runnerId", runnerId)).collect();
      const tr = trs[0];
      if (!tr || tr.status !== "delivered") throw new Error("Runner not delivered");
      const runnerUser = await ctx.db.get(runnerId);
      if (!runnerUser) throw new Error("Runner gone");
      const perRunnerFee = tr.fee;
      const burn = Math.round(perRunnerFee * FEE_RATE * 100) / 100;
      const payout = perRunnerFee - burn;
      await ctx.db.patch(tr._id, { status: "completed", completedAt: now });
      await ctx.db.patch(runnerId, { deliveries: runnerUser.deliveries + 1 });
      if (ratingScore && ratingScore >= 1 && ratingScore <= 5) {
        await ctx.db.insert("ratings", {
          taskId, raterId: posterId, ratedId: runnerId,
          score: ratingScore, comment: ratingComment || "", createdAt: now,
        });
        const newTotal = runnerUser.totalRatings + 1;
        const newSum = runnerUser.ratingSum + ratingScore;
        await ctx.db.patch(runnerId, {
          totalRatings: newTotal, ratingSum: newSum,
          score: Math.round((newSum / newTotal) * 10) / 10,
        });
      }
      // Check if all runners completed
      const newCompleted = (task.completedCount || 0) + 1;
      await ctx.db.patch(taskId, { completedCount: newCompleted });
      const allRunners = await ctx.db.query("taskRunners").withIndex("by_task", q => q.eq("taskId", taskId)).collect();
      if (allRunners.every(r => r.status === "completed")) {
        await ctx.db.patch(taskId, { status: "completed", completedAt: now });
      }
      await ctx.db.insert("messages", {
        taskId, senderId: posterId, senderName: "System", role: "system",
        text: `${runnerUser.displayName} confirmed! $${payout.toFixed(2)} paid. (${newCompleted}/${task.maxRunners} done)`, createdAt: now,
      });
      return { payout, burn, runnerId };
    } else {
      // Single-runner: original logic
      if (task.status !== "delivered" && task.status !== "in_progress") throw new Error("Cannot confirm");
      if (!task.courierId) throw new Error("No runner assigned");
      const runner = await ctx.db.get(task.courierId);
      if (!runner) throw new Error("Runner gone");
      const burn = Math.round(task.totalEscrowed * FEE_RATE * 100) / 100;
      const payout = task.totalEscrowed - burn;
      await ctx.db.patch(task.courierId, { deliveries: runner.deliveries + 1 });
      await ctx.db.patch(taskId, { status: "completed", completedAt: now, completedCount: 1 });
      if (ratingScore && ratingScore >= 1 && ratingScore <= 5) {
        await ctx.db.insert("ratings", {
          taskId, raterId: posterId, ratedId: task.courierId,
          score: ratingScore, comment: ratingComment || "", createdAt: now,
        });
        const newTotal = runner.totalRatings + 1;
        const newSum = runner.ratingSum + ratingScore;
        await ctx.db.patch(task.courierId, {
          totalRatings: newTotal, ratingSum: newSum,
          score: Math.round((newSum / newTotal) * 10) / 10,
        });
      }
      await ctx.db.insert("messages", {
        taskId, senderId: posterId, senderName: "System", role: "system",
        text: `Confirmed! $${payout.toFixed(2)} USDC released. $${burn.toFixed(2)} platform fee.`, createdAt: now,
      });
      return { payout, burn };
    }
  },
});

export const cancel = mutation({
  args: { taskId: v.id("tasks"), posterId: v.id("users") },
  handler: async (ctx, { taskId, posterId }) => {
    const task = await ctx.db.get(taskId);
    if (!task || task.status !== "open" || task.posterId !== posterId) throw new Error("Cannot cancel");
    await ctx.db.patch(taskId, { status: "cancelled" });
    return task;
  },
});

export const refundTask = mutation({
  args: { taskId: v.id("tasks") },
  handler: async (ctx, { taskId }) => {
    const task = await ctx.db.get(taskId);
    if (!task || task.status !== "in_progress") return null;
    await ctx.db.patch(taskId, { status: "refunded" });
    return task;
  },
});

// ── Dispute ──
export const openDispute = mutation({
  args: { taskId: v.id("tasks"), userId: v.id("users"), reason: v.string() },
  handler: async (ctx, { taskId, userId, reason }) => {
    const task = await ctx.db.get(taskId);
    if (!task) throw new Error("Task not found");
    if (task.status !== "in_progress" && task.status !== "delivered") throw new Error("Cannot dispute");
    if (task.posterId !== userId && task.courierId !== userId) throw new Error("Unauthorized");
    const role = task.posterId === userId ? "poster" : "runner";
    await ctx.db.patch(taskId, { status: "disputed", disputeReason: reason, disputeBy: role, disputedAt: Date.now() });
    const user = await ctx.db.get(userId);
    await ctx.db.insert("messages", {
      taskId, senderId: userId, senderName: "System", role: "system",
      text: `\u26a0\ufe0f Dispute opened by ${role} (${user?.displayName}): "${reason}". Funds held until resolved.`, createdAt: Date.now(),
    });
  },
});

export const resolveDispute = mutation({
  args: { taskId: v.id("tasks"), resolution: v.string() },
  handler: async (ctx, { taskId, resolution }) => {
    const task = await ctx.db.get(taskId);
    if (!task || task.status !== "disputed") throw new Error("Not disputed");
    if (resolution === "courier") {
      const runner = task.courierId ? await ctx.db.get(task.courierId) : null;
      if (runner) await ctx.db.patch(task.courierId!, { deliveries: runner.deliveries + 1 });
      await ctx.db.patch(taskId, { status: "completed", completedAt: Date.now() });
      return { payTo: "runner", courierId: task.courierId, amount: task.totalEscrowed };
    } else {
      await ctx.db.patch(taskId, { status: "refunded" });
      return { payTo: "poster", posterId: task.posterId, amount: task.totalEscrowed };
    }
  },
});

// ── Auto-release: pay runner if delivered > 2 hours without confirmation ──
export const getDeliveredExpired = query({
  args: {},
  handler: async (ctx) => {
    const twoHours = 2 * 60 * 60 * 1000;
    const now = Date.now();
    const tasks = await ctx.db.query("tasks").withIndex("by_status", q => q.eq("status", "delivered")).collect();
    return tasks.filter(t => t.deliveredAt && now - t.deliveredAt > twoHours);
  },
});

export const autoReleaseToCourier = mutation({
  args: { taskId: v.id("tasks") },
  handler: async (ctx, { taskId }) => {
    const task = await ctx.db.get(taskId);
    if (!task || task.status !== "delivered" || !task.courierId) return null;
    const runner = await ctx.db.get(task.courierId);
    if (!runner) return null;
    const burn = Math.round(task.totalEscrowed * FEE_RATE * 100) / 100;
    const payout = task.totalEscrowed - burn;
    await ctx.db.patch(task.courierId, { deliveries: runner.deliveries + 1 });
    await ctx.db.patch(taskId, { status: "completed", completedAt: Date.now() });
    await ctx.db.insert("messages", {
      taskId, senderId: task.courierId, senderName: "System", role: "system",
      text: `Auto-released! $${payout.toFixed(2)} USDC paid to runner (requester did not confirm within 2 hours).`, createdAt: Date.now(),
    });
    return { payout, burn, courierId: task.courierId };
  },
});

// ── Stuck in_progress tasks (no completion after 4 hours) → refund poster ──
export const getStuckTasks = query({
  args: {},
  handler: async (ctx) => {
    const fourHours = 4 * 60 * 60 * 1000;
    const now = Date.now();
    const tasks = await ctx.db.query("tasks").withIndex("by_status", q => q.eq("status", "in_progress")).collect();
    return tasks.filter(t => t.acceptedAt && now - t.acceptedAt > fourHours);
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
