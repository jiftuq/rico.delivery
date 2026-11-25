import { MutationCtx, QueryCtx } from "../_generated/server";

// Running totals for the public stats, so nothing ever has to read every task.
// Keys: "tasks.total", "tasks.status.<status>", "fees.micro".
// tasks.ts changes task status only through patchTask(), which keeps these right.

export async function bump(ctx: MutationCtx, key: string, delta: number) {
  if (!delta) return;
  const row = await ctx.db.query("stats").withIndex("by_key", (q) => q.eq("key", key)).unique();
  if (row) await ctx.db.patch(row._id, { value: row.value + delta });
  else await ctx.db.insert("stats", { key, value: delta });
}

export async function readStat(ctx: QueryCtx, key: string) {
  const row = await ctx.db.query("stats").withIndex("by_key", (q) => q.eq("key", key)).unique();
  return row?.value ?? 0;
}
