# Connector directory listing

Material for submitting the RICO connector to the Claude connector directory.

## Screenshots

PNG, 2000px wide, cropped to the task-board app. They show the real UI
(`mcp-server/ui/tasks.html`) rendered by the MCP Apps host bridge, with
sample tasks rather than live data, since production has almost none yet.

| File | Prompt |
|---|---|
| `1-open-tasks-light.png` | Show me the open RICO tasks |
| `2-task-with-bids-light.png` | Show me the menu photo task at Chez Léon and its bids |
| `3-two-runner-move-dark.png` | How is my couch move going? Show me the task |
| `4-open-tasks-dark.png` | What tasks are open on RICO right now? |

## Listing details

- **Server URL:** `https://rico.delivery/mcp`
- **Authentication:** OAuth 2.0 with dynamic client registration and PKCE.
  Users sign in with their wallet on rico.delivery and approve.
- **Privacy policy:** https://rico.delivery/privacy
- **Documentation:** https://github.com/jiftuq/rico.delivery/blob/main/mcp-server/README.md
- **Icon:** `public/logo.png` (512×512)
