// Vercel function: the RICO MCP server over Streamable HTTP.
// Reachable at https://rico.delivery/mcp (see the rewrite in vercel.json).
import { handleMcpRequest } from "../mcp-server/http.js";

// Stay inside the function's maxDuration (vercel.json) when waiting for bids.
export default (req, res) => handleMcpRequest(req, res, { maxWaitSeconds: 50 });
