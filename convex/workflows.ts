import { mutation, query } from "./_generated/server";
import { ConvexError, v } from "convex/values";
import { requireUser, userForToken } from "./lib/auth";

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
    token: v.string(),
    name: v.string(),
    category: v.string(),
    taskType: v.string(),
    defaultRunners: v.number(),
    steps: v.array(stepValidator),
  },
  handler: async (ctx, { token, ...args }) => {
    const user = await requireUser(ctx, token);
    return await ctx.db.insert("savedWorkflows", {
      ...args,
      userId: user._id,
      createdAt: Date.now(),
      usedCount: 0,
    });
  },
});

// List user's saved workflows
export const list = query({
  args: { token: v.optional(v.string()) },
  handler: async (ctx, { token }) => {
    const user = await userForToken(ctx, token);
    if (!user) return [];
    const userId = user._id;
    return await ctx.db
      .query("savedWorkflows")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
  },
});

// Delete a saved workflow
export const remove = mutation({
  args: { token: v.string(), workflowId: v.id("savedWorkflows") },
  handler: async (ctx, { token, workflowId }) => {
    const user = await requireUser(ctx, token);
    const wf = await ctx.db.get(workflowId);
    if (!wf || wf.userId !== user._id) throw new ConvexError("Not yours");
    await ctx.db.delete(workflowId);
  },
});

// Increment usage count when a workflow is reused
export const markUsed = mutation({
  args: { token: v.string(), workflowId: v.id("savedWorkflows") },
  handler: async (ctx, { token, workflowId }) => {
    const user = await requireUser(ctx, token);
    const wf = await ctx.db.get(workflowId);
    if (wf && wf.userId === user._id) await ctx.db.patch(workflowId, { usedCount: wf.usedCount + 1 });
  },
});
