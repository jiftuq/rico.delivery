# Publishing Checklist for RICO

## 1. Publish Python SDK to PyPI

```bash
cd sdk-python

# First time: create account at https://pypi.org/account/register/
# Then create API token at https://pypi.org/manage/account/token/

# Upload
twine upload dist/*
# Enter: __token__ as username, paste your API token as password
```

After publishing, anyone can:
```bash
pip install langchain-rico
```

## 2. Publish MCP Server to npm

```bash
cd mcp-server

# Login (one time)
npm login
# Follow browser auth flow

# Publish
npm publish
```

After publishing, Claude users add to config:
```json
{
  "mcpServers": {
    "rico": {
      "command": "npx",
      "args": ["rico-mcp-server"],
      "env": {
        "RICO_API_KEY": "rico_..."
      }
    }
  }
}
```

## 3. Submit to Smithery.ai

1. Go to https://smithery.ai/submit
2. Enter GitHub repo: https://github.com/jiftuq/dropzone
3. Point to: `mcp-server/` directory
4. The `smithery.yaml` is already configured

## 4. Submit to mcp.so

1. Go to https://mcp.so/submit
2. Fill in:
   - Name: RICO
   - Description: Post tasks for humans in the physical world. AI agents hire people for deliveries, moving, info gathering, verification, negotiations. Pay USDC on Base.
   - Repo: https://github.com/jiftuq/dropzone/tree/main/mcp-server
   - Install: `npx rico-mcp-server`

## 5. PR to modelcontextprotocol/servers

Fork https://github.com/modelcontextprotocol/servers, add to community servers README:

```markdown
### RICO
Post tasks for humans in the physical world — deliveries, moving, info gathering, verification, negotiations, physical actions. AI agents pay runners from a prepaid USDC balance on Base.
- [GitHub](https://github.com/jiftuq/dropzone/tree/main/mcp-server)
- `npx rico-mcp-server`
```

## 6. Post in CDP Discord

```
🚀 RICO — Let your AgentKit agent hire humans in the physical world

Built a LangChain toolkit + MCP server that gives AI agents the power to post tasks for real humans:

🚚 Move furniture (multi-runner delivery)
📸 Photograph menus, price tags, storefronts
🔍 Verify someone lives at an address
🤝 Negotiate with vendors
💪 Physical actions (flip switches, hang posters)
📊 Count cars, people, gather ground-truth data
🎉 Organize flash mobs (50+ runners)

Payment: a prepaid USDC balance on Base, spent with an API key. The agent can never spend more than the balance.

Works with:
• Coinbase AgentKit (pip install langchain-rico[agentkit])
• Any LangChain agent (pip install langchain-rico)
• Claude Desktop/Code (npx rico-mcp-server)
• Raw HTTP (POST /task + X-Payment header)

GitHub: https://github.com/jiftuq/dropzone
Live: https://rico.delivery

Your agent can transfer tokens all day, but it can't pick up a couch. We fix that.
```

## 7. Post on X / Twitter

```
🤖→🏃 RICO: AI agents hire humans in the real world

Your agent needs furniture moved? A menu photographed? Someone verified at an address?

Post a task → humans bid → proof submitted → USDC released on Base

Works with @CoinbaseDev AgentKit, LangChain, Claude MCP

pip install langchain-rico
npx rico-mcp-server

Agents do the thinking. Humans do the doing.

https://rico.delivery
```

## 8. Post on Farcaster / Warpcast

```
Shipped RICO — agentic commerce on Base

AI agents post tasks for humans, paid from a prepaid USDC balance:
• Deliveries & moving
• Info gathering (photo proof)
• Verification (KYC)
• Physical actions
• Flash mobs (multi-runner)

LangChain toolkit + MCP server + Python SDK

Your agent can swap tokens but can't move a couch. Until now.

github.com/jiftuq/dropzone
```
