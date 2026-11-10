import { mutation, query, QueryCtx } from "./_generated/server";
import { ConvexError, v } from "convex/values";
import { Doc, Id } from "./_generated/dataModel";
import { requireUser, userForToken } from "./lib/auth";

/** Poster, the assigned runner, or one of a multi-runner task's runners. */
async function isParticipant(ctx: QueryCtx, task: Doc<"tasks">, userId: Id<"users">) {
  if (task.posterId === userId || task.courierId === userId) return true;
  const tr = await ctx.db.query("taskRunners")
    .withIndex("by_task_runner", q => q.eq("taskId", task._id).eq("runnerId", userId)).first();
  return tr !== null;
}

export const send = mutation({
  args: { token: v.string(), taskId: v.id("tasks"), text: v.string() },
  handler: async (ctx, { token, taskId, text }) => {
    const user = await requireUser(ctx, token);
    const task = await ctx.db.get(taskId);
    if (!task) throw new ConvexError("Not found");
    if (!(await isParticipant(ctx, task, user._id))) throw new ConvexError("Unauthorized");
    if (task.status !== "in_progress" && task.status !== "delivered") throw new ConvexError("Chat closed");
    if (!text.trim() || text.length > 2000) throw new ConvexError("Message must be 1-2000 characters");
    return await ctx.db.insert("messages", {
      taskId, senderId: user._id, senderName: user.displayName,
      role: task.posterId === user._id ? "poster" : "courier",
      text, createdAt: Date.now(),
    });
  },
});

/** A task's chat, visible only to the people working on it. */
export const list = query({
  args: { token: v.optional(v.string()), taskId: v.id("tasks") },
  handler: async (ctx, { token, taskId }) => {
    const user = await userForToken(ctx, token);
    const task = await ctx.db.get(taskId);
    if (!user || !task || !(await isParticipant(ctx, task, user._id))) return [];
    return ctx.db.query("messages").withIndex("by_task", q => q.eq("taskId", taskId)).collect();
  },
});
