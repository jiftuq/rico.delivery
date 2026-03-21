"""
Example: Coinbase AgentKit agent with GIGS.MOM workflow tools.

This agent has a wallet on Base (USDC) AND can post workflow-based tasks
for humans in the physical world via GIGS.MOM.

Every task is a workflow: an ordered sequence of steps with actions,
locations, proof requirements, and equipment needs.

Requirements:
    pip install coinbase-agentkit coinbase-agentkit-langchain langchain-openai
    pip install langchain-gigsmom[agentkit]

Environment:
    OPENAI_API_KEY=sk-...
    GIGSMOM_URL=https://your-deployment.convex.site
    CDP_API_KEY_NAME=...
    CDP_API_KEY_PRIVATE_KEY=...
"""

import os
from langchain_openai import ChatOpenAI
from langgraph.prebuilt import create_react_agent

# ── 1. Coinbase AgentKit (wallet, transfers, swaps) ──
from coinbase_agentkit import AgentKit, AgentKitConfig, CdpWalletConfig
from coinbase_agentkit_langchain import get_langchain_tools

agentkit = AgentKit(AgentKitConfig(
    wallet_config=CdpWalletConfig(network_id="base-mainnet"),
))
wallet_tools = get_langchain_tools(agentkit)

# ── 2. GIGS.MOM tools (post workflow tasks for humans) ──
from langchain_gigsmom import GigsMomToolkit

gigsmom = GigsMomToolkit(
    url=os.environ.get("GIGSMOM_URL", "https://your-deployment.convex.site"),
)
gigsmom_tools = gigsmom.get_tools()

# ── 3. Combine all tools ──
all_tools = wallet_tools + gigsmom_tools

# ── 4. Create the agent ──
llm = ChatOpenAI(model="gpt-4o")

agent = create_react_agent(
    llm,
    tools=all_tools,
    prompt=(
        "You are an AI agent with a crypto wallet on Base and the ability to "
        "post workflow-based tasks for humans in the physical world via GIGS.MOM.\n\n"
        "GIGS.MOM is your physical execution layer. When you need something done "
        "in the real world, you define a workflow: an ordered sequence of steps.\n\n"
        "Each step has:\n"
        "- action: what the human does (e.g. 'Go to restaurant', 'Pick up order')\n"
        "- location_addr: where (optional)\n"
        "- proof_type: how they prove it — photo, video, text, gps, none\n"
        "- requirements: equipment needed — van, camera, ID (optional)\n\n"
        "You can:\n"
        "- Check your USDC balance and make transfers\n"
        "- Post workflow tasks: deliveries, moving, gathering info, verification, "
        "negotiations, physical actions\n"
        "- Monitor task status and confirm completion\n"
        "- Pay runners in USDC automatically via x402\n\n"
        "Always use 'steps' to define the workflow. Example:\n"
        '  steps=[{action: "Go to store", proof_type: "gps"},\n'
        '         {action: "Buy items on list", proof_type: "photo"},\n'
        '         {action: "Deliver to customer", location_addr: "...", proof_type: "photo"}]\n\n'
        "For multi-runner tasks (moving, flash mobs), set max_runners > 1."
    ),
)


# ── 5. Run ──
if __name__ == "__main__":
    examples = [
        # Workflow: gather restaurant data (2 steps)
        "I need someone to go to Chez Leon on Rue des Bouchers in Brussels "
        "and photograph their full menu including prices. My poster ID is abc123.",

        # Workflow: moving furniture (4 steps, 2 runners)
        "I need 2 movers with a van to pick up my furniture at Avenue Louise 120 Brussels, "
        "load it, drive to Rue Neuve 45, and unload it. My poster ID is abc123.",

        # Workflow: price comparison (3 locations, 1 runner)
        "Check the price of iPhone 16 at 3 stores near Grand Place Brussels: "
        "FNAC, MediaMarkt, and Apple Store. Take a photo of each price tag. "
        "My poster ID is abc123.",
    ]

    result = agent.invoke({
        "messages": [{"role": "user", "content": examples[0]}]
    })

    for msg in result["messages"]:
        print(f"\n{msg.type}: {msg.content}")
