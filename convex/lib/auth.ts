import { ConvexError } from "convex/values";
import { QueryCtx, MutationCtx } from "../_generated/server";
import { Doc } from "../_generated/dataModel";

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const API_KEY_PREFIX = "rico_";

/** SHA-256 of a token, hex. Tokens are never stored in the clear. */
export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The live token row for a token, or null. Refresh tokens never count as credentials. */
async function tokenRow(ctx: QueryCtx | MutationCtx, token: string | null | undefined) {
  if (!token || token.length < 20 || token.length > 200) return null;
  const tokenHash = await hashToken(token);
  const row = await ctx.db
    .query("authTokens")
    .withIndex("by_hash", (q) => q.eq("tokenHash", tokenHash))
    .unique();
  if (!row || row.kind === "oauthRefresh") return null;
  if (row.expiresAt !== undefined && row.expiresAt < Date.now()) return null;
  return row;
}

/** The user a session token, API key or OAuth access token belongs to, or null. */
export async function userForToken(
  ctx: QueryCtx | MutationCtx,
  token: string | null | undefined,
): Promise<Doc<"users"> | null> {
  const row = await tokenRow(ctx, token);
  return row ? await ctx.db.get(row.userId) : null;
}

/** Like userForToken, but throws when the caller is not signed in. */
export async function requireUser(ctx: QueryCtx | MutationCtx, token: string | null | undefined) {
  const user = await userForToken(ctx, token);
  if (!user) throw new ConvexError("Not signed in: missing, invalid or expired token");
  return user;
}

/**
 * The user behind a wallet-signed web session, or null. API keys and
 * connected apps (OAuth tokens) don't count: account management and
 * withdrawals are for the person holding the wallet, on rico.delivery.
 */
export async function sessionUser(ctx: QueryCtx | MutationCtx, token: string | null | undefined) {
  const row = await tokenRow(ctx, token);
  return row && row.kind === "session" ? await ctx.db.get(row.userId) : null;
}

export async function requireSession(ctx: QueryCtx | MutationCtx, token: string | null | undefined, what: string) {
  const user = await sessionUser(ctx, token);
  if (!user) throw new ConvexError(`${what} needs you to be signed in on rico.delivery with your wallet. API keys and connected apps can't do this.`);
  return user;
}
