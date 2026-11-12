import { action, httpAction, internalMutation, internalQuery, query } from "./_generated/server";
import { internal } from "./_generated/api";
import { ConvexError, v } from "convex/values";
import { hashToken, userForToken } from "./lib/auth";

// A small OAuth 2.0 authorization server, so MCP clients such as Claude can
// connect a RICO account with a "Connect" button instead of a pasted key.
//
//   register  (RFC 7591)  POST /oauth/register      -> client_id (public clients, no secret)
//   authorize             https://rico.delivery/oauth/authorize: the user signs in with
//                         their wallet and approves; approveAuthorization returns a code
//   token                 POST /oauth/token          -> access token (1 h) + refresh token
//
// PKCE (S256) is required. Refresh tokens rotate on every use. Access tokens
// are ordinary rows in authTokens, so every function that takes an API key
// takes them too, and revoking a connection deletes them.

const ACCESS_TTL_S = 60 * 60;
const REFRESH_TTL_MS = 60 * 24 * 60 * 60 * 1000;
const CODE_TTL_MS = 5 * 60 * 1000;
const MAX_REDIRECT_URIS = 10;

const randomToken = (bytes = 32) =>
  Array.from(crypto.getRandomValues(new Uint8Array(bytes))).map((b) => b.toString(16).padStart(2, "0")).join("");

function base64url(bytes: ArrayBuffer) {
  let s = "";
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** https anywhere; plain http only on this machine (native apps like Claude Code). */
function validRedirectUri(uri: string) {
  try {
    const u = new URL(uri);
    if (u.hash) return false;
    if (u.protocol === "https:") return true;
    return u.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
  } catch {
    return false;
  }
}

/** Exact match, except that loopback redirects may use any port (RFC 8252 §7.3). */
export function redirectAllowed(registered: string[], uri: string) {
  if (registered.includes(uri)) return true;
  try {
    const u = new URL(uri);
    if (u.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(u.hostname)) return false;
    return registered.some((r) => {
      const ru = new URL(r);
      return ru.protocol === u.protocol && ru.hostname === u.hostname && ru.pathname === u.pathname;
    });
  } catch {
    return false;
  }
}

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...cors },
  });
const oauthError = (error: string, description: string, status = 400) =>
  json({ error, error_description: description }, status);

export const preflight = httpAction(async () => new Response(null, { status: 204, headers: cors }));

// ── Registration ──

export const register = httpAction(async (ctx, request) => {
  let body: any;
  try { body = await request.json(); } catch { return oauthError("invalid_client_metadata", "Body must be JSON"); }
  const uris = body?.redirect_uris;
  if (!Array.isArray(uris) || uris.length === 0 || uris.length > MAX_REDIRECT_URIS) {
    return oauthError("invalid_redirect_uri", `redirect_uris must list 1-${MAX_REDIRECT_URIS} URIs`);
  }
  if (!uris.every((u) => typeof u === "string" && validRedirectUri(u))) {
    return oauthError("invalid_redirect_uri", "Redirect URIs must be https, or http on localhost");
  }
  // Every client is registered as public (PKCE, no secret), whatever it asked
  // for; RFC 7591 lets the server decide, and the response says "none".
  const clientName = String(body.client_name || "An MCP client").slice(0, 80);
  const clientId = "rico_client_" + randomToken(16);
  const now = Date.now();
  await ctx.runMutation(internal.oauth.storeClient, { clientId, clientName, redirectUris: uris });
  return json({
    client_id: clientId,
    client_id_issued_at: Math.floor(now / 1000),
    client_name: clientName,
    redirect_uris: uris,
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
  }, 201);
});

export const storeClient = internalMutation({
  args: { clientId: v.string(), clientName: v.string(), redirectUris: v.array(v.string()) },
  handler: async (ctx, args) => { await ctx.db.insert("oauthClients", { ...args, createdAt: Date.now() }); },
});

// ── Authorization (called by the consent page on rico.delivery) ──

/** What the consent page shows, and whether the request is valid at all. */
export const describeClient = query({
  args: { clientId: v.string(), redirectUri: v.string() },
  handler: async (ctx, { clientId, redirectUri }) => {
    const client = await ctx.db.query("oauthClients").withIndex("by_client_id", (q) => q.eq("clientId", clientId)).unique();
    if (!client) return { ok: false as const, reason: "Unknown application. Start the connection again from the app." };
    // Never redirect anywhere the client did not register: that would leak the code.
    if (!redirectAllowed(client.redirectUris, redirectUri)) return { ok: false as const, reason: "This app asked to return to an address it did not register." };
    return { ok: true as const, clientName: client.clientName, redirectHost: new URL(redirectUri).host };
  },
});

