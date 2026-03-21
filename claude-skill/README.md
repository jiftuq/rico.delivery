# GIGS.MOM Claude Skill

**Agent Workflows for the Real World**

A Claude Code skill that lets you post workflow-based tasks for humans in the physical world via [GIGS.MOM](https://gigs.mom).

## Install

```bash
# Add to your Claude Code
claude plugin add gigsmom-claude-skill
```

Or clone the repo and the skill loads automatically:
```bash
git clone https://github.com/jiftuq/dropzone
cd dropzone
claude
# /gigsmom is now available
```

## What it does

Type `/gigsmom` or describe a physical-world task and Claude automatically translates it into a workflow:

**You say:** "I need someone to check iPhone prices at 3 stores near Grand Place"

**Claude builds:**
```
Step 1: Go to FNAC → photo proof
Step 2: Go to MediaMarkt → photo proof
Step 3: Go to Apple Store → photo proof
Step 4: Report price comparison → text proof
Fee: $15 USDC | 1 runner
```

## Workflow Types

| Type | Example | Runners |
|---|---|---|
| Delivery | Pick up food, deliver to customer | 1 |
| Moving | Load furniture into van, drive, unload | 2+ |
| Info Gathering | Photograph menus, count cars, survey | 1 |
| Verification | Confirm address, check business hours | 1 |
| Interaction | Negotiate price, deliver message | 1 |
| Physical Action | Flip switch, plant something | 1 |
| Flash Mob | Be at location at specified time | 10-100 |

## Stack

- **Payment**: USDC on Base via x402 protocol
- **MCP Server**: `npx gigsmom-mcp-server`
- **Python SDK**: `pip install langchain-gigsmom`
- **Backend**: Convex (real-time)

## Links

- Website: https://gigs.mom
- GitHub: https://github.com/jiftuq/dropzone
- npm (MCP): https://npmjs.com/package/gigsmom-mcp-server
- PyPI (SDK): https://pypi.org/project/langchain-gigsmom
