import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { requireUser } from "./lib/auth";

// Accounts are created by signing in with a wallet (see auth.ts).
// These are the public, read-only views of a user: no balance.

function publicUser(user: any) {
  const { balance: _b, balanceMicro: _m, ...rest } = user;
  return rest;
}

export const get = query({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }) => {
    const user = await ctx.db.get(userId);
    return user ? publicUser(user) : null;
  },
});

export const updateLocation = mutation({
  args: { token: v.string(), lat: v.float64(), lng: v.float64() },
  handler: async (ctx, { token, lat, lng }) => {
    const user = await requireUser(ctx, token);
    await ctx.db.patch(user._id, { lastLat: lat, lastLng: lng });
  },
});

export const getProfile = query({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }) => {
    const user = await ctx.db.get(userId);
    if (!user) return null;
    const reviews = await ctx.db.query("ratings").withIndex("by_rated", q => q.eq("ratedId", userId)).order("desc").take(10);
    const enriched = await Promise.all(reviews.map(async r => {
      const rater = await ctx.db.get(r.raterId);
      return { ...r, raterName: rater?.displayName || "Anon" };
    }));
    return { ...publicUser(user), reviews: enriched };
  },
});
