#!/usr/bin/env node

// Streamable HTTP transport, for remote clients such as claude.ai connectors.
// Stateless: every request gets a fresh server, so it runs unchanged as a
// long-lived process (node http.js) or as a serverless function (api/mcp.js).
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createRicoServer } from "./server.js";

function send(res, status, body, headers = {}) {
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

function rpcError(res, status, message, headers) {
  send(res, status, { jsonrpc: "2.0", error: { code: -32000, message }, id: null }, headers);
}

const ALLOWED_ORIGINS = ["https://claude.ai", "https://claude.com", "https://rico.delivery",
  ...(process.env.RICO_MCP_ALLOWED_ORIGINS || "").split(",").map((o) => o.trim()).filter(Boolean)];

function originAllowed(origin) {
  if (!origin) return true;
  try {
    const { hostname } = new URL(origin);
    return hostname === "localhost" || hostname === "127.0.0.1" || ALLOWED_ORIGINS.includes(origin);
  } catch {
    return false;
  }
}

// ── OAuth discovery ──
// The MCP endpoint is a protected resource; RICO's backend is the
// authorization server. These documents tell a client where to send the user
// to sign in and where to exchange the result for a token.
const API_URL = (process.env.RICO_URL || "https://cool-rooster-544.convex.site").replace(/\/$/, "");
const PUBLIC_URL = (process.env.RICO_PUBLIC_URL || "https://rico.delivery").replace(/\/$/, "");
const RESOURCE = `${PUBLIC_URL}/mcp`;
const RESOURCE_METADATA_URL = `${PUBLIC_URL}/.well-known/oauth-protected-resource/mcp`;

const METADATA = {
  "oauth-protected-resource": {
    resource: RESOURCE,
    authorization_servers: [PUBLIC_URL],
    bearer_methods_supported: ["header"],
    scopes_supported: ["rico"],
    resource_name: "RICO",
  },
  "oauth-authorization-server": {
    issuer: PUBLIC_URL,
    authorization_endpoint: `${PUBLIC_URL}/oauth/authorize`,
    token_endpoint: `${API_URL}/oauth/token`,
    registration_endpoint: `${API_URL}/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: ["rico"],
  },
};

/** Serve /.well-known/oauth-protected-resource[/mcp] and /.well-known/oauth-authorization-server. */
export function handleOAuthMetadata(req, res) {
  const { pathname } = new URL(req.url, "http://localhost");
  const doc = Object.keys(METADATA).find((name) => pathname.includes(`/.well-known/${name}`));
  if (!doc) return send(res, 404, { error: "Not found" });
  send(res, 200, METADATA[doc], { "Access-Control-Allow-Origin": "*", "Cache-Control": "public, max-age=300" });
}

/** 401 that tells the client how to sign in (RFC 9728). */
function unauthorized(res, description) {
  rpcError(res, 401, description, {
    "WWW-Authenticate": `Bearer resource_metadata="${RESOURCE_METADATA_URL}", error="invalid_token", error_description="${description}"`,
  });
}

/** Is this key or OAuth token currently valid? Lets the client refresh on a real 401. */
async function credentialValid(apiKey) {
  try {
    const r = await fetch(`${API_URL}/me`, { headers: { Authorization: `Bearer ${apiKey}` } });
    return r.status !== 401;
  } catch {
    return true; // API unreachable: let the tool call report it
  }
}

/** The caller's RICO API key: an Authorization header, or ?key= in the URL. */
function apiKeyFrom(req) {
  const header = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization || "");
  if (header) return header[1];
  return new URL(req.url, "http://localhost").searchParams.get("key") || undefined;
}

async function readJson(req) {
  if (req.body !== undefined) return req.body; // already parsed (Vercel, Express)
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "null");
}

/**
 * Handle one MCP request on a Node (req, res) pair.
 *
 * The server holds no secrets of its own. Each caller brings a credential,
 * which is passed straight through to the RICO API:
 *   - an OAuth access token (Authorization: Bearer ...), obtained by clicking
 *     "Connect" in Claude and approving on rico.delivery, or
 *   - a RICO API key, as a Bearer header or ?key= in the URL.
 * A request without a valid credential gets a 401 that points at the OAuth
 * metadata, which is what makes clients offer to connect.
 */
export async function handleMcpRequest(req, res, { maxWaitSeconds } = {}) {
  // Browsers send an Origin header; server-side MCP clients do not. Refusing
  // unknown origins stops a web page from driving this endpoint from a
  // visitor's browser (DNS rebinding).
  if (!originAllowed(req.headers.origin)) return rpcError(res, 403, "Origin not allowed");

  // Check the credential before anything else, whatever the method, so a
  // client probing the endpoint always learns that it should sign in.
  const apiKey = apiKeyFrom(req);
  if (!apiKey) return unauthorized(res, "Sign in to RICO to use this server");
  if (!(await credentialValid(apiKey))) return unauthorized(res, "The access token is invalid or has expired");

  if (req.method !== "POST") {
    return rpcError(res, 405, "Method not allowed. This server is stateless: use POST.", { Allow: "POST" });
  }

  let body;
  try {
    body = await readJson(req);
  } catch {
    return send(res, 400, { jsonrpc: "2.0", error: { code: -32700, message: "Parse error" }, id: null });
  }

  const server = createRicoServer({ apiKey, maxWaitSeconds });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on("close", () => {
    transport.close();
    server.close();
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  } catch (e) {
    console.error("MCP request failed:", e);
    if (!res.headersSent) rpcError(res, 500, "Internal server error");
  }
}

export function startHttpServer({ port = Number(process.env.PORT) || 3333 } = {}) {
  const httpServer = createServer((req, res) => {
    const { pathname } = new URL(req.url, "http://localhost");
    if (pathname === "/mcp") return handleMcpRequest(req, res);
    if (pathname.startsWith("/.well-known/oauth-")) return handleOAuthMetadata(req, res);
    if (pathname === "/health") return send(res, 200, { ok: true });
    send(res, 404, { error: "Not found. The MCP endpoint is /mcp." });
  });
  httpServer.listen(port, () => {
    console.error(`RICO MCP server on http://localhost:${port}/mcp`);
  });
  return httpServer;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startHttpServer();
}
