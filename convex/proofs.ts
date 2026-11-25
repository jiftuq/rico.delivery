import { mutation, query, QueryCtx } from "./_generated/server";
import { ConvexError, v } from "convex/values";
import { Doc, Id } from "./_generated/dataModel";
import { requireUser, userForToken } from "./lib/auth";
import { viewerOf } from "./lib/privacy";

// Proof photos, videos and notes from runners. Only the people on the task
// (its poster and accepted runners) can read them.

const MAX_PROOFS_PER_TASK = 200;

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
    if (args.storageId.length > 100) throw new ConvexError("Invalid file");
    if (args.fileType.length > 100) throw new ConvexError("File type is too long");
    if ((args.fileName?.length ?? 0) > 200) throw new ConvexError("File name is too long (max 200 characters)");
    if ((args.caption?.length ?? 0) > 500) throw new ConvexError("Caption is too long (max 500 characters)");
    const existing = await ctx.db.query("proofFiles").withIndex("by_task", (q) => q.eq("taskId", args.taskId)).take(MAX_PROOFS_PER_TASK);
    if (existing.length >= MAX_PROOFS_PER_TASK) throw new ConvexError(`A task can have at most ${MAX_PROOFS_PER_TASK} proof files`);
    return await ctx.db.insert("proofFiles", {
      ...args,
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
