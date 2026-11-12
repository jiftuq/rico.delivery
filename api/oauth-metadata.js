// Vercel function: OAuth discovery documents for the RICO MCP endpoint.
// Reached through the /.well-known/oauth-* rewrites in vercel.json.
import { handleOAuthMetadata } from "../mcp-server/http.js";

export default (req, res) => handleOAuthMetadata(req, res);
