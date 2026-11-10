import { mutation, query } from "./_generated/server";
import { ConvexError, v } from "convex/values";
import { requireUser } from "./lib/auth";

// Generate a URL for file upload (Convex storage)
export const generateUploadUrl = mutation({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    await requireUser(ctx, token);
    return await ctx.storage.generateUploadUrl();
  },
});

// Save proof file metadata after upload
export const saveProofFile = mutation({
  args: {
    token: v.string(),
    taskId: v.id("tasks"),
    stepOrder: v.optional(v.number()),
    storageId: v.string(),
    fileType: v.string(),
    fileName: v.optional(v.string()),
    caption: v.optional(v.string()),
  },
  handler: async (ctx, { token, ...args }) => {
    // Only a runner working on the task can attach proof to it.
    const user = await requireUser(ctx, token);
    const task = await ctx.db.get(args.taskId);
    if (!task) throw new ConvexError("Task not found");
    const assigned = task.courierId === user._id || (await ctx.db.query("taskRunners")
      .withIndex("by_task_runner", (q) => q.eq("taskId", args.taskId).eq("runnerId", user._id)).first()) !== null;
    if (!assigned) throw new ConvexError("Only a runner on this task can upload proof");
    return await ctx.db.insert("proofFiles", {
      ...args,
      runnerId: user._id,
      createdAt: Date.now(),
    });
  },
});

// Get all proof files for a task
export const getProofFiles = query({
  args: { taskId: v.id("tasks") },
  handler: async (ctx, { taskId }) => {
    const files = await ctx.db
      .query("proofFiles")
      .withIndex("by_task", (q) => q.eq("taskId", taskId))
      .collect();
    // Attach download URLs
    return await Promise.all(
      files.map(async (f) => ({
        ...f,
        url: await ctx.storage.getUrl(f.storageId),
      }))
    );
  },
});

// Get proof files for a specific step
export const getStepProofs = query({
  args: { taskId: v.id("tasks"), stepOrder: v.number() },
  handler: async (ctx, { taskId, stepOrder }) => {
    const files = await ctx.db
      .query("proofFiles")
      .withIndex("by_task_step", (q) =>
        q.eq("taskId", taskId).eq("stepOrder", stepOrder)
      )
      .collect();
    return await Promise.all(
      files.map(async (f) => ({
        ...f,
        url: await ctx.storage.getUrl(f.storageId),
      }))
    );
  },
});
