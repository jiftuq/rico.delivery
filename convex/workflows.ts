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
    // Same size limits as tasks, and a cap per account.
    const tooLong = (text: string | undefined, max: number) => (text?.length ?? 0) > max;
    if (tooLong(args.name, 100) || tooLong(args.category, 60) || tooLong(args.taskType, 60)) throw new ConvexError("Name, category or type is too long");
    if (args.steps.length > 30) throw new ConvexError("A workflow can have at most 30 steps");
    if (args.steps.some((s) => tooLong(s.action, 500) || tooLong(s.locationAddr, 300) || tooLong(s.requirements, 200) || tooLong(s.proofType, 20))) {
      throw new ConvexError("A step is too long (action 500, address 300, requirements 200 characters)");
    }
    const mine = await ctx.db.query("savedWorkflows").withIndex("by_user", (q) => q.eq("userId", user._id)).take(50);
    if (mine.length >= 50) throw new ConvexError("You can save at most 50 workflows. Delete one first.");
    args.defaultRunners = Math.max(1, Math.min(Math.floor(args.defaultRunners) || 1, 100));
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
      .take(50);
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
