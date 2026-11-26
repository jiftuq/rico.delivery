import { ConvexError } from "convex/values";
import { MutationCtx, QueryCtx } from "../_generated/server";
import { Doc, Id } from "../_generated/dataModel";

// What a runner has to hand in before a task can pay out.
//
// The proof types come from the task and its steps (photo, video, text, gps,
// none). A runner can only mark their part done once the proof is there:
//
//   photo        at least one photo they uploaded to the task
//   video        at least one video
//   text, gps,   a note, or any photo or video
//   other, unset
//   none         nothing (only when every step says "none")
//
// This makes "done" mean something; it can't prove the photo is genuine.
// That is what the poster's check, the 24-hour window and disputes are for.

export const MAX_PROOFS_PER_TASK = 200;
export const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
export const MAX_VIDEO_BYTES = 250 * 1024 * 1024;
const IMAGE_TYPES = /^image\/(jpeg|png|webp|heic|heif|gif)$/;
const VIDEO_TYPES = /^video\/(mp4|quicktime|webm|3gpp)$/;

/** A file type that can be attached as proof. */
export const isMedia = (contentType?: string) => {
  const type = (contentType ?? "").toLowerCase();
  return IMAGE_TYPES.test(type) || VIDEO_TYPES.test(type);
};

export type ProofNeed = { photo: boolean; video: boolean; note: boolean };

export function proofNeeded(task: Doc<"tasks">): ProofNeed {
  const types = [task.proofType, ...(task.steps ?? []).map((s) => s.proofType)]
    .filter((t): t is string => typeof t === "string" && t.length > 0)
    .map((t) => t.toLowerCase());
  if (types.length === 0) return { photo: false, video: false, note: true };
  return {
    photo: types.includes("photo"),
    video: types.includes("video"),
    note: types.some((t) => !["photo", "video", "none"].includes(t)),
  };
}

/** Plain-language list of what a task asks for, e.g. "a photo and a video". */
export function describeNeed(need: ProofNeed): string | null {
  // A photo or video also counts as the note, so only mention the note alone.
  const parts = [need.photo && "a photo", need.video && "a video"].filter(Boolean);
  if (parts.length) return parts.join(" and ");
  return need.note ? "a note or a photo" : null;
}

/** Throw unless `runnerId` has handed in the proof `task` asks for. */
export async function requireProof(ctx: MutationCtx, task: Doc<"tasks">, runnerId: Id<"users">, note?: string) {
  const need = proofNeeded(task);
  if (!need.photo && !need.video && !need.note) return;
  const files = (await ctx.db.query("proofFiles").withIndex("by_task", (q) => q.eq("taskId", task._id)).take(MAX_PROOFS_PER_TASK))
    .filter((f) => f.runnerId === runnerId);
  const hasPhoto = files.some((f) => f.fileType.startsWith("image/"));
  const hasVideo = files.some((f) => f.fileType.startsWith("video/"));
  const missing: string[] = [];
  if (need.photo && !hasPhoto) missing.push("a photo");
  if (need.video && !hasVideo) missing.push("a video");
  if (need.note && missing.length === 0 && !note?.trim() && files.length === 0) missing.push("a note or a photo");
  if (missing.length) {
    throw new ConvexError(`This task needs proof before it can be marked done: add ${missing.join(" and ")} first.`);
  }
}

/** Whether `userId` is working on `task` right now (and so may upload proof for it). */
export async function isWorkingOn(ctx: QueryCtx, task: Doc<"tasks">, userId: Id<"users">) {
  if ((task.maxRunners || 1) > 1) {
    const tr = await ctx.db.query("taskRunners")
      .withIndex("by_task_runner", (q) => q.eq("taskId", task._id).eq("runnerId", userId)).first();
    return !!tr && ["accepted", "delivered", "disputed"].includes(tr.status);
  }
  return task.courierId === userId && ["in_progress", "delivered", "disputed"].includes(task.status);
}

/** The stored file behind an upload, if it is a photo or video of a sensible size. */
export async function checkUpload(ctx: QueryCtx, storageId: string) {
  const id = ctx.db.system.normalizeId("_storage", storageId);
  const meta = id ? await ctx.db.system.get(id) : null;
  if (!meta) throw new ConvexError("Upload not found. Upload the file again.");
  const type = (meta.contentType ?? "").toLowerCase();
  if (IMAGE_TYPES.test(type)) {
    if (meta.size > MAX_IMAGE_BYTES) throw new ConvexError("Photos can be at most 25 MB");
  } else if (VIDEO_TYPES.test(type)) {
    if (meta.size > MAX_VIDEO_BYTES) throw new ConvexError("Videos can be at most 250 MB");
  } else {
    throw new ConvexError("Proof must be a photo (JPEG, PNG, WebP, HEIC, GIF) or a video (MP4, MOV, WebM)");
  }
  return { fileType: type, size: meta.size };
}
