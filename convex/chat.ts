import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

export const send = mutation({
  args: { taskId: v.id("tasks"), senderId: v.id("users"), text: v.string() },
  handler: async (ctx, { taskId, senderId, text }) => {
    const task = await ctx.db.get(taskId);
    if (!task) throw new Error("Not found");
    const ok = task.posterId === senderId || task.courierId === senderId;
    if (!ok) throw new Error("Unauthorized");
    if (task.status !== "in_progress" && task.status !== "delivered") throw new Error("Chat closed");
    const user = await ctx.db.get(senderId);
    if (!user) throw new Error("No user");
    return await ctx.db.insert("messages", {
      taskId, senderId, senderName: user.displayName,
      role: task.posterId === senderId ? "poster" : "courier",
      text, createdAt: Date.now(),
    });
  },
});

export const list = query({
  args: { taskId: v.id("tasks") },
  handler: async (ctx, { taskId }) =>
    ctx.db.query("messages").withIndex("by_task", q => q.eq("taskId", taskId)).collect(),
});
