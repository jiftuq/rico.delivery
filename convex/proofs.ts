import { mutation, query, QueryCtx } from "./_generated/server";
import { ConvexError, v } from "convex/values";
import { Doc, Id } from "./_generated/dataModel";
import { requireUser, userForToken } from "./lib/auth";
import { viewerOf } from "./lib/privacy";
import { MAX_PROOFS_PER_TASK, checkUpload, isWorkingOn } from "./lib/proof";
import { rateLimit } from "./lib/rateLimit";

// Proof photos and videos from runners. Only a runner working on a task can
// upload to it, and only the people on the task (its poster and runners)
// can see what was uploaded.

/** Whether the user is working on any task right now (for app builds that don't say which). */
async function worksOnSomething(ctx: QueryCtx, userId: Id<"users">) {
  const single = await ctx.db.query("tasks").withIndex("by_courier", (q) => q.eq("courierId", userId)).order("desc").take(20);
  if (single.some((t) => ["in_progress", "delivered", "disputed"].includes(t.status))) return true;
  const multi = await ctx.db.query("taskRunners").withIndex("by_runner", (q) => q.eq("runnerId", userId)).order("desc").take(50);
  return multi.some((tr) => ["accepted", "delivered", "disputed"].includes(tr.status));
}

// A URL to upload one file to (Convex storage)
export const generateUploadUrl = mutation({
  args: { token: v.string(), taskId: v.optional(v.id("tasks")) },
  handler: async (ctx, { token, taskId }) => {
    const user = await requireUser(ctx, token);
    const task = taskId ? await ctx.db.get(taskId) : null;
    const allowed = taskId ? !!task && (await isWorkingOn(ctx, task, user._id)) : await worksOnSomething(ctx, user._id);
    if (!allowed) throw new ConvexError("Only a runner working on this task can upload proof");
    await rateLimit(ctx, "upload", user._id);
    return await ctx.storage.generateUploadUrl();
  },
});

// Attach an uploaded file to a task as proof
export const saveProofFile = mutation({
  args: {
    token: v.string(),
    taskId: v.id("tasks"),
    stepOrder: v.optional(v.number()),
    storageId: v.string(),
    fileType: v.string(), // ignored: the type is read from the upload itself
    fileName: v.optional(v.string()),
    caption: v.optional(v.string()),
  },
  handler: async (ctx, { token, fileType: _claimed, ...args }) => {
    // Only a runner working on the task can attach proof to it.
    const user = await requireUser(ctx, token);
    const task = await ctx.db.get(args.taskId);
    if (!task) throw new ConvexError("Task not found");
    if (!(await isWorkingOn(ctx, task, user._id))) throw new ConvexError("Only a runner working on this task can upload proof");
    if (args.storageId.length > 100) throw new ConvexError("Invalid file");
    if ((args.fileName?.length ?? 0) > 200) throw new ConvexError("File name is too long (max 200 characters)");
    if ((args.caption?.length ?? 0) > 500) throw new ConvexError("Caption is too long (max 500 characters)");
    // What the file really is, as stored, not what the client says it is.
    const { fileType } = await checkUpload(ctx, args.storageId);
    const existing = await ctx.db.query("proofFiles").withIndex("by_task", (q) => q.eq("taskId", args.taskId)).take(MAX_PROOFS_PER_TASK);
    if (existing.length >= MAX_PROOFS_PER_TASK) throw new ConvexError(`A task can have at most ${MAX_PROOFS_PER_TASK} proof files`);
    if (existing.some((f) => f.storageId === args.storageId)) throw new ConvexError("This file is already attached");
    return await ctx.db.insert("proofFiles", {
      ...args,
      fileType,
      runnerId: user._id,
      createdAt: Date.now(),
    });
  },
});

/** Proof files with download links, for the people on the task only. */
async function forParticipants(ctx: QueryCtx, taskId: Id<"tasks">, token: string | undefined, files: () => Promise<Doc<"proofFiles">[]>) {
  const task = await ctx.db.get(taskId);
  const user = token ? await userForToken(ctx, token) : null;
  if (!task || (await viewerOf(ctx, task, user?._id)) === "public") return [];
  return await Promise.all((await files()).map(async (f) => ({ ...f, url: await ctx.storage.getUrl(f.storageId) })));
}

// Get all proof files for a task
export const getProofFiles = query({
  args: { taskId: v.id("tasks"), token: v.optional(v.string()) },
  handler: async (ctx, { taskId, token }) =>
    forParticipants(ctx, taskId, token, () =>
      ctx.db.query("proofFiles").withIndex("by_task", (q) => q.eq("taskId", taskId)).take(MAX_PROOFS_PER_TASK)),
});

// Get proof files for a specific step
export const getStepProofs = query({
  args: { taskId: v.id("tasks"), stepOrder: v.number(), token: v.optional(v.string()) },
  handler: async (ctx, { taskId, stepOrder, token }) =>
    forParticipants(ctx, taskId, token, () =>
      ctx.db.query("proofFiles").withIndex("by_task_step", (q) => q.eq("taskId", taskId).eq("stepOrder", stepOrder)).take(MAX_PROOFS_PER_TASK)),
});