export const approveAuthorization = action({
  args: {
    token: v.string(), // wallet-signed web session
    clientId: v.string(),
    redirectUri: v.string(),
    codeChallenge: v.string(),
    codeChallengeMethod: v.string(),
    scope: v.optional(v.string()),
    resource: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<{ code: string }> => {
    if (args.codeChallengeMethod !== "S256") throw new ConvexError("PKCE with S256 is required");
    if (!/^[A-Za-z0-9_-]{43,128}$/.test(args.codeChallenge)) throw new ConvexError("Invalid code_challenge");
    const code = randomToken(32);
    await ctx.runMutation(internal.oauth.storeCode, { ...args, codeHash: await hashToken(code) });
    return { code };
  },
});

export const storeCode = internalMutation({
  args: {
    token: v.string(), clientId: v.string(), redirectUri: v.string(), codeChallenge: v.string(),
    codeChallengeMethod: v.string(), scope: v.optional(v.string()), resource: v.optional(v.string()), codeHash: v.string(),
  },
  handler: async (ctx, a) => {
    // Only a wallet-signed session can approve an app, never an API key or another app's token.
    const sessionHash = await hashToken(a.token);
    const session = await ctx.db.query("authTokens").withIndex("by_hash", (q) => q.eq("tokenHash", sessionHash)).unique();
    if (!session || session.kind !== "session" || (session.expiresAt ?? 0) < Date.now()) {
      throw new ConvexError("Sign in with your wallet to approve this connection");
    }
    const client = await ctx.db.query("oauthClients").withIndex("by_client_id", (q) => q.eq("clientId", a.clientId)).unique();
    if (!client || !redirectAllowed(client.redirectUris, a.redirectUri)) throw new ConvexError("Invalid client or redirect");
    await ctx.db.insert("oauthCodes", {
      codeHash: a.codeHash, clientId: a.clientId, userId: session.userId, redirectUri: a.redirectUri,
      codeChallenge: a.codeChallenge, scope: a.scope, resource: a.resource, expiresAt: Date.now() + CODE_TTL_MS,
    });
  },
});

// ── Token endpoint ──

export const token = httpAction(async (ctx, request) => {
  const type = request.headers.get("Content-Type") || "";
  let params: URLSearchParams;
  try {
    params = type.includes("application/json")
      ? new URLSearchParams(Object.entries(await request.json()).map(([k, val]) => [k, String(val)]))
      : new URLSearchParams(await request.text());
  } catch {
    return oauthError("invalid_request", "Unreadable body");
  }
  const grant = params.get("grant_type");
  // Clients that think they hold a secret send client_id in HTTP Basic auth.
  // There is no secret to check (public clients), but the client_id still counts.
  let clientId = params.get("client_id") || "";
  const basic = /^Basic\s+(.+)$/i.exec(request.headers.get("Authorization") || "");
  if (!clientId && basic) {
    try { clientId = decodeURIComponent(atob(basic[1]).split(":")[0]); } catch { /* ignore */ }
  }

  if (grant === "authorization_code") {
    const code = params.get("code"), verifier = params.get("code_verifier"), redirectUri = params.get("redirect_uri");
    if (!code || !verifier || !redirectUri || !clientId) {
      return oauthError("invalid_request", "code, code_verifier, redirect_uri and client_id are required");
    }
    if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) return oauthError("invalid_grant", "Invalid code_verifier");
    const challenge = base64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
    const access = randomToken(32), refresh = randomToken(32);
    const result = await ctx.runMutation(internal.oauth.redeemCode, {
      codeHash: await hashToken(code), clientId, redirectUri, challenge,
      accessHash: await hashToken(access), refreshHash: await hashToken(refresh),
    });
    if (!result.ok) return oauthError("invalid_grant", result.reason);
    return json({ access_token: access, token_type: "Bearer", expires_in: ACCESS_TTL_S, refresh_token: refresh, scope: result.scope ?? "rico" });
  }

  if (grant === "refresh_token") {
    const refreshToken = params.get("refresh_token");
    if (!refreshToken) return oauthError("invalid_request", "refresh_token is required");
    const access = randomToken(32), refresh = randomToken(32);
    const result = await ctx.runMutation(internal.oauth.rotateRefresh, {
      refreshHash: await hashToken(refreshToken), clientId,
      newAccessHash: await hashToken(access), newRefreshHash: await hashToken(refresh),
    });
    if (!result.ok) return oauthError("invalid_grant", result.reason);
    return json({ access_token: access, token_type: "Bearer", expires_in: ACCESS_TTL_S, refresh_token: refresh, scope: "rico" });
  }

  return oauthError("unsupported_grant_type", "Use authorization_code or refresh_token");
});

