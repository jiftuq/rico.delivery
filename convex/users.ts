import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

export const getOrCreate = mutation({
  args: { walletAddress: v.string(), displayName: v.optional(v.string()) },
  handler: async (ctx, { walletAddress, displayName }) => {
    const existing = await ctx.db.query("users").withIndex("by_wallet", q => q.eq("walletAddress", walletAddress)).first();
    if (existing) return existing._id;
    return await ctx.db.insert("users", {
      walletAddress,
      displayName: displayName || walletAddress.slice(0, 6) + "..." + walletAddress.slice(-4),
      balance: 0, score: 5.0,
      totalRatings: 0, ratingSum: 0, deliveries: 0, tasksPosted: 0, createdAt: Date.now(),
    });
  },
});

export const get = query({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }) => await ctx.db.get(userId),
});

export const getByWallet = query({
  args: { walletAddress: v.string() },
  handler: async (ctx, { walletAddress }) =>
    await ctx.db.query("users").withIndex("by_wallet", q => q.eq("walletAddress", walletAddress)).first(),
});

export const updateLocation = mutation({
  args: { userId: v.id("users"), lat: v.float64(), lng: v.float64() },
  handler: async (ctx, { userId, lat, lng }) => {
    await ctx.db.patch(userId, { lastLat: lat, lastLng: lng });
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
    return { ...user, reviews: enriched };
  },
});

