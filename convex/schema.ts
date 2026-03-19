import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  users: defineTable({
    walletAddress: v.string(),
    displayName: v.string(),
    balance: v.float64(),
    score: v.float64(),
    totalRatings: v.number(),
    ratingSum: v.number(),
    deliveries: v.number(),
    tasksPosted: v.number(),
    lastLat: v.optional(v.float64()),
    lastLng: v.optional(v.float64()),
    createdAt: v.number(),
  })
    .index("by_wallet", ["walletAddress"])
    .index("by_score", ["score"]),

  tasks: defineTable({
    title: v.string(),
    category: v.string(),
    details: v.string(),
    pickupAddr: v.string(),
    pickupLat: v.float64(),
    pickupLng: v.float64(),
    dropoffAddr: v.string(),
    dropoffLat: v.float64(),
    dropoffLng: v.float64(),
    items: v.optional(v.array(v.object({ name: v.string(), cost: v.float64() }))),
    privacyZone: v.number(),
    itemCost: v.float64(),
    suggestedFee: v.float64(),
    acceptedFee: v.optional(v.float64()),
    totalEscrowed: v.float64(),
    posterId: v.id("users"),
    posterName: v.string(),
    courierId: v.optional(v.id("users")),
    courierName: v.optional(v.string()),
    status: v.string(),
    courierLat: v.optional(v.float64()),
    courierLng: v.optional(v.float64()),
    createdAt: v.number(),
    acceptedAt: v.optional(v.number()),
    completedAt: v.optional(v.number()),
  })
    .index("by_status", ["status"])
    .index("by_poster", ["posterId"])
    .index("by_courier", ["courierId"]),

  bids: defineTable({
    taskId: v.id("tasks"),
    courierId: v.id("users"),
    courierName: v.string(),
    fee: v.float64(),
    comment: v.string(),
    lat: v.float64(),
    lng: v.float64(),
    tripKm: v.float64(),
    courierScore: v.float64(),
    courierDeliveries: v.number(),
    accepted: v.boolean(),
    createdAt: v.number(),
  })
    .index("by_task", ["taskId"])
    .index("by_courier", ["courierId"]),

  messages: defineTable({
    taskId: v.id("tasks"),
    senderId: v.id("users"),
    senderName: v.string(),
    role: v.string(),
    text: v.string(),
    createdAt: v.number(),
  })
    .index("by_task", ["taskId"]),

  ratings: defineTable({
    taskId: v.id("tasks"),
    raterId: v.id("users"),
    ratedId: v.id("users"),
    score: v.number(),
    comment: v.string(),
    createdAt: v.number(),
  })
    .index("by_rated", ["ratedId"])
    .index("by_rater_task", ["raterId", "taskId"]),
});