export const redeemCode = internalMutation({
  args: { codeHash: v.string(), clientId: v.string(), redirectUri: v.string(), challenge: v.string(), accessHash: v.string(), refreshHash: v.string() },
  handler: async (ctx, a) => {
    const row = await ctx.db.query("oauthCodes").withIndex("by_hash", (q) => q.eq("codeHash", a.codeHash)).unique();
    if (!row) return { ok: false as const, reason: "Unknown or already used code" };
    await ctx.db.delete(row._id); // single use, even when the checks below fail
    if (row.expiresAt < Date.now()) return { ok: false as const, reason: "Code expired" };
    if (row.clientId !== a.clientId) return { ok: false as const, reason: "Code was issued to another client" };
    if (row.redirectUri !== a.redirectUri) return { ok: false as const, reason: "redirect_uri does not match" };
    if (row.codeChallenge !== a.challenge) return { ok: false as const, reason: "PKCE verification failed" };
    await issue(ctx, row.userId, row.clientId, a.accessHash, a.refreshHash);
    return { ok: true as const, scope: row.scope };
  },
});

export const rotateRefresh = internalMutation({
  args: { refreshHash: v.string(), clientId: v.string(), newAccessHash: v.string(), newRefreshHash: v.string() },
  handler: async (ctx, a) => {
    const row = await ctx.db.query("authTokens").withIndex("by_hash", (q) => q.eq("tokenHash", a.refreshHash)).unique();
    if (!row || row.kind !== "oauthRefresh") return { ok: false as const, reason: "Unknown refresh token" };
    if ((row.expiresAt ?? 0) < Date.now()) { await ctx.db.delete(row._id); return { ok: false as const, reason: "Refresh token expired" }; }
    if (a.clientId && row.clientId !== a.clientId) return { ok: false as const, reason: "Refresh token was issued to another client" };
    await ctx.db.delete(row._id); // rotation: the old refresh token stops working now
    await issue(ctx, row.userId, row.clientId!, a.newAccessHash, a.newRefreshHash);
    return { ok: true as const };
  },
});

async function issue(ctx: any, userId: any, clientId: string, accessHash: string, refreshHash: string) {
  const now = Date.now();
  const client = await ctx.db.query("oauthClients").withIndex("by_client_id", (q: any) => q.eq("clientId", clientId)).unique();
  const label = client?.clientName ?? "Connected app";
  await ctx.db.insert("authTokens", { userId, tokenHash: accessHash, kind: "oauthAccess", clientId, label, createdAt: now, expiresAt: now + ACCESS_TTL_S * 1000 });
  await ctx.db.insert("authTokens", { userId, tokenHash: refreshHash, kind: "oauthRefresh", clientId, label, createdAt: now, expiresAt: now + REFRESH_TTL_MS });
}

// ── Connected apps, for the Wallet screen ──

export const listConnections = query({
  args: { token: v.optional(v.string()) },
  handler: async (ctx, { token }) => {
    const user = await userForToken(ctx, token);
    if (!user) return [];
    const rows = await ctx.db.query("authTokens").withIndex("by_user", (q) => q.eq("userId", user._id)).collect();
    const byClient = new Map<string, { clientId: string; label: string; since: number }>();
    for (const r of rows) {
      if (r.kind !== "oauthRefresh" || !r.clientId) continue;
      const prev = byClient.get(r.clientId);
      if (!prev || r.createdAt < prev.since) byClient.set(r.clientId, { clientId: r.clientId, label: r.label ?? "Connected app", since: r.createdAt });
    }
    return [...byClient.values()];
  },
});

export const disconnect = internalMutation({
  args: { userId: v.id("users"), clientId: v.string() },
  handler: async (ctx, { userId, clientId }) => {
    const rows = await ctx.db.query("authTokens").withIndex("by_user", (q) => q.eq("userId", userId)).collect();
    for (const r of rows) if (r.clientId === clientId) await ctx.db.delete(r._id);
  },
});

export const disconnectApp = action({
  args: { token: v.string(), clientId: v.string() },
  handler: async (ctx, { token, clientId }) => {
    const user = await ctx.runQuery(internal.oauth.sessionUser, { token });
    if (!user) throw new ConvexError("Not signed in: missing, invalid or expired token");
    await ctx.runMutation(internal.oauth.disconnect, { userId: user._id, clientId });
  },
});

export const sessionUser = internalQuery({
  args: { token: v.string() },
  handler: async (ctx, { token }) => userForToken(ctx, token),
});

/** Cron: drop expired codes. */
export const purgeCodes = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    for (const c of await ctx.db.query("oauthCodes").take(500)) if (c.expiresAt < now) await ctx.db.delete(c._id);
  },
});
