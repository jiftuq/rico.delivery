import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

const FEE_RATE = 0.07;

export const create = mutation({
  args: {
    title: v.string(), category: v.string(), details: v.string(),
    pickupAddr: v.string(), pickupLat: v.float64(), pickupLng: v.float64(),
    dropoffAddr: v.string(), dropoffLat: v.float64(), dropoffLng: v.float64(),
    privacyZone: v.number(), itemCost: v.float64(), suggestedFee: v.float64(),
    items: v.optional(v.array(v.object({ name: v.string(), cost: v.float64() }))),
    posterId: v.id("users"),
  },
  handler: async (ctx, args) => {
    const poster = await ctx.db.get(args.posterId);
    if (!poster) throw new Error("User not found");
    const total = args.itemCost + args.suggestedFee;
    await ctx.db.patch(args.posterId, { tasksPosted: poster.tasksPosted + 1 });
    return await ctx.db.insert("tasks", {
      title: args.title, category: args.category, details: args.details,
      pickupAddr: args.pickupAddr, pickupLat: args.pickupLat, pickupLng: args.pickupLng,
      dropoffAddr: args.dropoffAddr, dropoffLat: args.dropoffLat, dropoffLng: args.dropoffLng,
      privacyZone: args.privacyZone, itemCost: args.itemCost, suggestedFee: args.suggestedFee,
      items: args.items,
      totalEscrowed: total, posterId: args.posterId, posterName: poster.displayName,
      status: "open", createdAt: Date.now(),
    });
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
    const courier = await ctx.db.get(args.courierId);
    if (!courier) throw new Error("Not found");
    const existing = await ctx.db.query("bids").withIndex("by_task", q => q.eq("taskId", args.taskId)).collect();
    if (existing.some(b => b.courierId === args.courierId)) throw new Error("Already bid");
    if (existing.length >= 20) throw new Error("Max bids");
    await ctx.db.patch(args.courierId, { lastLat: args.lat, lastLng: args.lng });
    return await ctx.db.insert("bids", {
      taskId: args.taskId, courierId: args.courierId, courierName: courier.displayName,
      fee: args.fee, comment: args.comment, lat: args.lat, lng: args.lng,
      tripKm: args.tripKm, courierScore: courier.score, courierDeliveries: courier.deliveries,
      accepted: false, createdAt: Date.now(),
    });
  },
});

export const acceptBid = mutation({
  args: { taskId: v.id("tasks"), bidId: v.id("bids"), posterId: v.id("users") },
  handler: async (ctx, { taskId, bidId, posterId }) => {
    const task = await ctx.db.get(taskId);
    if (!task || task.status !== "open" || task.posterId !== posterId) throw new Error("Cannot accept");
    const bid = await ctx.db.get(bidId);
    if (!bid || bid.taskId !== taskId) throw new Error("Invalid bid");
    const poster = await ctx.db.get(posterId);
    if (!poster) throw new Error("Not found");
    const newTotal = task.itemCost + bid.fee;
    // Balance adjustments handled by the server via on-chain USDC transfers
    await ctx.db.patch(bidId, { accepted: true });
    await ctx.db.patch(taskId, {
      status: "in_progress", courierId: bid.courierId, courierName: bid.courierName,
      acceptedFee: bid.fee, totalEscrowed: newTotal, acceptedAt: Date.now(),
      courierLat: bid.lat, courierLng: bid.lng,
    });
    await ctx.db.insert("messages", {
      taskId, senderId: posterId, senderName: "System", role: "system",
      text: `${bid.courierName} accepted! Chat open. Exact address revealed.`, createdAt: Date.now(),
    });
  },
});

export const updateCourierLoc = mutation({
  args: { taskId: v.id("tasks"), courierId: v.id("users"), lat: v.float64(), lng: v.float64() },
  handler: async (ctx, { taskId, courierId, lat, lng }) => {
    const task = await ctx.db.get(taskId);
    if (!task || task.status !== "in_progress" || task.courierId !== courierId) return;
    await ctx.db.patch(taskId, { courierLat: lat, courierLng: lng });
    await ctx.db.patch(courierId, { lastLat: lat, lastLng: lng });
  },
});

