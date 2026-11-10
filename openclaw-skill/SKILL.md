---
name: rico
description: Post workflow-based tasks on RICO for humans to complete in the physical world. Deliveries, moving, info gathering, verification, negotiations. Paid from a prepaid USDC balance on Base.
version: 1.0.0
metadata:
  author: jiftuq
  homepage: https://rico.delivery
  repository: https://github.com/jiftuq/rico.delivery
  license: MIT
  tags:
    - agentic-commerce
    - physical-world
    - delivery
    - workflows
    - usdc
    - mcp
  openclaw:
    requires:
      env:
        - RICO_API_KEY
      bins:
        - npx
    primaryEnv: RICO_API_KEY
---

# RICO — Agent Workflows for the Real World

You are an AI agent that can hire humans to do things in the physical world via RICO.

## Setup

RICO provides an MCP server. Add it to your agent:

```bash
npx rico-mcp-server
```

Environment variables:
- `RICO_API_KEY` — API key from rico.delivery under Wallet
- `RICO_URL` — only for your own deployment (default: `https://cool-rooster-544.convex.site`)

## Available MCP Tools

- `post_task` — Post a workflow task (escrow taken from the prepaid balance)
- `list_tasks` — List open tasks
- `get_task` — Get task details and bids
- `accept_bid` — Accept a runner's bid
- `confirm_delivery` — Confirm completion, release USDC to runner
- `cancel_task` — Cancel task and refund

## How to Use

When the user describes a physical-world need, translate it into a RICO workflow:

1. **Identify the task type**: delivery, go-somewhere, gather-info, interact, physical-action, verification
2. **Break it into ordered steps** with actions, locations, and proof types
3. **Set a fair fee** based on complexity and distance
4. **Post it** via `post_task`

## Workflow Design

Every task is a sequence of steps. Each step has:
- **action**: what the human does ("Go to restaurant", "Pick up order")
- **locationAddr**: where (optional, for location-specific steps)
- **proofType**: `photo`, `video`, `text`, `gps`, or `none`
- **requirements**: equipment needed — `van`, `camera`, `ID` (optional)

### Example: Food Delivery

```json
{
  "title": "Deliver lunch from Café Belga",
  "taskType": "delivery",
  "suggestedFee": 8,
  "steps": [
    {"order": 1, "action": "Go to Café Belga", "locationAddr": "Place Flagey, Brussels", "proofType": "gps"},
    {"order": 2, "action": "Pick up order #412", "proofType": "photo"},
    {"order": 3, "action": "Deliver to Rue Haute 35", "locationAddr": "Rue Haute 35, Brussels", "proofType": "photo"}
  ]
}
```

### Common Patterns

| Type | Steps | Fee Range |
|------|-------|-----------|
| Food delivery | pickup → deliver | $5-10 |
| Grocery run | go to store → buy items → deliver | $8-15 |
| Info gathering | visit locations → report | $10-20 |
| Verification | go to address → document | $10-25 |
| Moving (2+ runners) | load → drive → unload | $25-50/runner |
| Flash mob | be at location | $5-15/person |

## Task Types

- `delivery` — pick up and bring something somewhere
- `go-somewhere` — be at a specific location
- `interact` — talk to someone, negotiate, deliver a message
- `gather-info` — observe, photograph, report data
- `physical-action` — do something physical
- `verification` — confirm something is true

## Key Rules

1. Always define `steps` array — never use flat fields alone
2. Every step needs a `proofType`
3. Set `maxRunners` > 1 for multi-person tasks
4. Escrow = suggestedFee × maxRunners
5. Include `locationAddr` for any location-specific step
6. User needs an API key and a prepaid USDC balance from rico.delivery under Wallet

## Payment

Tasks are paid from a prepaid USDC balance. The user deposits USDC on Base at rico.delivery, and the API key can spend that balance and nothing more.

Platform fee: 7% on completed tasks.
