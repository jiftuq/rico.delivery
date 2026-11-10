#!/usr/bin/env node

// Streamable HTTP transport, for remote clients such as claude.ai connectors.
// Stateless: every request gets a fresh server, so it runs unchanged as a
// long-lived process (node http.js) or as a serverless function (api/mcp.js).
import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
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

function tokenMatches(header, token) {
  const given = Buffer.from(header || "");
  const expected = Buffer.from(`Bearer ${token}`);
  return given.length === expected.length && timingSafeEqual(given, expected);
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
 * The wallet is only ever used when RICO_MCP_TOKEN is set and the caller sends
 * it as a bearer token. Without a token the endpoint is open, and an open
 * endpoint must not be able to spend RICO_PRIVATE_KEY.
 */
export async function handleMcpRequest(req, res, { maxWaitSeconds } = {}) {
  if (req.method !== "POST") {
    return rpcError(res, 405, "Method not allowed. This server is stateless: use POST.", { Allow: "POST" });
  }

  const token = process.env.RICO_MCP_TOKEN;
  if (token && !tokenMatches(req.headers.authorization, token)) {
    return rpcError(res, 401, "Unauthorized", { "WWW-Authenticate": "Bearer" });
  }

  let body;
  try {
    body = await readJson(req);
  } catch {
    return send(res, 400, { jsonrpc: "2.0", error: { code: -32700, message: "Parse error" }, id: null });
  }

  const server = createRicoServer({ allowWallet: Boolean(token), maxWaitSeconds });
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
    const wallet = process.env.RICO_MCP_TOKEN && process.env.RICO_PRIVATE_KEY ? "enabled" : "disabled";
    console.error(`RICO MCP server on http://localhost:${port}/mcp (wallet ${wallet})`);
  });
  return httpServer;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startHttpServer();
}
