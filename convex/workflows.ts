import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

const stepValidator = v.object({
  order: v.number(),
  action: v.string(),
  locationAddr: v.optional(v.string()),
  locationLat: v.optional(v.float64()),
  locationLng: v.optional(v.float64()),
  proofType: v.optional(v.string()),
  requirements: v.optional(v.string()),
});

// Save a workflow template
export const save = mutation({
  args: {
    userId: v.id("users"),
    name: v.string(),
    category: v.string(),
    taskType: v.string(),
    defaultRunners: v.number(),
    steps: v.array(stepValidator),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("savedWorkflows", {
      ...args,
      createdAt: Date.now(),
      usedCount: 0,
    });
  },
});

// List user's saved workflows
export const list = query({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }) => {
    return await ctx.db
      .query("savedWorkflows")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
  },
});

// Delete a saved workflow
export const remove = mutation({
  args: { workflowId: v.id("savedWorkflows"), userId: v.id("users") },
  handler: async (ctx, { workflowId, userId }) => {
    const wf = await ctx.db.get(workflowId);
    if (!wf || wf.userId !== userId) throw new Error("Not yours");
    await ctx.db.delete(workflowId);
  },
});

// Increment usage count when a workflow is reused
export const markUsed = mutation({
  args: { workflowId: v.id("savedWorkflows") },
  handler: async (ctx, { workflowId }) => {
    const wf = await ctx.db.get(workflowId);
    if (wf) await ctx.db.patch(workflowId, { usedCount: wf.usedCount + 1 });
  },
});
