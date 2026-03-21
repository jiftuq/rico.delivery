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
    deliveries: v.number(), // legacy name, means "completions"
    tasksPosted: v.number(),
    lastLat: v.optional(v.float64()),
    lastLng: v.optional(v.float64()),
    createdAt: v.number(),
  })
    .index("by_wallet", ["walletAddress"])
    .index("by_score", ["score"]),

  tasks: defineTable({
    title: v.string(),
    category: v.string(), // delivery, errand, social, info, verification, custom
    details: v.string(),
    // Task type: "delivery" (default/legacy) or generic task types
    taskType: v.optional(v.string()), // delivery, go-somewhere, interact, gather-info, physical-action, verification
    // Generic location (single destination for non-delivery tasks)
    locationAddr: v.optional(v.string()),
    locationLat: v.optional(v.float64()),
    locationLng: v.optional(v.float64()),
    // Action + proof for non-delivery tasks
    action: v.optional(v.string()),
    proofType: v.optional(v.string()), // photo, video, text, gps, none
    proofData: v.optional(v.string()), // submitted proof from runner
    targetPerson: v.optional(v.string()),
    // Workflow steps — the core of a task
    steps: v.optional(v.array(v.object({
      order: v.number(),
      action: v.string(),           // "Go to restaurant", "Pick up order", "Deliver to customer"
      locationAddr: v.optional(v.string()),
      locationLat: v.optional(v.float64()),
      locationLng: v.optional(v.float64()),
      proofType: v.optional(v.string()),  // photo, video, text, gps, none
      proofData: v.optional(v.string()),  // submitted proof for this step
      requirements: v.optional(v.string()), // "van", "camera", "ID", etc.
      status: v.optional(v.string()),       // pending, in_progress, completed
    }))),
    // Moving-specific (legacy, kept for backward compat)
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
    // Delivery-specific (optional for non-delivery tasks)
    pickupAddr: v.optional(v.string()),
    pickupLat: v.optional(v.float64()),
    pickupLng: v.optional(v.float64()),
    dropoffAddr: v.optional(v.string()),
    dropoffLat: v.optional(v.float64()),
    dropoffLng: v.optional(v.float64()),
    items: v.optional(v.array(v.object({ name: v.string(), cost: v.float64() }))),
    privacyZone: v.number(),
    itemCost: v.optional(v.float64()), // optional for non-delivery tasks
    suggestedFee: v.float64(),
    acceptedFee: v.optional(v.float64()),
    totalEscrowed: v.float64(),
    // Multi-runner support
    maxRunners: v.optional(v.number()), // default 1; >1 = multi-runner task
    acceptedCount: v.optional(v.number()), // how many runners accepted so far
    completedCount: v.optional(v.number()), // how many runners completed so far
    posterId: v.id("users"),
    posterName: v.string(),
    courierId: v.optional(v.id("users")), // legacy: single-runner tasks only
    courierName: v.optional(v.string()),
    status: v.string(),
    courierLat: v.optional(v.float64()),
    courierLng: v.optional(v.float64()),
    createdAt: v.number(),
    acceptedAt: v.optional(v.number()),
    completedAt: v.optional(v.number()),
    deliveredAt: v.optional(v.number()),
    disputeReason: v.optional(v.string()),
    disputeBy: v.optional(v.string()),
    disputedAt: v.optional(v.number()),
  })
    .index("by_status", ["status"])
    .index("by_poster", ["posterId"])
    .index("by_courier", ["courierId"]),

  bids: defineTable({
    taskId: v.id("tasks"),
    courierId: v.id("users"), // legacy name, means "runnerId"
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
    role: v.string(), // poster, courier/runner, system
    text: v.string(),
    createdAt: v.number(),
  })
    .index("by_task", ["taskId"]),

  taskRunners: defineTable({
    taskId: v.id("tasks"),
    runnerId: v.id("users"),
    runnerName: v.string(),
    bidId: v.id("bids"),
    fee: v.float64(),
    status: v.string(), // accepted, in_progress, delivered, completed, disputed
    proofData: v.optional(v.string()),
    lat: v.optional(v.float64()),
    lng: v.optional(v.float64()),
    acceptedAt: v.number(),
    completedAt: v.optional(v.number()),
    deliveredAt: v.optional(v.number()),
  })
    .index("by_task", ["taskId"])
    .index("by_runner", ["runnerId"])
    .index("by_task_runner", ["taskId", "runnerId"]),

  // Proof files — photos/videos uploaded by runners
  proofFiles: defineTable({
    taskId: v.id("tasks"),
    runnerId: v.id("users"),
    stepOrder: v.optional(v.number()), // which workflow step this proof belongs to
    storageId: v.string(), // Convex storage ID
    fileType: v.string(), // image/jpeg, image/png, video/mp4, etc.
    fileName: v.optional(v.string()),
    caption: v.optional(v.string()),
    createdAt: v.number(),
  })
    .index("by_task", ["taskId"])
    .index("by_task_step", ["taskId", "stepOrder"])
    .index("by_runner", ["runnerId"]),

  // Saved workflow templates — reusable by users
  savedWorkflows: defineTable({
    userId: v.id("users"),
    name: v.string(),
    category: v.string(),
    taskType: v.string(),
    defaultRunners: v.number(),
    steps: v.array(v.object({
      order: v.number(),
      action: v.string(),
      locationAddr: v.optional(v.string()),
      locationLat: v.optional(v.float64()),
      locationLng: v.optional(v.float64()),
      proofType: v.optional(v.string()),
      requirements: v.optional(v.string()),
    })),
    createdAt: v.number(),
    usedCount: v.number(),
  })
    .index("by_user", ["userId"]),

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
