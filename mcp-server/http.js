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
 * The server holds no secrets of its own. Each caller brings their own RICO
 * API key, which is passed straight through to the RICO API; without one,
 * only the public read tools work. claude.ai connectors cannot send custom
 * headers, so the key may also be given as ?key= in the connector URL.
 */
export async function handleMcpRequest(req, res, { maxWaitSeconds } = {}) {
  if (req.method !== "POST") {
    return rpcError(res, 405, "Method not allowed. This server is stateless: use POST.", { Allow: "POST" });
  }

  // Browsers send an Origin header; server-side MCP clients do not. Refusing
  // unknown origins stops a web page from driving this endpoint from a
  // visitor's browser (DNS rebinding).
  if (!originAllowed(req.headers.origin)) return rpcError(res, 403, "Origin not allowed");

  let body;
  try {
    body = await readJson(req);
  } catch {
    return send(res, 400, { jsonrpc: "2.0", error: { code: -32700, message: "Parse error" }, id: null });
  }

  const server = createRicoServer({ apiKey: apiKeyFrom(req), maxWaitSeconds });
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
