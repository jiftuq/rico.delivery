import { action, internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { internal } from "./_generated/api";
import { ConvexError, v } from "convex/values";
import { createPublicClient, getAddress, http, isAddress } from "viem";
import { base } from "viem/chains";
import { API_KEY_PREFIX, SESSION_TTL_MS, hashToken, requireUser, userForToken } from "./lib/auth";
import { fromMicro } from "./lib/money";

// Sign-in works by proving control of a wallet: the app asks for a one-time
// message (startSignIn), the wallet signs it, and finishSignIn checks the
// signature and hands back a session token. Every other function that acts
// for a user takes that token (or an API key made from it) instead of a
// user ID, so nobody can act as someone else by knowing their ID.

const CHALLENGE_TTL_MS = 10 * 60 * 1000;
const MAX_API_KEYS = 5;
const DEFAULT_ORIGIN = "https://rico.delivery";

function randomHex(bytes: number): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Origins allowed to appear in the sign-in message the wallet shows. */
function signInOrigin(requested?: string): URL {
  const allowed = [DEFAULT_ORIGIN, process.env.FRONTEND_URL].filter(Boolean) as string[];
  try {
    const url = new URL(requested ?? "");
    const isLocal = url.hostname === "localhost" || url.hostname === "127.0.0.1";
    if (isLocal || allowed.some((a) => new URL(a).origin === url.origin)) return url;
  } catch { /* fall through to the default */ }
  return new URL(process.env.FRONTEND_URL || DEFAULT_ORIGIN);
}

export const startSignIn = action({
  args: { walletAddress: v.string(), origin: v.optional(v.string()) },
  handler: async (ctx, { walletAddress, origin }): Promise<{ nonce: string; message: string }> => {
    if (!isAddress(walletAddress, { strict: false })) throw new ConvexError("Invalid wallet address");
    const address = getAddress(walletAddress);
    const site = signInOrigin(origin);
    const nonce = randomHex(16);
    const now = Date.now();
    const expiresAt = now + CHALLENGE_TTL_MS;
    // EIP-4361 (Sign-In with Ethereum), so wallets can show what is being signed
    // and warn when the site asking does not match the domain in the message.
    const message = [
      `${site.host} wants you to sign in with your Ethereum account:`,
      address,
      "",
      "Sign in to RICO. This does not send a transaction or cost gas.",
      "",
      `URI: ${site.origin}`,
      "Version: 1",
      "Chain ID: 8453",
      `Nonce: ${nonce}`,
      `Issued At: ${new Date(now).toISOString()}`,
      `Expiration Time: ${new Date(expiresAt).toISOString()}`,
    ].join("\n");
    await ctx.runMutation(internal.auth.storeChallenge, { nonce, walletAddress: address, message, expiresAt });
    return { nonce, message };
  },
});

export const finishSignIn = action({
  args: { nonce: v.string(), signature: v.string() },
  handler: async (ctx, { nonce, signature }): Promise<{ token: string; userId: string; walletAddress: string; expiresAt: number }> => {
    const challenge = await ctx.runQuery(internal.auth.getChallenge, { nonce });
    if (!challenge || challenge.expiresAt < Date.now()) throw new ConvexError("Sign-in request expired. Try again.");
    if (!/^0x[0-9a-fA-F]+$/.test(signature)) throw new ConvexError("Invalid signature");

    // verifyMessage handles plain wallets locally and smart-contract wallets
    // (ERC-1271 / ERC-6492, e.g. Coinbase Smart Wallet) with a call to Base.
    const client = createPublicClient({ chain: base, transport: http(process.env.BASE_RPC_URL) });
    const valid = await client.verifyMessage({
      address: challenge.walletAddress as `0x${string}`,
      message: challenge.message,
      signature: signature as `0x${string}`,
    });
    if (!valid) throw new ConvexError("Signature does not match this wallet");

    const token = randomHex(32);
    const expiresAt = Date.now() + SESSION_TTL_MS;
    const userId = await ctx.runMutation(internal.auth.completeSignIn, {
      nonce, tokenHash: await hashToken(token), expiresAt,
    });
    return { token, userId, walletAddress: challenge.walletAddress, expiresAt };
  },
});

/** The signed-in user, or null when the token is missing, invalid or expired. */
export const me = query({
  args: { token: v.optional(v.string()) },
  handler: async (ctx, { token }) => {
    const user = await userForToken(ctx, token);
    if (!user) return null;
    return { ...user, balance: fromMicro(user.balanceMicro ?? 0) };
  },
});

export const signOut = mutation({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const tokenHash = await hashToken(token);
    const row = await ctx.db.query("authTokens").withIndex("by_hash", (q) => q.eq("tokenHash", tokenHash)).unique();
    if (row && row.kind === "session") await ctx.db.delete(row._id);
  },
});

// ── API keys: long-lived tokens for agents, the CLI and the MCP server ──

