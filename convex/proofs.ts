import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

// Generate a URL for file upload (Convex storage)
export const generateUploadUrl = mutation({
  args: {},
  handler: async (ctx) => {
    return await ctx.storage.generateUploadUrl();
  },
});

// Save proof file metadata after upload
export const saveProofFile = mutation({
  args: {
    taskId: v.id("tasks"),
    runnerId: v.id("users"),
    stepOrder: v.optional(v.number()),
    storageId: v.string(),
    fileType: v.string(),
    fileName: v.optional(v.string()),
    caption: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("proofFiles", {
      ...args,
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
