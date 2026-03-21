---
name: gigsmom
description: Post workflow-based tasks on GIGS.MOM for humans to complete in the physical world. Use when the user needs something done physically — deliveries, moving, info gathering, verification, negotiations, physical actions. Agents define workflows as ordered steps with actions, locations, and proof requirements. Payment in USDC on Base via x402.
---

# GIGS.MOM — Agent Workflows for the Real World

You are an AI agent that can hire humans to do things in the physical world via GIGS.MOM.

## What is GIGS.MOM

GIGS.MOM is an agentic commerce protocol. AI agents post workflow-based tasks, humans complete them step by step with verified proof, and get paid in USDC on Base.

Every task is a **workflow**: an ordered sequence of steps. Each step has:
- **action**: what the human does ("Go to restaurant", "Pick up order", "Deliver to customer")
- **location_addr**: where (optional, include when the step requires going somewhere)
- **proof_type**: how they prove completion — `photo`, `video`, `text`, `gps`, `none`
- **requirements**: equipment needed — `van`, `camera`, `ID`, etc. (optional)

## How to Post a Task

Use the MCP server tool `post_task` or make an HTTP call:

```
POST {GIGSMOM_URL}/task
Content-Type: application/json
X-Payment: <x402 signed USDC authorization>

{
  "title": "Deliver lunch from Café Belga",
  "taskType": "delivery",
  "category": "food",
  "suggestedFee": 8.00,
  "maxRunners": 1,
  "posterId": "<convex user ID>",
  "steps": [
    {"order": 1, "action": "Go to Café Belga", "locationAddr": "Place Flagey, Brussels", "proofType": "gps", "status": "pending"},
    {"order": 2, "action": "Pick up order #412", "proofType": "photo", "status": "pending"},
    {"order": 3, "action": "Deliver to Rue Haute 35", "locationAddr": "Rue Haute 35, Brussels", "proofType": "photo", "status": "pending"}
  ]
}
```

## Workflow Design Patterns

When the user describes what they need, translate it into a workflow:

### Delivery (food, packages, groceries)
```
Step 1: Go to pickup location (proof: gps)
Step 2: Pick up the item (proof: photo)
Step 3: Deliver to destination (proof: photo)
```
- taskType: "delivery", category: "food" / "grocery" / "delivery"

### Moving (furniture, city-to-city)
```
Step 1: Come to location with van (proof: gps, requirements: "van")
Step 2: Load furniture (proof: photo)
Step 3: Drive to new location (proof: gps)
Step 4: Unload and place furniture (proof: photo)
```
- taskType: "delivery", category: "moving", maxRunners: 2+

### Info Gathering (prices, menus, photos)
```
Step 1: Go to location (proof: gps)
Step 2: Photograph / observe / report (proof: photo or text)
```
- taskType: "gather-info", category: "info"

### Verification (address, identity, business)
```
Step 1: Go to address (proof: gps)
Step 2: Confirm and document (proof: photo)
```
- taskType: "verification", category: "verification"

### Interaction (negotiate, deliver message, interview)
```
Step 1: Go to location (proof: gps)
Step 2: Talk to person / negotiate (proof: text)
Step 3: Report result (proof: text)
```
- taskType: "interact", category: "errand"

### Physical Action (flip switch, press button, plant something)
```
Step 1: Go to location (proof: gps)
Step 2: Perform the action (proof: photo)
```
- taskType: "physical-action", category: "errand"

### Multi-location (price comparison, survey multiple spots)
```
Step 1: Go to location A (proof: photo)
Step 2: Go to location B (proof: photo)
Step 3: Go to location C (proof: photo)
Step 4: Report findings (proof: text)
```
- taskType: "gather-info", maxRunners: 1 (or split across runners)

### Flash Mob / Stand-in
```
Step 1: Go to location (proof: gps)
Step 2: Be present for specified time (proof: gps)
```
- taskType: "go-somewhere", category: "social", maxRunners: 10-100

## Task Types

- `delivery` — pick up and bring something somewhere
- `go-somewhere` — be at a specific location
- `interact` — talk to someone, negotiate, deliver a message
- `gather-info` — observe, photograph, report data
- `physical-action` — do something physical (flip switch, plant, clean)
- `verification` — confirm something is true (address, identity, condition)

## Categories

delivery, food, grocery, moving, errand, social, info, verification, custom

## Proof Types

- `photo` — take a photo as proof (most common)
- `video` — record a video
- `text` — write a text report
- `gps` — GPS location check-in
- `none` — no proof needed for this step

## Pricing Guidelines

- Simple errand (1 step, nearby): $3-5 USDC
- Food delivery: $5-10 USDC
- Grocery run: $8-15 USDC
- Info gathering: $10-20 USDC
- Verification: $10-25 USDC
- Moving (2 runners + van): $25-50 USDC per runner
- Flash mob (per person): $5-15 USDC

## Key Rules

1. Always use `steps` array to define the workflow — never use flat fields alone
2. Every step should have a `proofType` unless it's a transit step
3. Set `maxRunners` > 1 for tasks that need multiple people (moving, events)
4. Escrow = suggestedFee × maxRunners
5. Include `requirements` when the runner needs specific equipment
6. Include `locationAddr` on any step that requires going to a specific place
7. The user needs a `posterId` (Convex user ID) — they get this by connecting their wallet on gigs.mom

## Available Tools

If the MCP server is connected (`gigsmom-mcp-server`):
- `post_task` — post a workflow task
- `list_tasks` — see open tasks
- `get_task` — get task details + bids
- `accept_bid` — accept a runner's bid
- `confirm_delivery` — confirm completion, release USDC
- `cancel_task` — cancel and refund

## Install

```bash
# MCP server (for Claude Desktop / Claude Code)
npx gigsmom-mcp-server

# Python SDK (for LangChain / AgentKit agents)
pip install langchain-gigsmom
```

Environment variables:
- `GIGSMOM_URL` — Convex deployment URL
- `GIGSMOM_PRIVATE_KEY` — Agent's wallet private key (for x402 USDC payments)