export const createApiKey = action({
  args: { token: v.string(), label: v.optional(v.string()) },
  handler: async (ctx, { token, label }): Promise<{ key: string }> => {
    const key = API_KEY_PREFIX + randomHex(24);
    await ctx.runMutation(internal.auth.storeApiKey, {
      sessionToken: token, tokenHash: await hashToken(key), hint: key.slice(-4),
      label: (label || "API key").slice(0, 60),
    });
    return { key }; // shown once; only its hash is kept
  },
});

export const listApiKeys = query({
  args: { token: v.optional(v.string()) },
  handler: async (ctx, { token }) => {
    const user = await userForToken(ctx, token);
    if (!user) return [];
    const rows = await ctx.db.query("authTokens").withIndex("by_user", (q) => q.eq("userId", user._id)).collect();
    return rows
      .filter((r) => r.kind === "apiKey")
      .map((r) => ({ _id: r._id, label: r.label, hint: r.hint, createdAt: r.createdAt }));
  },
});

export const revokeApiKey = mutation({
  args: { token: v.string(), keyId: v.id("authTokens") },
  handler: async (ctx, { token, keyId }) => {
    const user = await requireUser(ctx, token);
    const row = await ctx.db.get(keyId);
    if (!row || row.userId !== user._id || row.kind !== "apiKey") throw new ConvexError("Key not found");
    await ctx.db.delete(keyId);
  },
});

// ── Internal ──

export const storeChallenge = internalMutation({
  args: { nonce: v.string(), walletAddress: v.string(), message: v.string(), expiresAt: v.number() },
  handler: async (ctx, args) => { await ctx.db.insert("authChallenges", args); },
});

export const getChallenge = internalQuery({
  args: { nonce: v.string() },
  handler: async (ctx, { nonce }) =>
    ctx.db.query("authChallenges").withIndex("by_nonce", (q) => q.eq("nonce", nonce)).unique(),
});

export const completeSignIn = internalMutation({
  args: { nonce: v.string(), tokenHash: v.string(), expiresAt: v.number() },
  handler: async (ctx, { nonce, tokenHash, expiresAt }) => {
    // Deleting the challenge here is what makes a signature single-use.
    const challenge = await ctx.db.query("authChallenges").withIndex("by_nonce", (q) => q.eq("nonce", nonce)).unique();
    if (!challenge) throw new ConvexError("Sign-in request already used. Try again.");
    await ctx.db.delete(challenge._id);

    // Accounts created before sign-in existed may hold the address in any case.
    const address = challenge.walletAddress;
    let user = null;
    for (const candidate of [address, address.toLowerCase()]) {
      user = await ctx.db.query("users").withIndex("by_wallet", (q) => q.eq("walletAddress", candidate)).first();
      if (user) break;
    }
    const userId = user?._id ?? await ctx.db.insert("users", {
      walletAddress: address,
      displayName: address.slice(0, 6) + "..." + address.slice(-4),
      balance: 0, balanceMicro: 0, score: 5.0,
      totalRatings: 0, ratingSum: 0, deliveries: 0, tasksPosted: 0, createdAt: Date.now(),
    });
    await ctx.db.insert("authTokens", { userId, tokenHash, kind: "session", createdAt: Date.now(), expiresAt });
    return userId;
  },
});

export const storeApiKey = internalMutation({
  args: { sessionToken: v.string(), tokenHash: v.string(), hint: v.string(), label: v.string() },
  handler: async (ctx, { sessionToken, tokenHash, hint, label }) => {
    // Only a wallet-signed session can mint keys; a leaked key cannot mint more.
    const sessionHash = await hashToken(sessionToken);
    const session = await ctx.db.query("authTokens").withIndex("by_hash", (q) => q.eq("tokenHash", sessionHash)).unique();
    if (!session || session.kind !== "session" || (session.expiresAt ?? 0) < Date.now()) {
      throw new ConvexError("Sign in with your wallet to create an API key");
    }
    const existing = await ctx.db.query("authTokens").withIndex("by_user", (q) => q.eq("userId", session.userId)).collect();
    if (existing.filter((r) => r.kind === "apiKey").length >= MAX_API_KEYS) {
      throw new ConvexError(`You can have at most ${MAX_API_KEYS} API keys. Revoke one first.`);
    }
    await ctx.db.insert("authTokens", { userId: session.userId, tokenHash, kind: "apiKey", label, hint, createdAt: Date.now() });
  },
});

/** Cron: drop expired sign-in requests and sessions. */
export const purgeExpired = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    for (const c of await ctx.db.query("authChallenges").take(500)) {
      if (c.expiresAt < now) await ctx.db.delete(c._id);
    }
    for (const t of await ctx.db.query("authTokens").take(1000)) {
      if (t.expiresAt !== undefined && t.expiresAt < now) await ctx.db.delete(t._id);
    }
  },
});
