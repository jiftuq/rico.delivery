# Connector directory listing

Material for submitting the RICO connector to the Claude connector directory.

## Screenshots

PNG, 2000px wide, cropped to the task-board app. The files live in `public/listing/` so the site serves them at the URLs below. They show the real UI
(`mcp-server/ui/tasks.html`) rendered by the MCP Apps host bridge, with
sample tasks rather than live data, since production has almost none yet.

| Image URL | Prompt |
|---|---|
| https://rico.delivery/listing/1-open-tasks-light.png | Show me the open RICO tasks |
| https://rico.delivery/listing/2-task-with-bids-light.png | Show me the menu photo task at Chez Léon and its bids |
| https://rico.delivery/listing/3-two-runner-move-dark.png | How is my couch move going? Show me the task |
| https://rico.delivery/listing/4-open-tasks-dark.png | What tasks are open on RICO right now? |
| https://rico.delivery/listing/5-live-bid-board-light.png | Show me the bids on my menu photo task |
| https://rico.delivery/listing/6-live-bid-board-dark.png | Which bid should I accept for the menu photos? |

## Listing details

- **Server URL:** `https://rico.delivery/mcp`
- **Authentication:** OAuth 2.0 with dynamic client registration and PKCE.
  Users sign in with their wallet on rico.delivery and approve.
- **Privacy policy:** https://rico.delivery/privacy
- **Documentation:** https://github.com/jiftuq/rico.delivery/blob/main/mcp-server/README.md
- **Icon:** https://rico.delivery/logo.png (512×512)