export const markDelivered = mutation({
  args: { taskId: v.id("tasks"), courierId: v.id("users") },
  handler: async (ctx, { taskId, courierId }) => {
    const task = await ctx.db.get(taskId);
    if (!task || task.status !== "in_progress" || task.courierId !== courierId) throw new Error("Cannot mark");
    await ctx.db.patch(taskId, { status: "delivered" });
    await ctx.db.insert("messages", {
      taskId, senderId: courierId, senderName: "System", role: "system",
      text: "Marked as delivered. Waiting for confirmation.", createdAt: Date.now(),
    });
  },
});

export const confirmDelivery = mutation({
  args: {
    taskId: v.id("tasks"), posterId: v.id("users"),
    ratingScore: v.optional(v.number()), ratingComment: v.optional(v.string()),
  },
  handler: async (ctx, { taskId, posterId, ratingScore, ratingComment }) => {
    const task = await ctx.db.get(taskId);
    if (!task || (task.status !== "delivered" && task.status !== "in_progress")) throw new Error("Cannot confirm");
    if (task.posterId !== posterId || !task.courierId) throw new Error("Unauthorized");
    const courier = await ctx.db.get(task.courierId);
    if (!courier) throw new Error("Courier gone");
    const burn = Math.round(task.totalEscrowed * FEE_RATE * 100) / 100;
    const payout = task.totalEscrowed - burn;
    // USDC payout sent on-chain by the server; just update stats here
    await ctx.db.patch(task.courierId, { deliveries: courier.deliveries + 1 });
    const now = Date.now();
    await ctx.db.patch(taskId, { status: "completed", completedAt: now });
    if (ratingScore && ratingScore >= 1 && ratingScore <= 5) {
      await ctx.db.insert("ratings", {
        taskId, raterId: posterId, ratedId: task.courierId,
        score: ratingScore, comment: ratingComment || "", createdAt: now,
      });
      const newTotal = courier.totalRatings + 1;
      const newSum = courier.ratingSum + ratingScore;
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
  },
});

export const cancel = mutation({
  args: { taskId: v.id("tasks"), posterId: v.id("users") },
  handler: async (ctx, { taskId, posterId }) => {
    const task = await ctx.db.get(taskId);
    if (!task || task.status !== "open" || task.posterId !== posterId) throw new Error("Cannot cancel");
    // USDC refund sent on-chain by the server
    await ctx.db.patch(taskId, { status: "cancelled" });
    return task; // return so server knows the refund amount
  },
});

export const refundTask = mutation({
  args: { taskId: v.id("tasks") },
  handler: async (ctx, { taskId }) => {
    const task = await ctx.db.get(taskId);
    if (!task || task.status !== "in_progress") return null;
    await ctx.db.patch(taskId, { status: "refunded" });
    return task; // return so server knows the refund amount + poster
  },
});

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
    const delivering = await ctx.db.query("tasks").withIndex("by_courier", q => q.eq("courierId", userId)).order("desc").take(20);
    const active = [...posted, ...delivering].filter(t => t.status !== "completed" && t.status !== "cancelled" && t.status !== "refunded");
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

// ── History queries ──

export const getCourierHistory = query({
  args: { courierId: v.id("users") },
  handler: async (ctx, { courierId }) => {
    const tasks = await ctx.db.query("tasks").withIndex("by_courier", q => q.eq("courierId", courierId)).order("desc").take(50);
    const done = tasks.filter(t => t.status === "completed" || t.status === "cancelled" || t.status === "refunded");
    // Find the accepted bid for each task to get tripKm
    return await Promise.all(done.map(async t => {
      const bid = await ctx.db.query("bids").withIndex("by_task", q => q.eq("taskId", t._id)).collect();
      const accepted = bid.find(b => b.courierId === courierId && b.accepted);
      return {
        _id: t._id, status: t.status, category: t.category, title: t.title,
        acceptedFee: t.acceptedFee ?? 0, totalEscrowed: t.totalEscrowed,
        tripKm: accepted?.tripKm ?? 0, completedAt: t.completedAt, createdAt: t.createdAt,
        // Full details (frontend hides these on public view)
        pickupAddr: t.pickupAddr, dropoffAddr: t.dropoffAddr, itemCost: t.itemCost,
        items: t.items, details: t.details,
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
      totalEscrowed: t.totalEscrowed, acceptedFee: t.acceptedFee,
      courierName: t.courierName, completedAt: t.completedAt, createdAt: t.createdAt,
      // Full details (frontend hides these on public view)
      pickupAddr: t.pickupAddr, dropoffAddr: t.dropoffAddr, itemCost: t.itemCost,
      suggestedFee: t.suggestedFee, items: t.items, details: t.details,
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
