import { ConvexError } from "convex/values";
import { MutationCtx } from "../_generated/server";
import { Id } from "../_generated/dataModel";

// Per-account limits on actions that cost nothing, so one account can't
// flood the board, the bid lists, storage or chat. Each limit is a token
// bucket: `burst` actions at once, refilled at `perHour`. A refused call
// changes nothing (the whole mutation rolls back).
//
// Accounts are free to create, so these slow down one account, not a crowd
// of them: the minimum fee, bid displacement and the poster turning bids
// down handle that. Limits are per account only; a global limit would let
// one attacker lock everyone else out.

export const LIMITS = {
  post: { burst: 10, perHour: 10, what: "tasks posted" },
  bid: { burst: 30, perHour: 30, what: "bids" },
  upload: { burst: 60, perHour: 60, what: "uploads" },
  chat: { burst: 30, perHour: 120, what: "messages" },
  dispute: { burst: 5, perHour: 0.5, what: "disputes" },
  rejectBid: { burst: 100, perHour: 100, what: "bids turned down" },
} as const;

export type LimitName = keyof typeof LIMITS;

const HOUR = 60 * 60 * 1000;

/** Spend one token of `name` for `userId`, or throw when none is left. */
export async function rateLimit(ctx: MutationCtx, name: LimitName, userId: Id<"users">) {
  const { burst, perHour, what } = LIMITS[name];
  const key = `${name}:${userId}`;
  const now = Date.now();
  const row = await ctx.db.query("rateLimits").withIndex("by_key", (q) => q.eq("key", key)).unique();
  const tokens = row ? Math.min(burst, row.tokens + ((now - row.updatedAt) / HOUR) * perHour) : burst;
  if (tokens < 1) {
    const minutes = Math.max(1, Math.ceil(((1 - tokens) / perHour) * 60));
    throw new ConvexError(`Too many ${what} from this account. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`);
  }
  if (row) await ctx.db.patch(row._id, { tokens: tokens - 1, updatedAt: now });
  else await ctx.db.insert("rateLimits", { key, tokens: tokens - 1, updatedAt: now });
}
