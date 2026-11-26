import { internalMutation, mutation, query, QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { ConvexError, v } from "convex/values";
import { Doc, Id } from "./_generated/dataModel";
import { requireUser, userForToken } from "./lib/auth";
import { viewerOf } from "./lib/privacy";
import { MAX_PROOFS_PER_TASK, checkUpload, isMedia, isWorkingOn } from "./lib/proof";
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

// ── Cron: delete uploads that never became proof ──
// Whoever uploads a file can open its storage link, so a file that isn't
// attached to a task must not stay around: that would make RICO free hosting
// for anything, including fake web pages. A photo or video gets 10 minutes to
// be attached (the app attaches it right away); anything else can never be
// attached, so it goes at the next run. Proof files are the only thing this
// app keeps in file storage.
const ATTACH_WITHIN_MS = 10 * 60 * 1000;
const SWEEP_BATCH = 200;

export const sweepUploads = internalMutation({
  args: { now: v.optional(v.number()) }, // a later time, for admins and tests
  handler: async (ctx, args) => {
    const now = args.now ?? Date.now();
    const cursor = await ctx.db.query("cursors").withIndex("by_name", (q) => q.eq("name", "uploads")).unique();
    const since = cursor?.value ?? 0;
    const files = await ctx.db.system.query("_storage")
      .withIndex("by_creation_time", (q) => q.gt("_creationTime", since)).take(SWEEP_BATCH);
    // `reached` only moves past files that are settled, so a photo still
    // waiting to be attached is looked at again next time; the files after it
    // are still checked now.
    let reached = since, waiting = false, deleted = 0;
    for (const f of files) {
      const attached = await ctx.db.query("proofFiles").withIndex("by_storage", (q) => q.eq("storageId", f._id)).first();
      if (!attached) {
        if (isMedia(f.contentType) && now - f._creationTime < ATTACH_WITHIN_MS) { waiting = true; continue; }
        await ctx.storage.delete(f._id);
        deleted++;
      }
      if (!waiting) reached = f._creationTime;
    }
    if (reached !== since) {
      if (cursor) await ctx.db.patch(cursor._id, { value: reached });
      else await ctx.db.insert("cursors", { name: "uploads", value: reached });
    }
    if (files.length === SWEEP_BATCH && reached !== since) await ctx.scheduler.runAfter(0, internal.proofs.sweepUploads, { now: args.now });
    return { checked: files.length, deleted };
  },
});
