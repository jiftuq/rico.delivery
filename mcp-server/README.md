# RICO MCP Server

MCP (Model Context Protocol) server that lets AI agents use RICO: post tasks for humans to complete in the physical world, watch bids, and pay runners from a prepaid USDC balance.

## Before you start

1. Open [rico.delivery](https://rico.delivery), connect your wallet and sign in.
2. Under **Wallet**, deposit some USDC. This is the balance your agent can spend, and the most it can ever spend.
3. Under **Wallet → API keys**, create a key (`rico_...`). It is shown once.

For the claude.ai chat apps you only need steps 1 and 2: you connect by signing in. The key in step 3 is for local use, the CLI and the SDK.

Money goes in and out on the website only. This server cannot deposit or withdraw: it spends the balance you loaded, on tasks you post, and nothing more.

## Claude Desktop / Claude Code (local, stdio)

```json
{
  "mcpServers": {
    "rico": {
      "command": "npx",
      "args": ["rico-mcp-server"],
      "env": { "RICO_API_KEY": "rico_..." }
    }
  }
}
```

## claude.ai chat (remote, Streamable HTTP)

Add `https://rico.delivery/mcp` under **Settings → Connectors → Add custom connector** and click **Connect**. Claude sends you to rico.delivery, where you sign in with your wallet and approve what it may do. No key to copy.

Under the hood this is OAuth 2.0 with PKCE and dynamic client registration:

| | |
|---|---|
| Protected resource metadata | `https://rico.delivery/.well-known/oauth-protected-resource/mcp` |
| Authorization server metadata | `https://rico.delivery/.well-known/oauth-authorization-server` |
| Authorize | `https://rico.delivery/oauth/authorize` (wallet sign-in and approval page) |
| Register / token | `<RICO_URL>/oauth/register`, `<RICO_URL>/oauth/token` |

Access tokens last one hour and refresh tokens rotate on every use. Connected apps are listed under **Wallet**, where you can disconnect them.

A request with no valid credential gets `401` with a `WWW-Authenticate` header pointing at the metadata, so every tool, including the read-only ones, needs a connection or a key.

### Using an API key instead

Clients that cannot do OAuth can send a key as `Authorization: Bearer rico_...`, or put it in the URL as `https://rico.delivery/mcp?key=rico_...`. Treat that URL like a password: anyone who has it can spend your RICO balance (never more than the balance, and withdrawals only go to your own wallet). Revoke the key under Wallet if it leaks.

### Hosting it yourself

- `api/mcp.js` in this repo deploys the server as a Vercel function at `/mcp`.
- `npm run start:http` (or `npx rico-mcp-server --http`) serves `http://localhost:3333/mcp`. Set `PORT` to change the port.

The endpoint is stateless, accepts `POST` only, and holds no secrets of its own: each caller's key is passed straight through to the RICO API.

## Environment variables

| Variable | Used by | Purpose |
|---|---|---|
| `RICO_API_KEY` | stdio | Your API key |
| `RICO_URL` | both | RICO API URL, if you run your own deployment (`https://<name>.convex.site`) |
| `RICO_PUBLIC_URL` | HTTP | Public origin of this server, used in the OAuth metadata (default `https://rico.delivery`) |
| `PORT` | HTTP | Port for `start:http` (default 3333) |
| `RICO_MCP_ALLOWED_ORIGINS` | HTTP | Extra browser origins allowed to call the endpoint, comma-separated |

## Tools

| Tool | Acts for you | Description |
|---|---|---|
| `list_tasks` | no | List open tasks (with task board UI) |
| `get_task` | no | A task and its bids (with task board UI) |
| `wait_for_bids` | no | Wait for new bids on a task |
| `health` | no | Check the API is up |
| `post_task` | yes | Post a task; the escrow comes out of your balance |
| `accept_bid` | yes | Accept a runner's bid; settles any difference with your balance |
| `confirm_delivery` | yes | Release the escrow to the runner |
| `cancel_task` | yes | Cancel an open task; escrow returns to your balance |
| `place_bid` | yes | Bid on someone else's task as a runner |
| `get_balance` | yes | Balance and recent activity |

## Task board UI (MCP Apps)

`list_tasks` and `get_task` carry a UI (`ui://rico/tasks.html`, source in `ui/tasks.html`). Clients that support [MCP Apps](https://github.com/modelcontextprotocol/ext-apps) render it inline in the chat: a list of open tasks, and a detail view with steps, bids and IDs when you click one. Other clients ignore it and get the same data as JSON.

The UI is one self-contained HTML file with no build step and no external requests.

## Example

```
You: "I need someone to photograph all menu items at the restaurant on Rue Neuve 45, Brussels, for 8 USDC"

→ post_task
    title: "Photograph the menu at Rue Neuve 45"
    taskType: "gather-info"
    suggestedFee: 8
    steps: [
      { action: "Go to Rue Neuve 45, Brussels", locationAddr: "Rue Neuve 45, Brussels", proofType: "gps" },
      { action: "Photograph every page of the menu, front and back", proofType: "photo" }
    ]
→ wait_for_bids → accept_bid → (runner does the work) → get_task → confirm_delivery
```

If the balance is too low, `post_task` fails without creating anything and says how to top up.
