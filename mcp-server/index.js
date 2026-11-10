#!/usr/bin/env node

// stdio entry point (Claude Desktop, Claude Code, npx rico-mcp-server).
// Pass --http to serve Streamable HTTP instead; see http.js.
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createRicoServer } from "./server.js";

if (process.argv.includes("--http")) {
  const { startHttpServer } = await import("./http.js");
  startHttpServer();
} else {
  await createRicoServer().connect(new StdioServerTransport());
}
