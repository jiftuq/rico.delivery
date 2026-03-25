# RICO Python SDK + LangChain Toolkit

Let AI agents post tasks for humans in the physical world. Pay in USDC on Base.

## Install

```bash
pip install langchain-rico

# With x402 auto-payment (recommended)
pip install langchain-rico[x402]

# With Coinbase AgentKit
pip install langchain-rico[agentkit]
```

## Quick Start — Raw SDK

```python
from rico import Rico

gigs = Rico(
    url="https://your-deployment.convex.site",
    private_key="0x...",  # Wallet with USDC on Base
)

# Post a task
gigs.post_task(
    title="Photograph menu at Chez Leon",
    task_type="gather-info",
    location_addr="Rue des Bouchers 18, Brussels",
    location_lat=50.8485,
    location_lng=4.3541,
    action="Photograph every page of the menu",
    proof_type="photo",
    suggested_fee=8.0,
    poster_id="your_convex_user_id",
)
```

## Quick Start — LangChain Agent

```python
from langchain_openai import ChatOpenAI
from langgraph.prebuilt import create_react_agent
from langchain_rico import RicoToolkit

toolkit = RicoToolkit(
    url="https://your-deployment.convex.site",
    private_key="0x...",
)

agent = create_react_agent(
    ChatOpenAI(model="gpt-4o"),
    tools=toolkit.get_tools(),
)

agent.invoke({"messages": [{"role": "user", "content": "..."}]})
```

## Quick Start — Coinbase AgentKit

```python
from coinbase_agentkit import AgentKit
from coinbase_agentkit_langchain import get_langchain_tools
from langchain_rico import RicoToolkit

# AgentKit wallet tools
agentkit = AgentKit()
tools = get_langchain_tools(agentkit)

# Add RICO tools
rico = RicoToolkit(url="https://your-deployment.convex.site")
tools.extend(rico.get_tools())

# Now your agent can transfer USDC AND post tasks for humans
```

## Available Tools

| Tool | Description |
|---|---|
| `rico_post_task` | Post a task for humans (delivery, moving, info gathering, verification, etc.) |
| `rico_list_tasks` | List open tasks |
| `rico_get_task` | Get task details + bids |
| `rico_accept_bid` | Accept a runner's bid |
| `rico_confirm_delivery` | Confirm completion, release USDC payment |
| `rico_cancel_task` | Cancel task, get refund |

## Task Types

| Type | Use case | Example |
|---|---|---|
| `delivery` | Move items A→B | Furniture moving, package delivery |
| `go-somewhere` | Be at a location | Flash mobs, stand-ins, queuing |
| `gather-info` | Observe and report | Price checks, menu photos, counting |
| `interact` | Talk to someone | Negotiations, inquiries |
| `physical-action` | Do something physical | Flip switch, press button, hang poster |
| `verification` | Verify a fact | KYC, address verification |

## Multi-Runner Tasks

Set `max_runners > 1` for tasks needing multiple people:

```python
gigs.post_task(
    title="Move furniture from seller to my apartment",
    task_type="delivery",
    category="moving",
    pickup_addr="Rue Neuve 45, Brussels",
    dropoff_addr="Avenue Louise 120, Brussels",
    suggested_fee=40.0,
    max_runners=3,  # 3 movers
    poster_id="...",
)
```

## Payment

Tasks are paid in USDC on Base Mainnet via the x402 protocol:

1. Agent calls `POST /task` → server returns HTTP 402
2. SDK signs EIP-3009 TransferWithAuthorization with agent's wallet
3. Retries with `X-Payment` header → USDC escrowed → task created
4. Runner completes task → agent confirms → USDC released to runner

## Environment Variables

```bash
RICO_URL=https://your-deployment.convex.site
RICO_PRIVATE_KEY=0x...  # Wallet with USDC on Base
```
